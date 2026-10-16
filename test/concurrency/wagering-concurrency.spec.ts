import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { CreateWalletUseCase } from '../../src/application/use-cases/create-wallet.use-case';
import { ProcessWagerTransactionUseCase } from '../../src/application/use-cases/process-wager-transaction.use-case';
import { ReconcileWalletUseCase } from '../../src/application/use-cases/reconcile-wallet.use-case';
import { QueriesUseCase } from '../../src/application/use-cases/queries.use-case';
import { WagerSqsConsumer } from '../../src/infrastructure/messaging/sqs/wager-sqs.consumer';
import { OutboxPublisherWorker } from '../../src/infrastructure/messaging/outbox/outbox-publisher.worker';
import { PendingReferenceWorker } from '../../src/infrastructure/messaging/outbox/pending-service.worker';
import { FailureCode } from '../../src/domain/errors/domain.errors';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../src/domain/entities/wager-transaction.entity';
import { uuidv7 } from '../../src/application/use-cases/app-utils';

process.env.DISABLE_SQS_CONSUMER = 'true';
process.env.DISABLE_BACKGROUND_WORKERS = 'true';
process.env.LOG_SILENT = 'true';

describe('Concurrency & Crash Recovery Suite (8 Mandatory Scenarios - Section 13)', () => {
  // Três instâncias independentes da aplicação simulando >= 3 processos/workers simultâneos
  let appInstances: TestingModule[] = [];
  let dataSource: DataSource;

  beforeAll(async () => {
    for (let i = 0; i < 3; i++) {
      const mod = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      await mod.init();
      appInstances.push(mod);
    }
    dataSource = appInstances[0]!.get(DataSource);
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
    for (const mod of appInstances) {
      await mod.close();
    }
  });

  // Cenário 1: A mesma aposta enviada 50 vezes em paralelo -> um único débito
  it('1. should process the exact same bet 50 times in parallel resulting in a single debit', async () => {
    const createWallet = appInstances[0]!.get(CreateWalletUseCase);
    const processWager = appInstances[0]!.get(ProcessWagerTransactionUseCase);
    const reconcile = appInstances[0]!.get(ReconcileWalletUseCase);

    const playerId = uuidv7();
    const wallet = await createWallet.execute({
      playerId,
      initialBalance: { amount: '500.00', currency: 'BRL' },
    });

    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        processWager.execute({
          idempotencyKey: 'provider-a:bet-50x',
          providerId: 'provider-a',
          externalTransactionId: 'bet-50x',
          playerId,
          walletId: wallet.id,
          roundId: 'round-50x',
          gameId: 'fortune-chimp',
          kind: WagerTransactionKind.Bet,
          money: { amount: '100.00', currency: 'BRL' },
        }),
      ),
    );

    const freshExecutions = results.filter((r) => !r.idempotentReplay);
    const replays = results.filter((r) => r.idempotentReplay);

    expect(freshExecutions.length).toBe(1);
    expect(replays.length).toBe(49);

    for (const res of results) {
      expect(res.status).toBe(WagerTransactionStatus.Processed);
      expect(res.balance.amount).toBe('400.00');
    }

    const rec = await reconcile.execute(wallet.id);
    expect(rec.consistent).toBe(true);
    expect(rec.storedBalance.amount).toBe('400.00');
    expect(rec.checkedEntries).toBe(2); // OPENING + 1 único BET
  });

  // Cenário 2 (Obrigatório da Seção 8): Saldo 100.00 BRL, duas apostas simultâneas de 80.00 BRL
  it('2. should handle two simultaneous 80.00 BRL bets on a 100.00 BRL wallet (1 PROCESSED, 1 REJECTED, final balance 20.00)', async () => {
    const createWallet = appInstances[0]!.get(CreateWalletUseCase);
    const processWager = appInstances[0]!.get(ProcessWagerTransactionUseCase);
    const reconcile = appInstances[0]!.get(ReconcileWalletUseCase);

    const playerId = uuidv7();
    const wallet = await createWallet.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    const [resA, resB] = await Promise.all([
      processWager.execute({
        idempotencyKey: 'provider-a:race-bet-1',
        providerId: 'provider-a',
        externalTransactionId: 'race-bet-1',
        playerId,
        walletId: wallet.id,
        roundId: 'round-race',
        gameId: 'fortune-chimp',
        kind: WagerTransactionKind.Bet,
        money: { amount: '80.00', currency: 'BRL' },
      }),
      processWager.execute({
        idempotencyKey: 'provider-a:race-bet-2',
        providerId: 'provider-a',
        externalTransactionId: 'race-bet-2',
        playerId,
        walletId: wallet.id,
        roundId: 'round-race',
        gameId: 'fortune-chimp',
        kind: WagerTransactionKind.Bet,
        money: { amount: '80.00', currency: 'BRL' },
      }),
    ]);

    const statuses = [resA.status, resB.status].sort();
    expect(statuses).toEqual([
      WagerTransactionStatus.Processed,
      WagerTransactionStatus.Rejected,
    ]);

    const rejected = resA.status === WagerTransactionStatus.Rejected ? resA : resB;
    expect(rejected.failureCode).toBe(FailureCode.INSUFFICIENT_FUNDS);

    const rec = await reconcile.execute(wallet.id);
    expect(rec.consistent).toBe(true);
    expect(rec.storedBalance.amount).toBe('20.00');
    expect(rec.calculatedBalance.amount).toBe('20.00');
    expect(rec.checkedEntries).toBe(2); // OPENING (100) + 1 único DEBIT (80)
  });

  // Cenário 3 e 4: Wallets distintas processadas em paralelo em >= 3 instâncias simultâneas
  it('3 & 4. should process distinct wallets in parallel across 3 simultaneous instances without cross-wallet contention', async () => {
    const createWallet = appInstances[0]!.get(CreateWalletUseCase);
    const reconcile = appInstances[0]!.get(ReconcileWalletUseCase);

    const wallets = await Promise.all(
      Array.from({ length: 6 }, () =>
        createWallet.execute({
          playerId: uuidv7(),
          initialBalance: { amount: '100.00', currency: 'BRL' },
        }),
      ),
    );

    // Dispara 5 apostas de 10.00 para cada uma das 6 carteiras distribuindo entre as 3 instâncias
    await Promise.all(
      wallets.flatMap((w, wIdx) =>
        Array.from({ length: 5 }, (_, betIdx) => {
          const instance = appInstances[(wIdx + betIdx) % 3]!.get(
            ProcessWagerTransactionUseCase,
          );
          const extId = `w-${wIdx}-bet-${betIdx}`;
          return instance.execute({
            idempotencyKey: `prov:${extId}`,
            providerId: 'prov',
            externalTransactionId: extId,
            playerId: w.playerId,
            walletId: w.id,
            roundId: `round-${betIdx}`,
            gameId: 'fortune-chimp',
            kind: WagerTransactionKind.Bet,
            money: { amount: '10.00', currency: 'BRL' },
          });
        }),
      ),
    );

    for (const w of wallets) {
      const rec = await reconcile.execute(w.id);
      expect(rec.consistent).toBe(true);
      expect(rec.storedBalance.amount).toBe('50.00');
      expect(rec.checkedEntries).toBe(6); // OPENING + 5 BETs
    }
  });

  // Cenário 5: Worker morto depois do commit e antes do ack (redelivery na instância 2)
  it('5. should not duplicate financial effects when worker dies after DB commit and before SQS ACK', async () => {
    const createWallet = appInstances[0]!.get(CreateWalletUseCase);
    const processWagerInst1 = appInstances[0]!.get(ProcessWagerTransactionUseCase);
    const consumerInst2 = appInstances[1]!.get(WagerSqsConsumer);
    const reconcile = appInstances[0]!.get(ReconcileWalletUseCase);

    const playerId = uuidv7();
    const wallet = await createWallet.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    // Instância 1 faz o commit no banco (incluindo Inbox), mas "morre" antes de dar ACK no SQS
    await processWagerInst1.execute({
      idempotencyKey: 'prov-crash:tx-1',
      providerId: 'prov-crash',
      externalTransactionId: 'tx-1',
      playerId,
      walletId: wallet.id,
      roundId: 'round-crash',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Bet,
      money: { amount: '40.00', currency: 'BRL' },
      inboxContext: {
        consumerName: WagerSqsConsumer.CONSUMER_NAME,
        messageId: 'msg-crash-001',
      },
    });

    // Instância 2 recebe a reentrega da mesma mensagem do SQS
    await consumerInst2.handleSingleMessage({
      MessageId: 'sqs-redelivered',
      Body: JSON.stringify({
        messageId: 'msg-crash-001',
        type: 'WagerTransactionRequested',
        occurredAt: new Date().toISOString(),
        data: {
          providerId: 'prov-crash',
          externalTransactionId: 'tx-1',
          idempotencyKey: 'prov-crash:tx-1',
          playerId,
          walletId: wallet.id,
          roundId: 'round-crash',
          gameId: 'fortune-chimp',
          kind: 'BET',
          money: { amount: '40.00', currency: 'BRL' },
        },
      }),
    });

    const rec = await reconcile.execute(wallet.id);
    expect(rec.consistent).toBe(true);
    expect(rec.storedBalance.amount).toBe('60.00');
    expect(rec.checkedEntries).toBe(2);
  });

  // Cenário 6: Dois publishers concorrentes sobre a mesma outbox
  it('6. should allow two concurrent Outbox publishers without duplicating claims (FOR UPDATE SKIP LOCKED)', async () => {
    const createWallet = appInstances[0]!.get(CreateWalletUseCase);
    const processWager = appInstances[0]!.get(ProcessWagerTransactionUseCase);
    const publisher1 = appInstances[0]!.get(OutboxPublisherWorker);
    const publisher2 = appInstances[1]!.get(OutboxPublisherWorker);

    const playerId = uuidv7();
    const wallet = await createWallet.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    for (let i = 0; i < 5; i++) {
      await processWager.execute({
        idempotencyKey: `prov-outbox:tx-${i}`,
        providerId: 'prov-outbox',
        externalTransactionId: `tx-${i}`,
        playerId,
        walletId: wallet.id,
        roundId: `r-${i}`,
        gameId: 'fortune-chimp',
        kind: WagerTransactionKind.Bet,
        money: { amount: '10.00', currency: 'BRL' },
      });
    }

    // Total de eventos na outbox = 1 (OPENING) + 5 * 2 (WalletBalanceChanged + WagerTransactionProcessed) = 11
    const [pubCount1, pubCount2] = await Promise.all([
      publisher1.publishPendingBatch(50),
      publisher2.publishPendingBatch(50),
    ]);

    expect(pubCount1 + pubCount2).toBe(11);

    const pendingLeft = await dataSource.query(
      `SELECT COUNT(*)::int AS cnt FROM outbox_messages WHERE published_at IS NULL`,
    );
    expect(pendingLeft[0].cnt).toBe(0);
  });

  // Cenário 7: ROLLBACK ou REFUND entregue antes da referência (PENDING_REFERENCE -> PROCESSED)
  it('7. should queue REFUND arriving before BET as PENDING_REFERENCE and process it once BET arrives', async () => {
    const createWallet = appInstances[0]!.get(CreateWalletUseCase);
    const processWager = appInstances[0]!.get(ProcessWagerTransactionUseCase);
    const pendingWorker = appInstances[0]!.get(PendingReferenceWorker);
    const queries = appInstances[0]!.get(QueriesUseCase);
    const reconcile = appInstances[0]!.get(ReconcileWalletUseCase);

    const playerId = uuidv7();
    const wallet = await createWallet.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    // 1. REFUND chega ANTES da BET existir -> fica PENDING_REFERENCE e saldo continua 100.00
    const earlyRefund = await processWager.execute({
      idempotencyKey: 'prov-ooo:refund-early',
      providerId: 'prov-ooo',
      externalTransactionId: 'refund-early',
      playerId,
      walletId: wallet.id,
      roundId: 'round-ooo',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Refund,
      money: { amount: '35.00', currency: 'BRL' },
      referenceExternalTransactionId: 'bet-late',
    });
    expect(earlyRefund.status).toBe(WagerTransactionStatus.PendingReference);
    expect(earlyRefund.balance.amount).toBe('100.00');

    // 2. A BET atrasada finalmente chega -> debita 35.00 (saldo vai para 65.00)
    const lateBet = await processWager.execute({
      idempotencyKey: 'prov-ooo:bet-late',
      providerId: 'prov-ooo',
      externalTransactionId: 'bet-late',
      playerId,
      walletId: wallet.id,
      roundId: 'round-ooo',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Bet,
      money: { amount: '35.00', currency: 'BRL' },
    });
    expect(lateBet.status).toBe(WagerTransactionStatus.Processed);
    expect(lateBet.balance.amount).toBe('65.00');

    // Força o next_retry_at para agora para o worker processar imediatamente no teste
    await dataSource.query(
      `UPDATE wager_transactions SET next_retry_at = NOW() - INTERVAL '1 second' WHERE id = $1`,
      [earlyRefund.transactionId],
    );

    // 3. Worker de Pending Reference reprocessa o REFUND -> saldo volta para 100.00
    const resolved = await pendingWorker.processPendingReferencesBatch(10);
    expect(resolved).toBe(1);

    const updatedRefund = await queries.getTransactionById(earlyRefund.transactionId);
    expect(updatedRefund.status).toBe(WagerTransactionStatus.Processed);

    const rec = await reconcile.execute(wallet.id);
    expect(rec.consistent).toBe(true);
    expect(rec.storedBalance.amount).toBe('100.00');
    expect(rec.checkedEntries).toBe(3); // OPENING (+100), BET (-35), REFUND (+35)
  });

  // Cenário 8: Reinício do serviço com comprovação da consistência final
  it('8. should preserve full ledger and outbox consistency across service restart', async () => {
    const createWallet = appInstances[0]!.get(CreateWalletUseCase);
    const processWager = appInstances[0]!.get(ProcessWagerTransactionUseCase);

    const playerId = uuidv7();
    const wallet = await createWallet.execute({
      playerId,
      initialBalance: { amount: '150.00', currency: 'BRL' },
    });

    await processWager.execute({
      idempotencyKey: 'prov-restart:bet-1',
      providerId: 'prov-restart',
      externalTransactionId: 'bet-1',
      playerId,
      walletId: wallet.id,
      roundId: 'round-restart',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Bet,
      money: { amount: '45.00', currency: 'BRL' },
    });

    // Simula shutdown e subida de uma nova instância do zero
    const freshInstance = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    await freshInstance.init();

    const freshReconcile = freshInstance.get(ReconcileWalletUseCase);
    const freshOutbox = freshInstance.get(OutboxPublisherWorker);

    await freshOutbox.publishPendingBatch(50);
    const rec = await freshReconcile.execute(wallet.id);

    expect(rec.consistent).toBe(true);
    expect(rec.storedBalance.amount).toBe('105.00');
    expect(rec.calculatedBalance.amount).toBe('105.00');

    await freshInstance.close();
  });
});