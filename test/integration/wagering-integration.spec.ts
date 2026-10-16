import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import {
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { AppModule } from '../../src/app.module';
import { CreateWalletUseCase } from '../../src/application/use-cases/create-wallet.use-case';
import { ProcessWagerTransactionUseCase } from '../../src/application/use-cases/process-wager-transaction.use-case';
import { ReconcileWalletUseCase } from '../../src/application/use-cases/reconcile-wallet.use-case';
import { QueriesUseCase } from '../../src/application/use-cases/queries.use-case';
import { WagerSqsConsumer } from '../../src/infrastructure/messaging/sqs/wager-sqs.consumer';
import { OutboxPublisherWorker } from '../../src/infrastructure/messaging/outbox/outbox-publisher.worker';
import { SQS_CLIENT } from '../../src/infrastructure/messaging/sqs/sqs.client';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../src/domain/entities/wager-transaction.entity';
import { FailureCode, IdempotencyConflictError } from '../../src/domain/errors/domain.errors';
import { uuidv7 } from '../../src/application/use-cases/app-utils';

process.env.DISABLE_SQS_CONSUMER = 'true';
process.env.DISABLE_BACKGROUND_WORKERS = 'true';
process.env.LOG_SILENT = 'true';

describe('Integration Tests (PostgreSQL + LocalStack SQS)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let sqsClient: SQSClient;
  let createWallet: CreateWalletUseCase;
  let processWager: ProcessWagerTransactionUseCase;
  let reconcileWallet: ReconcileWalletUseCase;
  let queries: QueriesUseCase;
  let sqsConsumer: WagerSqsConsumer;
  let outboxWorker: OutboxPublisherWorker;

  const dlqUrl =
    process.env.SQS_WAGER_DLQ_URL ||
    'http://sqs.us-east-1.localhost.localstack.cloud:4566/000000000000/wager-transactions-dlq.fifo';

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    await moduleRef.init();

    dataSource = moduleRef.get(DataSource);
    sqsClient = moduleRef.get(SQS_CLIENT);
    createWallet = moduleRef.get(CreateWalletUseCase);
    processWager = moduleRef.get(ProcessWagerTransactionUseCase);
    reconcileWallet = moduleRef.get(ReconcileWalletUseCase);
    queries = moduleRef.get(QueriesUseCase);
    sqsConsumer = moduleRef.get(WagerSqsConsumer);
    outboxWorker = moduleRef.get(OutboxPublisherWorker);
  });

  beforeEach(async () => {
    await dataSource.query(`
      TRUNCATE TABLE
        outbox_messages,
        inbox_messages,
        wallet_ledger_entries,
        wager_transactions,
        wallets
      CASCADE;
    `);
  });

  afterAll(async () => {
    await moduleRef?.close();
  });

  it('should enforce database schema constraints and ledger immutability trigger', async () => {
    const wallet = await createWallet.execute({
      playerId: uuidv7(),
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    // 1. Trigger de imutabilidade deve bloquear UPDATE e DELETE no ledger
    await expect(
      dataSource.query(`DELETE FROM wallet_ledger_entries WHERE wallet_id = $1`, [wallet.id]),
    ).rejects.toThrow(/immutable/);

    await expect(
      dataSource.query(`UPDATE wallet_ledger_entries SET amount = 50.00 WHERE wallet_id = $1`, [
        wallet.id,
      ]),
    ).rejects.toThrow(/immutable/);

    // 2. Check constraint deve bloquear saldo negativo direto no SQL
    await expect(
      dataSource.query(`UPDATE wallets SET balance = -1.00 WHERE id = $1`, [wallet.id]),
    ).rejects.toThrow();

    const rec = await reconcileWallet.execute(wallet.id);
    expect(rec.consistent).toBe(true);
    expect(rec.calculatedBalance.amount).toBe('100.00');
  });

  it('should process full lifecycle (OPENING -> BET -> WIN -> LOSS -> REFUND -> ROLLBACK) with cursor pagination and outbox', async () => {
    const playerId = uuidv7();
    const wallet = await createWallet.execute({
      playerId,
      initialBalance: { amount: '200.00', currency: 'BRL' },
    });

    // BET 1: 50.00 -> saldo 150.00
    const bet1 = await processWager.execute({
      idempotencyKey: 'prov-1:bet-1',
      providerId: 'prov-1',
      externalTransactionId: 'bet-1',
      playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'chimp-slots',
      kind: WagerTransactionKind.Bet,
      money: { amount: '50.00', currency: 'BRL' },
    });
    expect(bet1.status).toBe(WagerTransactionStatus.Processed);
    expect(bet1.balance.amount).toBe('150.00');

    // WIN 1: 80.00 -> saldo 230.00
    const win1 = await processWager.execute({
      idempotencyKey: 'prov-1:win-1',
      providerId: 'prov-1',
      externalTransactionId: 'win-1',
      playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'chimp-slots',
      kind: WagerTransactionKind.Win,
      money: { amount: '80.00', currency: 'BRL' },
      referenceExternalTransactionId: 'bet-1',
    });
    expect(win1.status).toBe(WagerTransactionStatus.Processed);
    expect(win1.balance.amount).toBe('230.00');

    // LOSS: 0.00 -> não altera saldo nem gera ledger
    const loss1 = await processWager.execute({
      idempotencyKey: 'prov-1:loss-1',
      providerId: 'prov-1',
      externalTransactionId: 'loss-1',
      playerId,
      walletId: wallet.id,
      roundId: 'round-2',
      gameId: 'chimp-slots',
      kind: WagerTransactionKind.Loss,
      money: { amount: '0.00', currency: 'BRL' },
    });
    expect(loss1.status).toBe(WagerTransactionStatus.Processed);
    expect(loss1.balance.amount).toBe('230.00');

    // REFUND da bet-1 (+50.00) -> saldo 280.00
    const refund1 = await processWager.execute({
      idempotencyKey: 'prov-1:refund-1',
      providerId: 'prov-1',
      externalTransactionId: 'refund-1',
      playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'chimp-slots',
      kind: WagerTransactionKind.Refund,
      money: { amount: '50.00', currency: 'BRL' },
      referenceExternalTransactionId: 'bet-1',
    });
    expect(refund1.status).toBe(WagerTransactionStatus.Processed);
    expect(refund1.balance.amount).toBe('280.00');

    // Segundo REFUND sobre a mesma bet-1 deve ser REJECTED (REFERENCE_ALREADY_REVERSED)
    const duplicateRefund = await processWager.execute({
      idempotencyKey: 'prov-1:refund-dup',
      providerId: 'prov-1',
      externalTransactionId: 'refund-dup',
      playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'chimp-slots',
      kind: WagerTransactionKind.Refund,
      money: { amount: '50.00', currency: 'BRL' },
      referenceExternalTransactionId: 'bet-1',
    });
    expect(duplicateRefund.status).toBe(WagerTransactionStatus.Rejected);
    expect(duplicateRefund.failureCode).toBe(FailureCode.REFERENCE_ALREADY_REVERSED);

    // Replay idempotente da bet-1 deve devolver o saldo observado na época (150.00), não o saldo atual (280.00)
    const replayBet1 = await processWager.execute({
      idempotencyKey: 'prov-1:bet-1',
      providerId: 'prov-1',
      externalTransactionId: 'bet-1',
      playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'chimp-slots',
      kind: WagerTransactionKind.Bet,
      money: { amount: '50.00', currency: 'BRL' },
    });
    expect(replayBet1.idempotentReplay).toBe(true);
    expect(replayBet1.balance.amount).toBe('150.00');

    // Mesma Idempotency-Key com payload diferente -> conflito
    await expect(
      processWager.execute({
        idempotencyKey: 'prov-1:bet-1',
        providerId: 'prov-1',
        externalTransactionId: 'bet-1',
        playerId,
        walletId: wallet.id,
        roundId: 'round-1',
        gameId: 'chimp-slots',
        kind: WagerTransactionKind.Bet,
        money: { amount: '55.00', currency: 'BRL' }, // valor adulterado
      }),
    ).rejects.toThrow(IdempotencyConflictError);

    // Paginação por cursor do Ledger (4 lançamentos: OPENING, BET, WIN, REFUND)
    const page1 = await queries.getWalletLedger(wallet.id, 2);
    expect(page1.items.length).toBe(2);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await queries.getWalletLedger(wallet.id, 2, page1.nextCursor!);
    expect(page2.items.length).toBe(2);
    expect(page2.nextCursor).toBeNull();

    // Publicar eventos da Outbox para o LocalStack SQS
    const publishedCount = await outboxWorker.publishPendingBatch(50);
    expect(publishedCount).toBeGreaterThanOrEqual(8);

    // Invariante final: wallet.balance == saldo reconstruído pelo ledger
    const rec = await reconcileWallet.execute(wallet.id);
    expect(rec.consistent).toBe(true);
    expect(rec.storedBalance.amount).toBe('280.00');
    expect(rec.calculatedBalance.amount).toBe('280.00');
    expect(rec.checkedEntries).toBe(4);
  });

  it('should deduplicate SQS redeliveries via Inbox and route malformed messages to DLQ', async () => {
    const playerId = uuidv7();
    const wallet = await createWallet.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    const sqsBody = JSON.stringify({
      messageId: 'msg-sqs-001',
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: 'provider-sqs',
        externalTransactionId: 'ext-sqs-1',
        idempotencyKey: 'provider-sqs:ext-sqs-1',
        playerId,
        walletId: wallet.id,
        roundId: 'round-sqs',
        gameId: 'fortune-chimp',
        kind: 'BET',
        money: { amount: '30.00', currency: 'BRL' },
      },
    });

    // 1ª entrega e 2ª reentrega (redelivery do SQS)
    await sqsConsumer.handleSingleMessage({ MessageId: 'aws-1', Body: sqsBody });
    await sqsConsumer.handleSingleMessage({ MessageId: 'aws-1-redelivery', Body: sqsBody });

    const rec = await reconcileWallet.execute(wallet.id);
    expect(rec.consistent).toBe(true);
    expect(rec.storedBalance.amount).toBe('70.00');
    expect(rec.checkedEntries).toBe(2); // OPENING + 1 único BET

    // Mensagem corrompida/inválida deve ir para a DLQ
    try {
      await sqsClient.send(new PurgeQueueCommand({ QueueUrl: dlqUrl }));
    } catch {
      // ignora se purge recente
    }

    await sqsConsumer.handleSingleMessage({
      MessageId: 'aws-bad-msg',
      Body: '{"malformed": true}',
      Attributes: { ApproximateReceiveCount: '1', MessageGroupId: wallet.id },
    });

    const dlqMessages = await sqsClient.send(
      new ReceiveMessageCommand({
        QueueUrl: dlqUrl,
        MaxNumberOfMessages: 5,
        WaitTimeSeconds: 1,
      }),
    );
    expect((dlqMessages.Messages ?? []).length).toBeGreaterThanOrEqual(1);
  });
});