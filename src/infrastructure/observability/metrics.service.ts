import { Inject, Injectable } from '@nestjs/common';
import { UNIT_OF_WORK, type UnitOfWorkPort } from '../../application/ports/persistence.ports';

@Injectable()
export class MetricsService {
  private readonly transactionsByStatus: Record<string, number> = {
    PROCESSED: 0,
    REJECTED: 0,
    PENDING_REFERENCE: 0,
    FAILED: 0,
  };

  private duplicatesDetected = 0;
  private retriesCount = 0;
  private dlqMessagesCount = 0;
  private lockOrIdempotencyConflictsCount = 0;
  private reconciliationDivergencesCount = 0;
  private readonly processingLatenciesMs: number[] = [];

  constructor(
    @Inject(UNIT_OF_WORK)
    private readonly uow: UnitOfWorkPort,
  ) {}

  recordTransactionStatus(status: string): void {
    this.transactionsByStatus[status] = (this.transactionsByStatus[status] ?? 0) + 1;
  }

  recordDuplicateDetected(): void {
    this.duplicatesDetected += 1;
  }

  recordRetry(): void {
    this.retriesCount += 1;
  }

  recordDlqMessage(): void {
    this.dlqMessagesCount += 1;
  }

  recordConflict(): void {
    this.lockOrIdempotencyConflictsCount += 1;
  }

  recordReconciliationDivergence(): void {
    this.reconciliationDivergencesCount += 1;
  }

  recordProcessingLatency(durationMs: number): void {
    this.processingLatenciesMs.push(durationMs);
    // Mantém janela deslizante das últimas 5.000 amostras em memória
    if (this.processingLatenciesMs.length > 5000) {
      this.processingLatenciesMs.shift();
    }
  }

  async getSnapshot() {
    const outboxLag = await this.uow.repositories.outbox.countPending();
    const sorted = [...this.processingLatenciesMs].sort((a, b) => a - b);
    const count = sorted.length;

    const sum = sorted.reduce((acc, v) => acc + v, 0);
    const avgMs = count > 0 ? Number((sum / count).toFixed(2)) : 0;
    const p50Ms = count > 0 ? sorted[Math.floor(count * 0.5)]! : 0;
    const p95Ms = count > 0 ? sorted[Math.floor(count * 0.95)]! : 0;
    const p99Ms = count > 0 ? sorted[Math.floor(count * 0.99)]! : 0;

    return {
      transactionsByStatus: { ...this.transactionsByStatus },
      duplicatesDetected: this.duplicatesDetected,
      retriesCount: this.retriesCount,
      dlqMessagesCount: this.dlqMessagesCount,
      lockOrIdempotencyConflictsCount: this.lockOrIdempotencyConflictsCount,
      reconciliationDivergencesCount: this.reconciliationDivergencesCount,
      outboxLag,
      processingLatencyMs: {
        samples: count,
        avg: avgMs,
        p50: p50Ms,
        p95: p95Ms,
        p99: p99Ms,
      },
    };
  }
}