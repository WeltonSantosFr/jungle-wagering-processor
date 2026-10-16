import { Wallet } from '../../../domain/entities/wallet.entity';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../domain/entities/wager-transaction.entity';
import {
  LedgerDirection,
  WalletLedgerEntry,
} from '../../../domain/entities/wallet-ledger-entry.entity';
import { InboxMessage } from '../../../domain/entities/inbox-message.entity';
import { OutboxMessage } from '../../../domain/entities/outbox-message.entity';
import { Money } from '../../../domain/value-objects/money.vo';
import { FailureCode } from '../../../domain/errors/domain.errors';
import { WalletOrmEntity } from '../entities/wallet.orm-entity';
import { WagerTransactionOrmEntity } from '../entities/wager-transaction.orm-entity';
import { WalletLedgerEntryOrmEntity } from '../entities/wallet-ledger-entry.orm-entity';
import { InboxMessageOrmEntity } from '../entities/inbox-message.orm-entity';
import { OutboxMessageOrmEntity } from '../entities/outbox-message.orm-entity';

export class WalletMapper {
  static toDomain(orm: WalletOrmEntity): Wallet {
    return Wallet.rehydrate({
      id: orm.id,
      playerId: orm.playerId,
      currency: orm.currency,
      balance: Money.from({ amount: orm.balance, currency: orm.currency }),
      version: orm.version,
      createdAt: orm.createdAt,
      updatedAt: orm.updatedAt,
    });
  }

  static toPersistence(domain: Wallet): WalletOrmEntity {
    const orm = new WalletOrmEntity();
    orm.id = domain.id;
    orm.playerId = domain.playerId;
    orm.currency = domain.currency;
    orm.balance = domain.balance.amount;
    orm.version = domain.version;
    orm.createdAt = domain.createdAt;
    orm.updatedAt = domain.updatedAt;
    return orm;
  }
}

export class WagerTransactionMapper {
  static toDomain(orm: WagerTransactionOrmEntity): WagerTransaction {
    return WagerTransaction.rehydrate({
      id: orm.id,
      providerId: orm.providerId,
      externalTransactionId: orm.externalTransactionId,
      idempotencyKey: orm.idempotencyKey,
      payloadHash: orm.payloadHash,
      walletId: orm.walletId,
      playerId: orm.playerId,
      roundId: orm.roundId,
      gameId: orm.gameId,
      kind: orm.kind as WagerTransactionKind,
      money: Money.from({ amount: orm.amount, currency: orm.currency }),
      referenceExternalTransactionId: orm.referenceExternalTransactionId ?? undefined,
      createdAt: orm.createdAt,
      status: orm.status as WagerTransactionStatus,
      referenceTransactionId: orm.referenceTransactionId ?? undefined,
      failureCode: (orm.failureCode as FailureCode) ?? undefined,
      processedAt: orm.processedAt ?? undefined,
      observedBalance: orm.observedBalance
        ? Money.from({ amount: orm.observedBalance, currency: orm.currency })
        : undefined,
      retryCount: orm.retryCount,
      nextRetryAt: orm.nextRetryAt ?? undefined,
    });
  }

  static toPersistence(domain: WagerTransaction): WagerTransactionOrmEntity {
    const orm = new WagerTransactionOrmEntity();
    orm.id = domain.id;
    orm.providerId = domain.providerId;
    orm.externalTransactionId = domain.externalTransactionId;
    orm.idempotencyKey = domain.idempotencyKey;
    orm.payloadHash = domain.payloadHash;
    orm.walletId = domain.walletId;
    orm.playerId = domain.playerId;
    orm.roundId = domain.roundId;
    orm.gameId = domain.gameId;
    orm.kind = domain.kind;
    orm.amount = domain.money.amount;
    orm.currency = domain.money.currency;
    orm.referenceExternalTransactionId = domain.referenceExternalTransactionId ?? null;
    orm.referenceTransactionId = domain.referenceTransactionId ?? null;
    orm.status = domain.status;
    orm.failureCode = domain.failureCode ?? null;
    orm.retryCount = domain.retryCount;
    orm.nextRetryAt = domain.nextRetryAt ?? null;
    orm.observedBalance = domain.observedBalance ? domain.observedBalance.amount : null;
    orm.createdAt = domain.createdAt;
    orm.processedAt = domain.processedAt ?? null;
    return orm;
  }
}

export class WalletLedgerEntryMapper {
  static toDomain(orm: WalletLedgerEntryOrmEntity): WalletLedgerEntry {
    return WalletLedgerEntry.rehydrate({
      id: orm.id,
      walletId: orm.walletId,
      transactionId: orm.transactionId,
      direction: orm.direction as LedgerDirection,
      money: Money.from({ amount: orm.amount, currency: orm.currency }),
      balanceBefore: Money.from({ amount: orm.balanceBefore, currency: orm.currency }),
      balanceAfter: Money.from({ amount: orm.balanceAfter, currency: orm.currency }),
      createdAt: orm.createdAt,
    });
  }

  static toPersistence(domain: WalletLedgerEntry): WalletLedgerEntryOrmEntity {
    const orm = new WalletLedgerEntryOrmEntity();
    orm.id = domain.id;
    orm.walletId = domain.walletId;
    orm.transactionId = domain.transactionId;
    orm.direction = domain.direction;
    orm.amount = domain.money.amount;
    orm.currency = domain.money.currency;
    orm.balanceBefore = domain.balanceBefore.amount;
    orm.balanceAfter = domain.balanceAfter.amount;
    orm.createdAt = domain.createdAt;
    return orm;
  }
}

export class InboxMessageMapper {
  static toDomain(orm: InboxMessageOrmEntity): InboxMessage {
    return InboxMessage.rehydrate({
      consumerName: orm.consumerName,
      messageId: orm.messageId,
      payloadHash: orm.payloadHash,
      receivedAt: orm.receivedAt,
      processedAt: orm.processedAt ?? undefined,
    });
  }

  static toPersistence(domain: InboxMessage): InboxMessageOrmEntity {
    const orm = new InboxMessageOrmEntity();
    orm.consumerName = domain.consumerName;
    orm.messageId = domain.messageId;
    orm.payloadHash = domain.payloadHash;
    orm.receivedAt = domain.receivedAt;
    orm.processedAt = domain.processedAt ?? null;
    return orm;
  }
}

export class OutboxMessageMapper {
  static toDomain(orm: OutboxMessageOrmEntity): OutboxMessage {
    return OutboxMessage.rehydrate({
      id: orm.id,
      aggregateId: orm.aggregateId,
      eventType: orm.eventType,
      payload: orm.payload,
      occurredAt: orm.occurredAt,
      attempts: orm.attempts,
      nextAttemptAt: orm.nextAttemptAt ?? undefined,
      publishedAt: orm.publishedAt ?? undefined,
    });
  }

  static toPersistence(domain: OutboxMessage): OutboxMessageOrmEntity {
    const orm = new OutboxMessageOrmEntity();
    orm.id = domain.id;
    orm.aggregateId = domain.aggregateId;
    orm.eventType = domain.eventType;
    orm.payload = { ...domain.payload };
    orm.occurredAt = domain.occurredAt;
    orm.attempts = domain.attempts;
    orm.nextAttemptAt = domain.nextAttemptAt ?? null;
    orm.publishedAt = domain.publishedAt ?? null;
    return orm;
  }
}