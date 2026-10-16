import { Wallet } from '../../domain/entities/wallet.entity';
import { WagerTransaction } from '../../domain/entities/wager-transaction.entity';
import { WalletLedgerEntry } from '../../domain/entities/wallet-ledger-entry.entity';
import { InboxMessage } from '../../domain/entities/inbox-message.entity';
import { OutboxMessage } from '../../domain/entities/outbox-message.entity';

export interface PaginatedLedgerResult {
  items: WalletLedgerEntry[];
  nextCursor: string | null;
}

export interface WalletRepositoryPort {
  findById(id: string): Promise<Wallet | null>;
  /** Adquire Pessimistic Write Lock (SELECT ... FOR UPDATE) na linha da Wallet */
  findByIdForUpdate(id: string): Promise<Wallet | null>;
  findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | null>;
  save(wallet: Wallet): Promise<void>;
}

export interface WagerTransactionRepositoryPort {
  findById(id: string): Promise<WagerTransaction | null>;
  findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | null>;
  findByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null>;
  /** Verifica se já existe REFUND ou ROLLBACK PROCESSED para a mesma transação de referência */
  existsProcessedReversalFor(
    referenceTransactionId: string,
    kind: 'REFUND' | 'ROLLBACK',
  ): Promise<boolean>;
  /** Busca transações em PENDING_REFERENCE com lock (FOR UPDATE SKIP LOCKED) para reprocessamento */
  claimDuePendingReferences(now: Date, limit: number): Promise<WagerTransaction[]>;
  save(tx: WagerTransaction): Promise<void>;
}

export interface WalletLedgerRepositoryPort {
  save(entry: WalletLedgerEntry): Promise<void>;
  findByWalletPaginated(
    walletId: string,
    limit: number,
    cursor?: string,
  ): Promise<PaginatedLedgerResult>;
  findAllByWalletOrdered(walletId: string): Promise<WalletLedgerEntry[]>;
}

export interface InboxRepositoryPort {
  findByConsumerAndMessageId(
    consumerName: string,
    messageId: string,
  ): Promise<InboxMessage | null>;
  save(message: InboxMessage): Promise<void>;
}

export interface OutboxRepositoryPort {
  save(message: OutboxMessage): Promise<void>;
  saveMany(messages: OutboxMessage[]): Promise<void>;
  /** Busca mensagens pendentes com FOR UPDATE SKIP LOCKED para múltiplos publishers */
  claimDueMessages(now: Date, limit: number): Promise<OutboxMessage[]>;
  countPending(): Promise<number>;
}

export interface TransactionalContext {
  wallets: WalletRepositoryPort;
  transactions: WagerTransactionRepositoryPort;
  ledger: WalletLedgerRepositoryPort;
  inbox: InboxRepositoryPort;
  outbox: OutboxRepositoryPort;
}

export const UNIT_OF_WORK = Symbol('UNIT_OF_WORK');

export interface UnitOfWorkPort {
  /** Executa o callback dentro de uma transação SQL atômica (BEGIN ... COMMIT/ROLLBACK) */
  runInTransaction<T>(work: (ctx: TransactionalContext) => Promise<T>): Promise<T>;
  /** Acesso de leitura fora de transação explícita */
  readonly repositories: TransactionalContext;
}