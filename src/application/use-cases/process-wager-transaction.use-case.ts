import { Inject, Injectable } from '@nestjs/common';
import {
  TransactionalContext,
  UNIT_OF_WORK,
  type UnitOfWorkPort,
} from '../ports/persistence.ports';
import { Money, MoneyProps } from '../../domain/value-objects/money.vo';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/entities/wager-transaction.entity';
import { Wallet } from '../../domain/entities/wallet.entity';
import { LedgerDirection } from '../../domain/entities/wallet-ledger-entry.entity';
import { InboxMessage } from '../../domain/entities/inbox-message.entity';
import { OutboxMessage } from '../../domain/entities/outbox-message.entity';
import {
  IntegrationEvent,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../../domain/events/integration.events';
import {
  DomainError,
  FailureCode,
  IdempotencyConflictError,
  InsufficientFundsError,
} from '../../domain/errors/domain.errors';
import { computeCanonicalPayloadHash } from '../../domain/value-objects/payload-hash.util';
import {
  isPostgresUniqueViolation,
  ResourceNotFoundError,
  uuidv7,
} from './app-utils';

export interface SubmitWagerTransactionCommand {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  correlationId?: string;
  /** Preenchido apenas quando invocado pelo consumidor SQS */
  inboxContext?: {
    consumerName: string;
    messageId: string;
  };
}

export interface ProcessWagerTransactionResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps;
  idempotentReplay: boolean;
  failureCode?: FailureCode;
}

@Injectable()
export class ProcessWagerTransactionUseCase {
  constructor(
    @Inject(UNIT_OF_WORK)
    private readonly uow: UnitOfWorkPort,
  ) {}

  async execute(cmd: SubmitWagerTransactionCommand): Promise<ProcessWagerTransactionResult> {
    if (cmd.kind === WagerTransactionKind.Opening) {
      throw new DomainError(
        'OPENING transaction kind is strictly internal and cannot be submitted externally',
        'FORBIDDEN_TRANSACTION_KIND',
      );
    }

    const money = Money.from(cmd.money);
    const payloadHash = computeCanonicalPayloadHash({
      providerId: cmd.providerId,
      externalTransactionId: cmd.externalTransactionId,
      playerId: cmd.playerId,
      walletId: cmd.walletId,
      roundId: cmd.roundId,
      gameId: cmd.gameId,
      kind: cmd.kind,
      money: money.toJSON(),
      referenceExternalTransactionId: cmd.referenceExternalTransactionId,
    });

    const correlationId = cmd.correlationId ?? uuidv7();

    try {
      return await this.uow.runInTransaction(async (ctx) => {
        // 1. Se veio da fila SQS, verifica deduplicação da Inbox
        let inboxMsg: InboxMessage | null = null;
        if (cmd.inboxContext) {
          inboxMsg = await ctx.inbox.findByConsumerAndMessageId(
            cmd.inboxContext.consumerName,
            cmd.inboxContext.messageId,
          );
          if (inboxMsg && inboxMsg.isProcessed()) {
            const existingByKey = await ctx.transactions.findByIdempotencyKey(cmd.idempotencyKey);
            if (existingByKey) {
              const wallet = await ctx.wallets.findById(existingByKey.walletId);
              return this.buildReplayResponse(existingByKey, wallet);
            }
          }
          if (!inboxMsg) {
            inboxMsg = InboxMessage.receive({
              consumerName: cmd.inboxContext.consumerName,
              messageId: cmd.inboxContext.messageId,
              payloadHash,
            });
          }
        }

        // 2. Adquire Pessimistic Write Lock (SELECT ... FOR UPDATE) na Wallet ANTES de tudo.
        // Isso serializa requisições concorrentes para a mesma carteira (inclusive 50 replays simultâneos!)
        const wallet = await ctx.wallets.findByIdForUpdate(cmd.walletId);
        if (!wallet) {
          throw new ResourceNotFoundError('Wallet', cmd.walletId);
        }

        // 3. Verifica Idempotência (por Idempotency-Key ou por providerId + externalTransactionId)
        const existingTx =
          (await ctx.transactions.findByIdempotencyKey(cmd.idempotencyKey)) ??
          (await ctx.transactions.findByProviderAndExternalId(
            cmd.providerId,
            cmd.externalTransactionId,
          ));

        if (existingTx) {
          if (
            existingTx.idempotencyKey !== cmd.idempotencyKey ||
            !existingTx.matchesPayload(payloadHash)
          ) {
            throw new IdempotencyConflictError(cmd.idempotencyKey);
          }

          if (inboxMsg && !inboxMsg.isProcessed()) {
            inboxMsg.markProcessed(new Date());
            await ctx.inbox.save(inboxMsg);
          }

          return this.buildReplayResponse(existingTx, wallet);
        }

        // 4. Cria a nova WagerTransaction em estado PENDING
        const now = new Date();
        const tx = WagerTransaction.create({
          id: uuidv7(now.getTime()),
          providerId: cmd.providerId,
          externalTransactionId: cmd.externalTransactionId,
          idempotencyKey: cmd.idempotencyKey,
          payloadHash,
          walletId: cmd.walletId,
          playerId: cmd.playerId,
          roundId: cmd.roundId,
          gameId: cmd.gameId,
          kind: cmd.kind,
          money,
          referenceExternalTransactionId: cmd.referenceExternalTransactionId,
          createdAt: now,
        });

        // 5. Aplica regras de negócio na Wallet e resolve referências
        await this.applyTransactionRules(ctx, wallet, tx, correlationId, now);

        // 6. Se veio pela fila SQS, marca a Inbox como processada na mesma transação SQL
        if (inboxMsg) {
          inboxMsg.markProcessed(now);
          await ctx.inbox.save(inboxMsg);
        }

        return {
          transactionId: tx.id,
          status: tx.status,
          balance: (tx.observedBalance ?? wallet.balance).toJSON(),
          idempotentReplay: false,
          ...(tx.failureCode ? { failureCode: tx.failureCode } : {}),
        };
      });
    } catch (err) {
      // Fallback caso duas transações para carteiras distintas disputem a mesma idempotency_key
      if (isPostgresUniqueViolation(err)) {
        return this.handleConcurrentUniqueViolation(cmd, payloadHash);
      }
      throw err;
    }
  }

  /**
   * Método público reutilizado também pelo Worker de PENDING_REFERENCE (Passo 9)
   */
  async applyTransactionRules(
    ctx: TransactionalContext,
    wallet: Wallet,
    tx: WagerTransaction,
    correlationId: string,
    now: Date,
  ): Promise<void> {
    const outboxEvents: IntegrationEvent<unknown>[] = [];

    // Validação básica de titularidade e moeda da carteira
    if (wallet.playerId !== tx.playerId) {
      await this.rejectAndEnqueue(
        ctx,
        wallet,
        tx,
        FailureCode.WALLET_PLAYER_MISMATCH,
        correlationId,
        now,
      );
      return;
    }

    if (wallet.currency !== tx.money.currency) {
      await this.rejectAndEnqueue(
        ctx,
        wallet,
        tx,
        FailureCode.CURRENCY_MISMATCH,
        correlationId,
        now,
      );
      return;
    }

    // Resolução de transação de referência (para REFUND, ROLLBACK ou WIN com referência opcional)
    let referenceTx: WagerTransaction | null = null;
    if (tx.referenceExternalTransactionId) {
      referenceTx = await ctx.transactions.findByProviderAndExternalId(
        tx.providerId,
        tx.referenceExternalTransactionId,
      );

      if (!referenceTx) {
        if (tx.requiresReference()) {
          // Referência ainda não chegou -> salvar como PENDING_REFERENCE (Seção 7, Regra 8)
          tx.markPendingReference(new Date(now.getTime() + 1000));
          await ctx.transactions.save(tx);

          const pendingEvent = WagerTransactionPendingReference.from(tx, {
            eventId: uuidv7(now.getTime()),
            correlationId,
            causationId: tx.id,
            occurredAt: now,
          });
          await ctx.outbox.save(OutboxMessage.enqueue(pendingEvent));
          return;
        }
      } else {
        // Validações da referência (Seção 7, Regras 2, 3, 4 e 5)
        const refError = await this.validateReferenceTransaction(ctx, tx, referenceTx);
        if (refError) {
          await this.rejectAndEnqueue(ctx, wallet, tx, refError, correlationId, now);
          return;
        }
      }
    }

    // Execução financeira na Wallet conforme o Kind
    try {
      let ledgerEntry = null;

      if (!tx.affectsBalance()) {
        // LOSS não altera saldo nem gera ledger
        tx.markProcessed(referenceTx?.id, now, wallet.balance);
      } else {
        const direction = tx.ledgerDirectionFor(referenceTx ?? undefined);

        if (direction === LedgerDirection.Debit) {
          const failureCode =
            tx.kind === WagerTransactionKind.Rollback
              ? FailureCode.REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE
              : FailureCode.INSUFFICIENT_FUNDS;

          ledgerEntry = wallet.debit({
            ledgerEntryId: uuidv7(now.getTime()),
            transactionId: tx.id,
            amount: tx.money,
            at: now,
            insufficientFundsCode: failureCode,
          });
        } else {
          ledgerEntry = wallet.credit({
            ledgerEntryId: uuidv7(now.getTime()),
            transactionId: tx.id,
            amount: tx.money,
            at: now,
          });
        }

        tx.markProcessed(referenceTx?.id, now, wallet.balance);
        await ctx.wallets.save(wallet);
      }

      // Importante: Salvar a transação antes do ledger por conta da FK no banco
      await ctx.transactions.save(tx);

      if (ledgerEntry) {
        await ctx.ledger.save(ledgerEntry);
        outboxEvents.push(
          WalletBalanceChanged.from(wallet, ledgerEntry, {
            eventId: uuidv7(now.getTime()),
            correlationId,
            causationId: tx.id,
            occurredAt: now,
          }),
        );
      }

      outboxEvents.push(
        WagerTransactionProcessed.from(tx, wallet.balance.toJSON(), {
          eventId: uuidv7(now.getTime()),
          correlationId,
          causationId: tx.id,
          occurredAt: now,
        }),
      );

      await ctx.outbox.saveMany(outboxEvents.map(OutboxMessage.enqueue));
    } catch (err) {
      if (err instanceof InsufficientFundsError) {
        await this.rejectAndEnqueue(ctx, wallet, tx, err.failureCode, correlationId, now);
        return;
      }
      throw err;
    }
  }

  private async validateReferenceTransaction(
    ctx: TransactionalContext,
    tx: WagerTransaction,
    ref: WagerTransaction,
  ): Promise<FailureCode | null> {
    // Regra 2: mesmo provider, player, wallet, moeda e rodada
    if (
      ref.providerId !== tx.providerId ||
      ref.playerId !== tx.playerId ||
      ref.walletId !== tx.walletId ||
      ref.money.currency !== tx.money.currency ||
      ref.roundId !== tx.roundId
    ) {
      return FailureCode.REFERENCE_MISMATCH;
    }

    // Só é possível reverter/referenciar uma transação PROCESSED
    if (ref.status !== WagerTransactionStatus.Processed) {
      return FailureCode.INVALID_REFERENCE_STATUS;
    }

    if (tx.kind === WagerTransactionKind.Win) {
      if (ref.kind !== WagerTransactionKind.Bet) {
        return FailureCode.INVALID_REFERENCE_KIND;
      }
      return null;
    }

    // Regras específicas para REFUND e ROLLBACK
    if (tx.kind === WagerTransactionKind.Refund && ref.kind !== WagerTransactionKind.Bet) {
      return FailureCode.INVALID_REFERENCE_KIND;
    }

    if (
      tx.kind === WagerTransactionKind.Rollback &&
      ref.kind !== WagerTransactionKind.Bet &&
      ref.kind !== WagerTransactionKind.Win &&
      ref.kind !== WagerTransactionKind.Refund
    ) {
      return FailureCode.INVALID_REFERENCE_KIND;
    }

    // Regra 5: O valor de REFUND/ROLLBACK deve ser igual ao valor da referência
    if (!tx.money.equals(ref.money)) {
      return FailureCode.REFERENCE_AMOUNT_MISMATCH;
    }

    // Regra 4: Uma referência não pode ser revertida duas vezes
    const alreadyReversedRefund = await ctx.transactions.existsProcessedReversalFor(
      ref.id,
      'REFUND',
    );
    const alreadyReversedRollback = await ctx.transactions.existsProcessedReversalFor(
      ref.id,
      'ROLLBACK',
    );

    if (alreadyReversedRefund || alreadyReversedRollback) {
      return FailureCode.REFERENCE_ALREADY_REVERSED;
    }

    return null;
  }

  private async rejectAndEnqueue(
    ctx: TransactionalContext,
    wallet: Wallet,
    tx: WagerTransaction,
    code: FailureCode,
    correlationId: string,
    now: Date,
  ): Promise<void> {
    tx.reject(code, now, wallet.balance);
    await ctx.transactions.save(tx);

    const rejectedEvent = WagerTransactionRejected.from(tx, {
      eventId: uuidv7(now.getTime()),
      correlationId,
      causationId: tx.id,
      occurredAt: now,
    });

    await ctx.outbox.save(OutboxMessage.enqueue(rejectedEvent));
  }

  private buildReplayResponse(
    existingTx: WagerTransaction,
    wallet: Wallet | null,
  ): ProcessWagerTransactionResult {
    const balance =
      existingTx.observedBalance ??
      wallet?.balance ??
      Money.zero(existingTx.money.currency);

    return {
      transactionId: existingTx.id,
      status: existingTx.status,
      balance: balance.toJSON(),
      idempotentReplay: true,
      ...(existingTx.failureCode ? { failureCode: existingTx.failureCode } : {}),
    };
  }

  private async handleConcurrentUniqueViolation(
    cmd: SubmitWagerTransactionCommand,
    payloadHash: string,
  ): Promise<ProcessWagerTransactionResult> {
    const existing =
      (await this.uow.repositories.transactions.findByIdempotencyKey(cmd.idempotencyKey)) ??
      (await this.uow.repositories.transactions.findByProviderAndExternalId(
        cmd.providerId,
        cmd.externalTransactionId,
      ));

    if (!existing) {
      throw new IdempotencyConflictError(cmd.idempotencyKey);
    }

    if (
      existing.idempotencyKey !== cmd.idempotencyKey ||
      !existing.matchesPayload(payloadHash)
    ) {
      throw new IdempotencyConflictError(cmd.idempotencyKey);
    }

    const wallet = await this.uow.repositories.wallets.findById(existing.walletId);
    return this.buildReplayResponse(existing, wallet);
  }
}