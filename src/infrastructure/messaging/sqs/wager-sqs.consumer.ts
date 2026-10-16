import {
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { SQS_CLIENT } from './sqs.client';
import { ProcessWagerTransactionUseCase } from '../../../application/use-cases/process-wager-transaction.use-case';
import { WagerTransactionKind } from '../../../domain/entities/wager-transaction.entity';
import {
  CurrencyMismatchError,
  DomainError,
  IdempotencyConflictError,
  InvalidMoneyError,
  InvalidTransactionStateError,
} from '../../../domain/errors/domain.errors';
import { ResourceNotFoundError, uuidv7 } from '../../../application/use-cases/app-utils';

export interface SqsWagerMessageEnvelope {
  messageId: string;
  type: string;
  occurredAt: string;
  correlationId?: string;
  data: {
    providerId: string;
    externalTransactionId: string;
    idempotencyKey?: string;
    playerId: string;
    walletId: string;
    roundId: string;
    gameId: string;
    kind: WagerTransactionKind;
    money: { amount: string; currency: string };
    referenceExternalTransactionId?: string;
  };
}

@Injectable()
export class WagerSqsConsumer implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(WagerSqsConsumer.name);
  public static readonly CONSUMER_NAME = 'wager-transactions-sqs-consumer';

  private isRunning = false;
  private pollingPromise: Promise<void> | null = null;
  private readonly inFlightMessages = new Map<string, string>(); // messageId -> receiptHandle

  private readonly queueUrl: string;
  private readonly dlqUrl: string;
  private readonly maxReceiveCount = 3;

  constructor(
    @Inject(SQS_CLIENT) private readonly sqsClient: SQSClient,
    private readonly config: ConfigService,
    private readonly processWagerUseCase: ProcessWagerTransactionUseCase,
  ) {
    this.queueUrl = this.config.get<string>(
      'SQS_WAGER_QUEUE_URL',
      'http://sqs.us-east-1.localhost.localstack.cloud:4566/000000000000/wager-transactions.fifo',
    );
    this.dlqUrl = this.config.get<string>(
      'SQS_WAGER_DLQ_URL',
      'http://sqs.us-east-1.localhost.localstack.cloud:4566/000000000000/wager-transactions-dlq.fifo',
    );
  }

  onModuleInit() {
    // Permite desativar o polling automático em testes unitários se necessário
    if (this.config.get<string>('DISABLE_SQS_CONSUMER') === 'true') {
      return;
    }
    this.start();
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.pollingPromise = this.pollLoop();
    this.logger.log(`SQS Consumer started listening on ${this.queueUrl}`);
  }

  private async pollLoop(): Promise<void> {
    while (this.isRunning) {
      try {
        const response = await this.sqsClient.send(
          new ReceiveMessageCommand({
            QueueUrl: this.queueUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: 2,
            MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
          }),
        );

        const messages = response.Messages ?? [];
        if (messages.length === 0) {
          continue;
        }

        for (const message of messages) {
          if (!this.isRunning) {
            // Se entrou em shutdown antes de iniciar esta mensagem, devolve visibilidade imediatamente
            await this.releaseMessageVisibility(message);
            continue;
          }
          await this.handleSingleMessage(message);
        }
      } catch (err) {
        if (this.isRunning) {
          this.logger.warn(`Transient error polling SQS: ${(err as Error).message}`);
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    }
  }

  /**
   * Método público também invocável diretamente em testes de integração/crash recovery
   */
  async handleSingleMessage(message: Message): Promise<void> {
    const receiptHandle = message.ReceiptHandle;
    const sqsMessageId = message.MessageId ?? uuidv7();
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');

    if (receiptHandle) {
      this.inFlightMessages.set(sqsMessageId, receiptHandle);
    }

    try {
      const envelope = this.parseEnvelope(message.Body);
      const businessMessageId = envelope.messageId || sqsMessageId;
      const data = envelope.data;
      const idempotencyKey =
        data.idempotencyKey ?? `${data.providerId}:${data.externalTransactionId}`;

      await this.processWagerUseCase.execute({
        idempotencyKey,
        providerId: data.providerId,
        externalTransactionId: data.externalTransactionId,
        playerId: data.playerId,
        walletId: data.walletId,
        roundId: data.roundId,
        gameId: data.gameId,
        kind: data.kind,
        money: data.money,
        referenceExternalTransactionId: data.referenceExternalTransactionId,
        correlationId: envelope.correlationId ?? businessMessageId,
        inboxContext: {
          consumerName: WagerSqsConsumer.CONSUMER_NAME,
          messageId: businessMessageId,
        },
      });

      // Commit concluído com sucesso (PROCESSED, REJECTED, PENDING_REFERENCE ou Replay) -> ACK
      if (receiptHandle) {
        await this.ackMessage(receiptHandle);
      }
    } catch (err) {
      await this.handleProcessingError(message, err as Error, receiveCount);
    } finally {
      this.inFlightMessages.delete(sqsMessageId);
    }
  }

  private parseEnvelope(body?: string): SqsWagerMessageEnvelope {
    if (!body) {
      throw new InvalidMoneyError('Empty SQS message body');
    }
    let parsed: SqsWagerMessageEnvelope;
    try {
      parsed = JSON.parse(body) as SqsWagerMessageEnvelope;
    } catch {
      throw new InvalidMoneyError('Malformed JSON in SQS message body');
    }

    if (!parsed.data || !parsed.data.providerId || !parsed.data.externalTransactionId) {
      throw new InvalidMoneyError('Missing required fields in SQS wager message envelope');
    }

    return parsed;
  }

  private async handleProcessingError(
    message: Message,
    error: Error,
    receiveCount: number,
  ): Promise<void> {
    const isPermanentError =
      error instanceof InvalidMoneyError ||
      error instanceof CurrencyMismatchError ||
      error instanceof IdempotencyConflictError ||
      error instanceof InvalidTransactionStateError ||
      error instanceof ResourceNotFoundError ||
      error instanceof DomainError;

    // Se for erro permanente de contrato OU atingiu o limite máximo de tentativas -> envia para DLQ e faz ACK
    if (isPermanentError || receiveCount >= this.maxReceiveCount) {
      this.logger.error({
        message: 'Moving SQS message to DLQ due to permanent failure or max retries exhausted',
        sqsMessageId: message.MessageId,
        receiveCount,
        errorCode: (error as DomainError).code ?? error.name,
        reason: error.message,
      });

      await this.moveToDlqAndAck(message, error.message);
      return;
    }

    // Erro transitório (ex.: queda do Postgres ou lock timeout) -> aplica backoff na visibilidade sem dar ACK
    const backoffSeconds = Math.min(30, Math.pow(2, receiveCount));
    this.logger.warn({
      message: 'Transient error processing SQS message; scheduling redelivery with backoff',
      sqsMessageId: message.MessageId,
      receiveCount,
      backoffSeconds,
      reason: error.message,
    });

    if (message.ReceiptHandle) {
      try {
        await this.sqsClient.send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: this.queueUrl,
            ReceiptHandle: message.ReceiptHandle,
            VisibilityTimeout: backoffSeconds,
          }),
        );
      } catch {
        // Se o próprio SQS estiver indisponível, o VisibilityTimeout padrão cuidará da reentrega
      }
    }
  }

  private async ackMessage(receiptHandle: string): Promise<void> {
    await this.sqsClient.send(
      new DeleteMessageCommand({
        QueueUrl: this.queueUrl,
        ReceiptHandle: receiptHandle,
      }),
    );
  }

  private async moveToDlqAndAck(message: Message, failureReason: string): Promise<void> {
    const deduplicationId = message.MessageId ?? uuidv7();
    await this.sqsClient.send(
      new SendMessageCommand({
        QueueUrl: this.dlqUrl,
        MessageBody: message.Body ?? '{}',
        MessageGroupId: message.Attributes?.MessageGroupId ?? 'dlq-default-group',
        MessageDeduplicationId: `dlq-${deduplicationId}`,
        MessageAttributes: {
          FailureReason: {
            DataType: 'String',
            StringValue: failureReason.slice(0, 250),
          },
        },
      }),
    );

    if (message.ReceiptHandle) {
      await this.ackMessage(message.ReceiptHandle);
    }
  }

  private async releaseMessageVisibility(message: Message): Promise<void> {
    if (!message.ReceiptHandle) return;
    try {
      await this.sqsClient.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: this.queueUrl,
          ReceiptHandle: message.ReceiptHandle,
          VisibilityTimeout: 0,
        }),
      );
    } catch {
      // Ignora falha no shutdown
    }
  }

  async onApplicationShutdown(signal?: string): Promise<void> {
    this.logger.log(`Received ${signal ?? 'shutdown'}: stopping SQS consumer gracefully...`);
    this.isRunning = false;

    if (this.pollingPromise) {
      // Aguarda até 5s para a mensagem em andamento terminar o commit e o ACK
      await Promise.race([
        this.pollingPromise,
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
    }

    // Se ainda sobrou alguma mensagem presa após o timeout, devolve visibilidade imediatamente (Seção 10)
    for (const [, receiptHandle] of this.inFlightMessages.entries()) {
      try {
        await this.sqsClient.send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: this.queueUrl,
            ReceiptHandle: receiptHandle,
            VisibilityTimeout: 0,
          }),
        );
      } catch {
        // Ignora erro de rede no desligamento
      }
    }
    this.inFlightMessages.clear();
  }
}