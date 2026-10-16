import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import {
  InboxRepositoryPort,
  OutboxRepositoryPort,
  PaginatedLedgerResult,
  TransactionalContext,
  UnitOfWorkPort,
  WagerTransactionRepositoryPort,
  WalletLedgerRepositoryPort,
  WalletRepositoryPort,
} from '../../../application/ports/persistence.ports';
import {
  decodeLedgerCursor,
  encodeLedgerCursor,
} from '../../../application/ports/cursor.util';
import { Wallet } from '../../../domain/entities/wallet.entity';
import { WagerTransaction } from '../../../domain/entities/wager-transaction.entity';
import { WalletLedgerEntry } from '../../../domain/entities/wallet-ledger-entry.entity';
import { InboxMessage } from '../../../domain/entities/inbox-message.entity';
import { OutboxMessage } from '../../../domain/entities/outbox-message.entity';
import { WalletOrmEntity } from '../entities/wallet.orm-entity';
import { WagerTransactionOrmEntity } from '../entities/wager-transaction.orm-entity';
import { WalletLedgerEntryOrmEntity } from '../entities/wallet-ledger-entry.orm-entity';
import { InboxMessageOrmEntity } from '../entities/inbox-message.orm-entity';
import { OutboxMessageOrmEntity } from '../entities/outbox-message.orm-entity';
import {
  InboxMessageMapper,
  OutboxMessageMapper,
  WagerTransactionMapper,
  WalletLedgerEntryMapper,
  WalletMapper,
} from '../mappers/persistence.mappers';

class TypeOrmWalletRepository implements WalletRepositoryPort {
  constructor(private readonly manager: EntityManager) {}

  async findById(id: string): Promise<Wallet | null> {
    const orm = await this.manager.findOne(WalletOrmEntity, { where: { id } });
    return orm ? WalletMapper.toDomain(orm) : null;
  }

  async findByIdForUpdate(id: string): Promise<Wallet | null> {
    const orm = await this.manager
      .createQueryBuilder(WalletOrmEntity, 'wallet')
      .setLock('pessimistic_write')
      .where('wallet.id = :id', { id })
      .getOne();

    return orm ? WalletMapper.toDomain(orm) : null;
  }

  async findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | null> {
    const orm = await this.manager.findOne(WalletOrmEntity, {
      where: { playerId, currency },
    });
    return orm ? WalletMapper.toDomain(orm) : null;
  }

  async save(wallet: Wallet): Promise<void> {
    const orm = WalletMapper.toPersistence(wallet);
    await this.manager.save(WalletOrmEntity, orm);
  }
}

class TypeOrmWagerTransactionRepository implements WagerTransactionRepositoryPort {
  constructor(private readonly manager: EntityManager) {}

  async findById(id: string): Promise<WagerTransaction | null> {
    const orm = await this.manager.findOne(WagerTransactionOrmEntity, { where: { id } });
    return orm ? WagerTransactionMapper.toDomain(orm) : null;
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | null> {
    const orm = await this.manager.findOne(WagerTransactionOrmEntity, {
      where: { idempotencyKey },
    });
    return orm ? WagerTransactionMapper.toDomain(orm) : null;
  }

  async findByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null> {
    const orm = await this.manager.findOne(WagerTransactionOrmEntity, {
      where: { providerId, externalTransactionId },
    });
    return orm ? WagerTransactionMapper.toDomain(orm) : null;
  }

  async existsProcessedReversalFor(
    referenceTransactionId: string,
    kind: 'REFUND' | 'ROLLBACK',
  ): Promise<boolean> {
    const count = await this.manager.count(WagerTransactionOrmEntity, {
      where: {
        referenceTransactionId,
        kind,
        status: 'PROCESSED',
      },
    });
    return count > 0;
  }

  async claimDuePendingReferences(now: Date, limit: number): Promise<WagerTransaction[]> {
    const rows = await this.manager
      .createQueryBuilder(WagerTransactionOrmEntity, 'tx')
      .setLock('pessimistic_write')
      .setOnLocked('skip_locked')
      .where('tx.status = :status', { status: 'PENDING_REFERENCE' })
      .andWhere('(tx.next_retry_at IS NULL OR tx.next_retry_at <= :now)', { now })
      .orderBy('tx.next_retry_at', 'ASC')
      .limit(limit)
      .getMany();

    return rows.map(WagerTransactionMapper.toDomain);
  }

  async save(tx: WagerTransaction): Promise<void> {
    const orm = WagerTransactionMapper.toPersistence(tx);
    await this.manager.save(WagerTransactionOrmEntity, orm);
  }
}

class TypeOrmWalletLedgerRepository implements WalletLedgerRepositoryPort {
  constructor(private readonly manager: EntityManager) {}

  async save(entry: WalletLedgerEntry): Promise<void> {
    const orm = WalletLedgerEntryMapper.toPersistence(entry);
    await this.manager.insert(WalletLedgerEntryOrmEntity, orm);
  }

  async findByWalletPaginated(
    walletId: string,
    limit: number,
    cursor?: string,
  ): Promise<PaginatedLedgerResult> {
    const qb = this.manager
      .createQueryBuilder(WalletLedgerEntryOrmEntity, 'entry')
      .where('entry.wallet_id = :walletId', { walletId });

    if (cursor) {
      const decoded = decodeLedgerCursor(cursor);
      qb.andWhere(
        '(entry.created_at > :cursorCreatedAt OR (entry.created_at = :cursorCreatedAt AND entry.id > :cursorId))',
        {
          cursorCreatedAt: new Date(decoded.createdAt),
          cursorId: decoded.id,
        },
      );
    }

    const rows = await qb
      .orderBy('entry.created_at', 'ASC')
      .addOrderBy('entry.id', 'ASC')
      .limit(limit + 1)
      .getMany();

    const hasNextPage = rows.length > limit;
    const sliced = hasNextPage ? rows.slice(0, limit) : rows;
    const items = sliced.map(WalletLedgerEntryMapper.toDomain);

    const lastItem = items[items.length - 1];
    const nextCursor =
      hasNextPage && lastItem
        ? encodeLedgerCursor({
            createdAt: lastItem.createdAt.toISOString(),
            id: lastItem.id,
          })
        : null;

    return { items, nextCursor };
  }

  async findAllByWalletOrdered(walletId: string): Promise<WalletLedgerEntry[]> {
    const rows = await this.manager
      .createQueryBuilder(WalletLedgerEntryOrmEntity, 'entry')
      .where('entry.wallet_id = :walletId', { walletId })
      .orderBy('entry.created_at', 'ASC')
      .addOrderBy('entry.id', 'ASC')
      .getMany();

    return rows.map(WalletLedgerEntryMapper.toDomain);
  }
}

class TypeOrmInboxRepository implements InboxRepositoryPort {
  constructor(private readonly manager: EntityManager) {}

  async findByConsumerAndMessageId(
    consumerName: string,
    messageId: string,
  ): Promise<InboxMessage | null> {
    const orm = await this.manager.findOne(InboxMessageOrmEntity, {
      where: { consumerName, messageId },
    });
    return orm ? InboxMessageMapper.toDomain(orm) : null;
  }

  async save(message: InboxMessage): Promise<void> {
    const orm = InboxMessageMapper.toPersistence(message);
    await this.manager.save(InboxMessageOrmEntity, orm);
  }
}

class TypeOrmOutboxRepository implements OutboxRepositoryPort {
  constructor(private readonly manager: EntityManager) {}

  async save(message: OutboxMessage): Promise<void> {
    const orm = OutboxMessageMapper.toPersistence(message);
    await this.manager.save(OutboxMessageOrmEntity, orm);
  }

  async saveMany(messages: OutboxMessage[]): Promise<void> {
    if (messages.length === 0) return;
    const orms = messages.map(OutboxMessageMapper.toPersistence);
    await this.manager.save(OutboxMessageOrmEntity, orms);
  }

  async claimDueMessages(now: Date, limit: number): Promise<OutboxMessage[]> {
    const rows = await this.manager
      .createQueryBuilder(OutboxMessageOrmEntity, 'outbox')
      .setLock('pessimistic_write')
      .setOnLocked('skip_locked')
      .where('outbox.published_at IS NULL')
      .andWhere('(outbox.next_attempt_at IS NULL OR outbox.next_attempt_at <= :now)', { now })
      .orderBy('outbox.occurred_at', 'ASC')
      .limit(limit)
      .getMany();

    return rows.map(OutboxMessageMapper.toDomain);
  }

  async countPending(): Promise<number> {
    return this.manager
      .createQueryBuilder(OutboxMessageOrmEntity, 'outbox')
      .where('outbox.published_at IS NULL')
      .getCount();
  }
}

@Injectable()
export class TypeOrmUnitOfWork implements UnitOfWorkPort {
  public readonly repositories: TransactionalContext;

  constructor(private readonly dataSource: DataSource) {
    this.repositories = this.createContext(this.dataSource.manager);
  }

  async runInTransaction<T>(work: (ctx: TransactionalContext) => Promise<T>): Promise<T> {
    return this.dataSource.transaction(async (transactionalEntityManager) => {
      const ctx = this.createContext(transactionalEntityManager);
      return work(ctx);
    });
  }

  private createContext(manager: EntityManager): TransactionalContext {
    return {
      wallets: new TypeOrmWalletRepository(manager),
      transactions: new TypeOrmWagerTransactionRepository(manager),
      ledger: new TypeOrmWalletLedgerRepository(manager),
      inbox: new TypeOrmInboxRepository(manager),
      outbox: new TypeOrmOutboxRepository(manager),
    };
  }
}