import { Inject, Injectable } from '@nestjs/common';
import {
  TransactionalContext,
  UNIT_OF_WORK,
  type UnitOfWorkPort,
} from '../ports/persistence.ports';
import { Money, MoneyProps } from '../../domain/value-objects/money.vo';
import { Wallet } from '../../domain/entities/wallet.entity';
import {
  WagerTransaction,
  WagerTransactionKind,
} from '../../domain/entities/wager-transaction.entity';
import {
  LedgerDirection,
  WalletLedgerEntry,
} from '../../domain/entities/wallet-ledger-entry.entity';
import { OutboxMessage } from '../../domain/entities/outbox-message.entity';
import { WalletBalanceChanged } from '../../domain/events/integration.events';
import { computeCanonicalPayloadHash } from '../../domain/value-objects/payload-hash.util';
import {
  isPostgresUniqueViolation,
  ResourceConflictError,
  uuidv7,
} from './app-utils';

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
  correlationId?: string;
}

export interface CreateWalletResult {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

@Injectable()
export class CreateWalletUseCase {
  constructor(
    @Inject(UNIT_OF_WORK)
    private readonly uow: UnitOfWorkPort,
  ) {}

  async execute(cmd: CreateWalletCommand): Promise<CreateWalletResult> {
    const initialMoney = Money.from(cmd.initialBalance);
    const now = new Date();
    const walletId = uuidv7(now.getTime());
    const correlationId = cmd.correlationId ?? uuidv7();

    try {
      return await this.uow.runInTransaction(async (ctx: TransactionalContext) => {
        const existing = await ctx.wallets.findByPlayerAndCurrency(
          cmd.playerId,
          initialMoney.currency,
        );
        if (existing) {
          throw new ResourceConflictError(
            `Wallet already exists for player '${cmd.playerId}' and currency '${initialMoney.currency}'`,
            'WALLET_ALREADY_EXISTS',
          );
        }

        const wallet = Wallet.open({
          id: walletId,
          playerId: cmd.playerId,
          initialBalance: initialMoney,
          now,
        });

        await ctx.wallets.save(wallet);

        // Se o saldo inicial > 0, cria transação interna OPENING + entrada CREDIT no ledger (Seção 9)
        if (initialMoney.isPositive()) {
          const openingTxId = uuidv7(now.getTime());
          const externalTxId = `opening:${wallet.id}`;
          const idempotencyKey = `internal:${externalTxId}`;

          const payloadHash = computeCanonicalPayloadHash({
            providerId: 'internal-system',
            externalTransactionId: externalTxId,
            playerId: wallet.playerId,
            walletId: wallet.id,
            roundId: 'opening-round',
            gameId: 'wallet-opening',
            kind: WagerTransactionKind.Opening,
            money: initialMoney.toJSON(),
          });

          const openingTx = WagerTransaction.create({
            id: openingTxId,
            providerId: 'internal-system',
            externalTransactionId: externalTxId,
            idempotencyKey,
            payloadHash,
            walletId: wallet.id,
            playerId: wallet.playerId,
            roundId: 'opening-round',
            gameId: 'wallet-opening',
            kind: WagerTransactionKind.Opening,
            money: initialMoney,
            createdAt: now,
          });

          openingTx.markProcessed(undefined, now, initialMoney);
          await ctx.transactions.save(openingTx);

          const ledgerEntry = WalletLedgerEntry.create({
            id: uuidv7(now.getTime()),
            walletId: wallet.id,
            transactionId: openingTx.id,
            direction: LedgerDirection.Credit,
            money: initialMoney,
            balanceBefore: Money.zero(initialMoney.currency),
            balanceAfter: initialMoney,
            createdAt: now,
          });

          await ctx.ledger.save(ledgerEntry);

          const balanceEvent = WalletBalanceChanged.from(wallet, ledgerEntry, {
            eventId: uuidv7(now.getTime()),
            correlationId,
            causationId: openingTx.id,
            occurredAt: now,
          });

          await ctx.outbox.save(OutboxMessage.enqueue(balanceEvent));
        }

        return {
          id: wallet.id,
          playerId: wallet.playerId,
          balance: wallet.balance.toJSON(),
          version: wallet.version,
        };
      });
    } catch (err) {
      if (isPostgresUniqueViolation(err)) {
        throw new ResourceConflictError(
          `Wallet already exists for player '${cmd.playerId}' and currency '${initialMoney.currency}'`,
          'WALLET_ALREADY_EXISTS',
        );
      }
      throw err;
    }
  }
}