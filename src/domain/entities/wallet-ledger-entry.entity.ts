import { LedgerArithmeticError, InvalidMoneyError } from '../errors/domain.errors';
import { Money } from '../value-objects/money.vo';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt?: Date;
}

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) {}

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    if (!props.money.isPositive()) {
      throw new InvalidMoneyError('Ledger entry amount must be strictly positive (> 0.00)');
    }

    if (props.balanceBefore.isNegative() || props.balanceAfter.isNegative()) {
      throw new LedgerArithmeticError('Ledger balances cannot be negative');
    }

    const entry = new WalletLedgerEntry(
      props.id,
      props.walletId,
      props.transactionId,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceAfter,
      props.createdAt ?? new Date(),
    );

    if (!entry.isBalanced()) {
      throw new LedgerArithmeticError(
        `Unbalanced ledger entry: ${props.balanceBefore.toString()} ${
          props.direction === LedgerDirection.Credit ? '+' : '-'
        } ${props.money.toString()} !== ${props.balanceAfter.toString()}`,
      );
    }

    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.createdAt,
    );
  }

  /** balanceBefore ± money === balanceAfter */
  isBalanced(): boolean {
    const expectedAfter =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);

    return expectedAfter.equals(this.balanceAfter);
  }
}