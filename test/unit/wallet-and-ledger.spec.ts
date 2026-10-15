import { describe, expect, it } from 'bun:test';
import { Wallet } from '../../src/domain/entities/wallet.entity';
import {
  LedgerDirection,
  WalletLedgerEntry,
} from '../../src/domain/entities/wallet-ledger-entry.entity';
import { Money } from '../../src/domain/value-objects/money.vo';
import {
  CurrencyMismatchError,
  FailureCode,
  InsufficientFundsError,
  LedgerArithmeticError,
} from '../../src/domain/errors/domain.errors';

describe('Wallet Aggregate & WalletLedgerEntry', () => {
  it('should open a wallet with version 1 and initial balance', () => {
    const wallet = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });

    expect(wallet.version).toBe(1);
    expect(wallet.balance.amount).toBe('100.00');
    expect(wallet.currency).toBe('BRL');
  });

  it('should debit balance, increment version, and return a balanced DEBIT ledger entry', () => {
    const wallet = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });

    const entry = wallet.debit({
      ledgerEntryId: 'ledger-1',
      transactionId: 'tx-1',
      amount: Money.from({ amount: '40.00', currency: 'BRL' }),
    });

    expect(wallet.balance.amount).toBe('60.00');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.amount).toBe('100.00');
    expect(entry.balanceAfter.amount).toBe('60.00');
    expect(entry.isBalanced()).toBe(true);
  });

  it('should credit balance, increment version, and return a balanced CREDIT ledger entry', () => {
    const wallet = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: Money.from({ amount: '60.00', currency: 'BRL' }),
    });

    const entry = wallet.credit({
      ledgerEntryId: 'ledger-2',
      transactionId: 'tx-2',
      amount: Money.from({ amount: '15.50', currency: 'BRL' }),
    });

    expect(wallet.balance.amount).toBe('75.50');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.balanceBefore.amount).toBe('60.00');
    expect(entry.balanceAfter.amount).toBe('75.50');
    expect(entry.isBalanced()).toBe(true);
  });

  it('should reject debit when balance is insufficient without mutating balance or version', () => {
    const wallet = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: Money.from({ amount: '50.00', currency: 'BRL' }),
    });

    expect(() =>
      wallet.debit({
        ledgerEntryId: 'ledger-1',
        transactionId: 'tx-1',
        amount: Money.from({ amount: '50.01', currency: 'BRL' }),
      }),
    ).toThrow(InsufficientFundsError);

    expect(wallet.balance.amount).toBe('50.00');
    expect(wallet.version).toBe(1);
  });

  it('should allow custom failureCode on debit for reversal negative balance', () => {
    const wallet = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: Money.from({ amount: '10.00', currency: 'BRL' }),
    });

    try {
      wallet.debit({
        ledgerEntryId: 'ledger-1',
        transactionId: 'tx-rollback',
        amount: Money.from({ amount: '50.00', currency: 'BRL' }),
        insufficientFundsCode: FailureCode.REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE,
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(InsufficientFundsError);
      expect((err as InsufficientFundsError).failureCode).toBe(
        FailureCode.REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE,
      );
    }
  });

  it('should reject operations with different currency on Wallet', () => {
    const wallet = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });

    expect(() =>
      wallet.credit({
        ledgerEntryId: 'ledger-1',
        transactionId: 'tx-1',
        amount: Money.from({ amount: '10.00', currency: 'USD' }),
      }),
    ).toThrow(CurrencyMismatchError);
  });

  it('should throw LedgerArithmeticError if a ledger entry is created with inconsistent math', () => {
    expect(() =>
      WalletLedgerEntry.create({
        id: 'ledger-bad',
        walletId: 'wallet-1',
        transactionId: 'tx-1',
        direction: LedgerDirection.Debit,
        money: Money.from({ amount: '20.00', currency: 'BRL' }),
        balanceBefore: Money.from({ amount: '100.00', currency: 'BRL' }),
        balanceAfter: Money.from({ amount: '90.00', currency: 'BRL' }), // errado: deveria ser 80.00
      }),
    ).toThrow(LedgerArithmeticError);
  });
});