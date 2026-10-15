import { Entity, PrimaryColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('wager_transactions')
export class WagerTransactionOrmEntity {
  @PrimaryColumn('uuid')
  id: string;

  @Column({ name: 'provider_id', type: 'varchar', length: 100 })
  providerId: string;

  @Column({ name: 'external_transaction_id', type: 'varchar', length: 150 })
  externalTransactionId: string;

  @Column({ name: 'idempotency_key', type: 'varchar', length: 255 })
  idempotencyKey: string;

  @Column({ name: 'payload_hash', type: 'varchar', length: 64 })
  payloadHash: string;

  @Column({ name: 'wallet_id', type: 'uuid' })
  walletId: string;

  @Column({ name: 'player_id', type: 'uuid' })
  playerId: string;

  @Column({ name: 'round_id', type: 'varchar', length: 150 })
  roundId: string;

  @Column({ name: 'game_id', type: 'varchar', length: 150 })
  gameId: string;

  @Column({ type: 'varchar', length: 20 })
  kind: string;

  @Column({ type: 'numeric', precision: 20, scale: 2 })
  amount: string;

  @Column({ type: 'varchar', length: 3 })
  currency: string;

  @Column({ name: 'reference_external_transaction_id', type: 'varchar', length: 150, nullable: true })
  referenceExternalTransactionId: string | null;

  @Column({ name: 'reference_transaction_id', type: 'uuid', nullable: true })
  referenceTransactionId: string | null;

  @Column({ type: 'varchar', length: 30 })
  status: string;

  @Column({ name: 'failure_code', type: 'varchar', length: 60, nullable: true })
  failureCode: string | null;

  // Campos de controle para o worker de PENDING_REFERENCE (Seção 7.1)
  @Column({ name: 'retry_count', type: 'int', default: 0 })
  retryCount: number;

  @Column({ name: 'next_retry_at', type: 'timestamptz', nullable: true })
  nextRetryAt: Date | null;

  // Snapshot do saldo observado no momento da conclusão para replays idempotentes exatos (Seção 7 - Regra 7)
  @Column({ name: 'observed_balance', type: 'numeric', precision: 20, scale: 2, nullable: true })
  observedBalance: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ name: 'processed_at', type: 'timestamptz', nullable: true })
  processedAt: Date | null;
}