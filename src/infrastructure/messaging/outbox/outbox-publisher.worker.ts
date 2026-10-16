import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { SQS_CLIENT } from '../sqs/sqs.client';
import { UNIT_OF_WORK, type UnitOfWorkPort } from '../../../application/ports/persistence.ports';

@Injectable()
export class OutboxPublisherWorker {
  private readonly logger = new Logger(OutboxPublisherWorker.name);
  private readonly eventsQueueUrl: string;
  private isProcessing = false;

  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWorkPort,
    @Inject(SQS_CLIENT) private readonly sqsClient: SQSClient,
    private readonly config: ConfigService,
  ) {
    this.eventsQueueUrl = this.config.get<string>(
      'SQS_EVENTS_QUEUE_URL',
      'http://sqs.us-east-1.localhost.localstack.cloud:4566/000000000000/wagering-events.fifo',
    );
  }

  @Cron('*/1 * * * * *') // Executa a cada 1 segundo
  async handleCron(): Promise<void> {
    if (this.config.get<string>('DISABLE_BACKGROUND_WORKERS') === 'true') {
      return;
    }
    if (this.isProcessing) return;

    this.isProcessing = true;
    try {
      await this.publishPendingBatch(50);
    } catch (err) {
      this.logger.error(`Error in OutboxPublisherWorker loop: ${(err as Error).message}`);
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Método público também invocável diretamente nos testes de concorrência (Seção 13)
   */
  async publishPendingBatch(batchSize = 50): Promise<number> {
    let publishedCount = 0;

    await this.uow.runInTransaction(async (ctx) => {
      const now = new Date();
      // FOR UPDATE SKIP LOCKED: múltiplos publishers concorrentes nunca pegam as mesmas linhas
      const dueMessages = await ctx.outbox.claimDueMessages(now, batchSize);

      for (const msg of dueMessages) {
        try {
          await this.sqsClient.send(
            new SendMessageCommand({
              QueueUrl: this.eventsQueueUrl,
              MessageBody: JSON.stringify(msg.payload),
              MessageGroupId: msg.aggregateId, // Garante ordem por Wallet na fila de eventos
              MessageDeduplicationId: msg.id,  // Deduplicação nativa por eventId
            }),
          );

          msg.markPublished(new Date());
          await ctx.outbox.save(msg);
          publishedCount += 1;
        } catch (err) {
          msg.scheduleRetry(new Date());
          await ctx.outbox.save(msg);
          this.logger.warn({
            message: 'Failed to publish outbox message; scheduled retry with backoff',
            outboxId: msg.id,
            eventType: msg.eventType,
            attempts: msg.attempts,
            nextAttemptAt: msg.nextAttemptAt?.toISOString(),
            reason: (err as Error).message,
          });
        }
      }
    });

    return publishedCount;
  }
}