import {
  CurrencyMismatchError,
  FailureCode,
  InsufficientFundsError,
  InvalidMoneyError,
} from '../errors/domain.errors';
import { Money } from '../value-objects/money.vo';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry.entity';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WalletMovementParams {
  ledgerEntryId: string;
  transactionId: string;
  amount: Money;
  at?: Date;
  insufficientFundsCode?: FailureCode;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: {
    id: string;
    playerId: string;
    initialBalance: Money;
    now?: Date;
  }): Wallet {
    if (props.initialBalance.isNegative()) {
      throw new InvalidMoneyError('Initial wallet balance cannot be negative');
    }
    const now = props.now ?? new Date();
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1, // version inicia em 1 após a criação
      now,
      now,
    );
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  debit(params: WalletMovementParams): WalletLedgerEntry {
    this.assertSameCurrency(params.amount);
    if (!params.amount.isPositive()) {
      throw new InvalidMoneyError('Debit amount must be strictly positive');
    }

    if (this._balance.isLessThan(params.amount)) {
      throw new InsufficientFundsError(
        `Insufficient balance: current ${this._balance.toString()}, required ${params.amount.toString()}`,
        params.insufficientFundsCode ?? FailureCode.INSUFFICIENT_FUNDS,
      );
    }

    const balanceBefore = this._balance;
    const balanceAfter = balanceBefore.subtract(params.amount);
    const now = params.at ?? new Date();

    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = now;

    return WalletLedgerEntry.create({
      id: params.ledgerEntryId,
      walletId: this.id,
      transactionId: params.transactionId,
      direction: LedgerDirection.Debit,
      money: params.amount,
      balanceBefore,
      balanceAfter,
      createdAt: now,
    });
  }

  credit(params: WalletMovementParams): WalletLedgerEntry {
    this.assertSameCurrency(params.amount);
    if (!params.amount.isPositive()) {
      throw new InvalidMoneyError('Credit amount must be strictly positive');
    }

    const balanceBefore = this._balance;
    const balanceAfter = balanceBefore.add(params.amount);
    const now = params.at ?? new Date();

    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = now;

    return WalletLedgerEntry.create({
      id: params.ledgerEntryId,
      walletId: this.id,
      transactionId: params.transactionId,
      direction: LedgerDirection.Credit,
      money: params.amount,
      balanceBefore,
      balanceAfter,
      createdAt: now,
    });
  }

  private assertSameCurrency(money: Money): void {
    if (this.currency !== money.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}