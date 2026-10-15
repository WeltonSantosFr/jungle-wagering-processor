import {
  DomainError,
  FailureCode,
  InvalidMoneyError,
  InvalidTransactionStateError,
} from '../errors/domain.errors';
import { Money } from '../value-objects/money.vo';
import { LedgerDirection } from './wallet-ledger-entry.entity';

export enum WagerTransactionKind {
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt?: Date;
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  observedBalance?: Money;
  retryCount?: number;
  nextRetryAt?: Date;
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
    private _observedBalance?: Money,
    private _retryCount: number = 0,
    private _nextRetryAt?: Date,
  ) {}

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (
      (props.kind === WagerTransactionKind.Refund ||
        props.kind === WagerTransactionKind.Rollback) &&
      !props.referenceExternalTransactionId
    ) {
      throw new DomainError(
        `${props.kind} requires referenceExternalTransactionId`,
        'MISSING_REFERENCE_EXTERNAL_ID',
      );
    }

    if (props.kind !== WagerTransactionKind.Loss && !props.money.isPositive()) {
      throw new InvalidMoneyError(`${props.kind} transaction amount must be strictly positive`);
    }

    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      props.createdAt ?? new Date(),
      WagerTransactionStatus.Pending,
    );
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.observedBalance,
      state.retryCount ?? 0,
      state.nextRetryAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }
  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }
  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }
  get processedAt(): Date | undefined {
    return this._processedAt;
  }
  get observedBalance(): Money | undefined {
    return this._observedBalance;
  }
  get retryCount(): number {
    return this._retryCount;
  }
  get nextRetryAt(): Date | undefined {
    return this._nextRetryAt;
  }

  markProcessed(referenceTransactionId: string | undefined, at: Date, observedBalance?: Money): void {
    this.assertNotTerminal('markProcessed');
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
    if (observedBalance) {
      this._observedBalance = observedBalance;
    }
  }

  markPendingReference(nextRetryAt?: Date): void {
    this.assertNotTerminal('markPendingReference');
    this._status = WagerTransactionStatus.PendingReference;
    this._nextRetryAt = nextRetryAt ?? new Date(Date.now() + 1000);
  }

  scheduleReferenceRetry(now: Date): void {
    this.assertNotTerminal('scheduleReferenceRetry');
    this._retryCount += 1;
    const backoffMs = Math.min(30_000, 500 * Math.pow(2, this._retryCount));
    this._nextRetryAt = new Date(now.getTime() + backoffMs);
  }

  reject(code: FailureCode, at: Date = new Date(), observedBalance?: Money): void {
    this.assertNotTerminal('reject');
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._processedAt = at;
    if (observedBalance) {
      this._observedBalance = observedBalance;
    }
  }

  fail(code: FailureCode, at: Date = new Date()): void {
    this.assertNotTerminal('fail');
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._processedAt = at;
  }

  isTerminal(): boolean {
    return (
      this._status === WagerTransactionStatus.Processed ||
      this._status === WagerTransactionStatus.Rejected ||
      this._status === WagerTransactionStatus.Failed
    );
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss && !this.money.isZero();
  }

  requiresReference(): boolean {
    return (
      this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback
    );
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new DomainError(
            'Reference transaction is required to determine ROLLBACK ledger direction',
            'MISSING_REFERENCE_FOR_DIRECTION',
          );
        }
        if (reference.kind === WagerTransactionKind.Bet) {
          return LedgerDirection.Credit; // Reverte BET (débito) -> CREDIT
        }
        if (
          reference.kind === WagerTransactionKind.Win ||
          reference.kind === WagerTransactionKind.Refund
        ) {
          return LedgerDirection.Debit; // Reverte WIN/REFUND (crédito) -> DEBIT
        }
        throw new DomainError(
          `Cannot determine rollback ledger direction for reference kind '${reference.kind}'`,
          FailureCode.INVALID_REFERENCE_KIND,
        );
      }
      case WagerTransactionKind.Loss:
        throw new DomainError('LOSS transaction does not generate ledger entries', 'LOSS_NO_LEDGER');
    }
  }

  private assertNotTerminal(action: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(this._status, action);
    }
  }
}