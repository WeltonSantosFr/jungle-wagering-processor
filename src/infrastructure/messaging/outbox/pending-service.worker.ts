import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { UNIT_OF_WORK, type UnitOfWorkPort } from '../../../application/ports/persistence.ports';
import { ProcessWagerTransactionUseCase } from '../../../application/use-cases/process-wager-transaction.use-case';
import { FailureCode } from '../../../domain/errors/domain.errors';
import { WagerTransactionRejected } from '../../../domain/events/integration.events';
import { OutboxMessage } from '../../../domain/entities/outbox-message.entity';
import { uuidv7 } from '../../../application/use-cases/app-utils';

@Injectable()
export class PendingReferenceWorker {
  private readonly logger = new Logger(PendingReferenceWorker.name);
  private isProcessing = false;
  public static readonly MAX_RETRIES = 5;

  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWorkPort,
    private readonly processWagerUseCase: ProcessWagerTransactionUseCase,
    private readonly config: ConfigService,
  ) {}

  @Cron('*/1 * * * * *') // Executa a cada 1 segundo
  async handleCron(): Promise<void> {
    if (this.config.get<string>('DISABLE_BACKGROUND_WORKERS') === 'true') {
      return;
    }
    if (this.isProcessing) return;

    this.isProcessing = true;
    try {
      await this.processPendingReferencesBatch(25);
    } catch (err) {
      this.logger.error(`Error in PendingReferenceWorker loop: ${(err as Error).message}`);
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Método público também invocável diretamente nos testes de integração/concorrência
   */
  async processPendingReferencesBatch(batchSize = 25, maxRetries = PendingReferenceWorker.MAX_RETRIES): Promise<number> {
    let resolvedOrRejectedCount = 0;

    await this.uow.runInTransaction(async (ctx) => {
      const now = new Date();
      const pendingTxs = await ctx.transactions.claimDuePendingReferences(now, batchSize);

      for (const tx of pendingTxs) {
        if (!tx.referenceExternalTransactionId) {
          continue;
        }

        // Adquire lock pessimista na Wallet antes de tentar aplicar ou rejeitar a transação
        const wallet = await ctx.wallets.findByIdForUpdate(tx.walletId);
        if (!wallet) {
          continue;
        }

        const referenceTx = await ctx.transactions.findByProviderAndExternalId(
          tx.providerId,
          tx.referenceExternalTransactionId,
        );

        if (referenceTx) {
          // A referência chegou! Reutiliza a regra de domínio do Use Case para aplicar a reversão
          await this.processWagerUseCase.applyTransactionRules(
            ctx,
            wallet,
            tx,
            uuidv7(now.getTime()),
            now,
          );
          resolvedOrRejectedCount += 1;
          continue;
        }

        // Referência ainda não existe: verifica se estourou o limite de tentativas (Seção 7.1)
        if (tx.retryCount + 1 >= maxRetries) {
          tx.reject(FailureCode.REFERENCE_NOT_FOUND_TIMEOUT, now, wallet.balance);
          await ctx.transactions.save(tx);

          const rejectedEvent = WagerTransactionRejected.from(tx, {
            eventId: uuidv7(now.getTime()),
            correlationId: tx.id,
            causationId: tx.id,
            occurredAt: now,
          });
          await ctx.outbox.save(OutboxMessage.enqueue(rejectedEvent));

          this.logger.warn({
            message: 'Pending reference transaction rejected after max retries exhausted',
            transactionId: tx.id,
            referenceExternalTransactionId: tx.referenceExternalTransactionId,
            retryCount: tx.retryCount + 1,
          });

          resolvedOrRejectedCount += 1;
        } else {
          // Agenda próxima tentativa com backoff exponencial
          tx.scheduleReferenceRetry(now);
          await ctx.transactions.save(tx);
        }
      }
    });

    return resolvedOrRejectedCount;
  }
}