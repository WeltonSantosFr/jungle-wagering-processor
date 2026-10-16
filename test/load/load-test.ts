import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { CreateWalletUseCase } from '../../src/application/use-cases/create-wallet.use-case';
import { ProcessWagerTransactionUseCase } from '../../src/application/use-cases/process-wager-transaction.use-case';
import { ReconcileWalletUseCase } from '../../src/application/use-cases/reconcile-wallet.use-case';
import { OutboxPublisherWorker } from '../../src/infrastructure/messaging/outbox/outbox-publisher.worker';
import { WagerTransactionKind } from '../../src/domain/entities/wager-transaction.entity';
import { uuidv7 } from '../../src/application/use-cases/app-utils';

process.env.DISABLE_SQS_CONSUMER = 'true';
process.env.DISABLE_BACKGROUND_WORKERS = 'true';
process.env.LOG_SILENT = 'true';

async function runLoadTest() {
  console.log('🚀 Iniciando Teste de Carga — Distributed Wagering Processor...');

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  await moduleRef.init();

  const dataSource = moduleRef.get(DataSource);
  const createWallet = moduleRef.get(CreateWalletUseCase);
  const processWager = moduleRef.get(ProcessWagerTransactionUseCase);
  const reconcile = moduleRef.get(ReconcileWalletUseCase);
  const outboxWorker = moduleRef.get(OutboxPublisherWorker);

  await dataSource.query(`
    TRUNCATE TABLE
      outbox_messages,
      inbox_messages,
      wallet_ledger_entries,
      wager_transactions,
      wallets
    CASCADE;
  `);

  const WALLETS_COUNT = 10;
  const OPS_PER_WALLET = 30; // 300 operações concorrentes totais (+ 50 replays = 350 requisições)
  const wallets = await Promise.all(
    Array.from({ length: WALLETS_COUNT }, () =>
      createWallet.execute({
        playerId: uuidv7(),
        initialBalance: { amount: '500.00', currency: 'BRL' },
      }),
    ),
  );

  const latenciesMs: number[] = [];
  let processedCount = 0;
  let rejectedCount = 0;
  let replayCount = 0;
  let errorsCount = 0;

  const startTotal = performance.now();

  // Fase 1: 300 apostas concorrentes disputando as 10 carteiras (Hot Wallets)
  const tasks: Promise<void>[] = [];
  for (let wIdx = 0; wIdx < WALLETS_COUNT; wIdx++) {
    const wallet = wallets[wIdx]!;
    for (let opIdx = 0; opIdx < OPS_PER_WALLET; opIdx++) {
      tasks.push(
        (async () => {
          const t0 = performance.now();
          try {
            const extId = `load-w${wIdx}-op${opIdx}`;
            const res = await processWager.execute({
              idempotencyKey: `load-prov:${extId}`,
              providerId: 'load-prov',
              externalTransactionId: extId,
              playerId: wallet.playerId,
              walletId: wallet.id,
              roundId: `round-${opIdx}`,
              gameId: 'fortune-chimp',
              kind: WagerTransactionKind.Bet,
              money: { amount: '20.00', currency: 'BRL' }, // Saldo 500 suporta 25 apostas de 20; 5 serão REJECTED
            });
            latenciesMs.push(performance.now() - t0);
            if (res.status === 'PROCESSED') processedCount++;
            if (res.status === 'REJECTED') rejectedCount++;
          } catch {
            errorsCount++;
          }
        })(),
      );
    }
  }

  await Promise.all(tasks);

  // Fase 2: 50 replays idênticos concorrentes sobre a primeira aposta
  await Promise.all(
    Array.from({ length: 50 }, async () => {
      const t0 = performance.now();
      const res = await processWager.execute({
        idempotencyKey: 'load-prov:load-w0-op0',
        providerId: 'load-prov',
        externalTransactionId: 'load-w0-op0',
        playerId: wallets[0]!.playerId,
        walletId: wallets[0]!.id,
        roundId: 'round-0',
        gameId: 'fortune-chimp',
        kind: WagerTransactionKind.Bet,
        money: { amount: '20.00', currency: 'BRL' },
      });
      latenciesMs.push(performance.now() - t0);
      if (res.idempotentReplay) replayCount++;
    }),
  );

  const durationSec = (performance.now() - startTotal) / 1000;
  const totalRequests = latenciesMs.length;
  const rps = (totalRequests / durationSec).toFixed(2);

  // Medição de Outbox Lag antes e depois do flush
  const outboxBefore = await dataSource.query(
    `SELECT COUNT(*)::int AS cnt FROM outbox_messages WHERE published_at IS NULL`,
  );
  const outboxLagBeforeFlush = outboxBefore[0].cnt;

  while ((await outboxWorker.publishPendingBatch(100)) > 0) {
    // drena toda a outbox
  }

  const outboxAfter = await dataSource.query(
    `SELECT COUNT(*)::int AS cnt FROM outbox_messages WHERE published_at IS NULL`,
  );
  const outboxLagAfterFlush = outboxAfter[0].cnt;

  // Validação da invariante contábil em todas as carteiras
  let allConsistent = true;
  for (const w of wallets) {
    const rec = await reconcile.execute(w.id);
    if (!rec.consistent || rec.storedBalance.amount !== '0.00') {
      allConsistent = false;
    }
  }

  latenciesMs.sort((a, b) => a - b);
  const p50 = latenciesMs[Math.floor(totalRequests * 0.5)]!.toFixed(2);
  const p95 = latenciesMs[Math.floor(totalRequests * 0.95)]!.toFixed(2);
  const p99 = latenciesMs[Math.floor(totalRequests * 0.99)]!.toFixed(2);

  console.log('\n📊 RESULTADOS DO TESTE DE CARGA:');
  console.table({
    'Total Requests': totalRequests,
    'Duration (s)': durationSec.toFixed(2),
    'Throughput (req/s)': rps,
    'Latency p50 (ms)': p50,
    'Latency p95 (ms)': p95,
    'Latency p99 (ms)': p99,
    'PROCESSED Bets': processedCount,
    'REJECTED Bets (Insufficient Funds)': rejectedCount,
    'Idempotent Replays': replayCount,
    'Unexpected Errors (5xx)': errorsCount,
    'Outbox Lag (Before -> After Flush)': `${outboxLagBeforeFlush} -> ${outboxLagAfterFlush}`,
    'Ledger == Wallet Invariant (All Wallets)': allConsistent ? 'PASS ✅' : 'FAIL ❌',
  });

  await moduleRef.close();
  process.exit(allConsistent && errorsCount === 0 ? 0 : 1);
}

runLoadTest();