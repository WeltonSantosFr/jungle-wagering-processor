import { describe, expect, it } from 'bun:test';
import { Money } from '../../src/domain/value-objects/money.vo';
import {
  CurrencyMismatchError,
  InvalidMoneyError,
} from '../../src/domain/errors/domain.errors';
import { computeCanonicalPayloadHash } from '../../src/domain/value-objects/payload-hash.util';

describe('Money Value Object', () => {
  it('should create valid Money with 2 decimal places and serialize properly', () => {
    const m = Money.from({ amount: '25.50', currency: 'BRL' });
    expect(m.amount).toBe('25.50');
    expect(m.currency).toBe('BRL');
    expect(m.toString()).toBe('25.50 BRL');
    expect(m.toJSON()).toEqual({ amount: '25.50', currency: 'BRL' });
    expect(m.isPositive()).toBe(true);
    expect(m.isZero()).toBe(false);
    expect(m.isNegative()).toBe(false);
  });

  it('should create zero Money properly', () => {
    const zero = Money.zero('BRL');
    expect(zero.amount).toBe('0.00');
    expect(zero.isZero()).toBe(true);
    expect(zero.isPositive()).toBe(false);
  });

  it('should perform exact decimal arithmetic without floating point drift', () => {
    const a = Money.from({ amount: '0.10', currency: 'BRL' });
    const b = Money.from({ amount: '0.20', currency: 'BRL' });
    const sum = a.add(b);

    expect(sum.amount).toBe('0.30');
    expect(sum.subtract(a).equals(b)).toBe(true);
  });

  it('should preserve immutability on arithmetic operations', () => {
    const original = Money.from({ amount: '100.00', currency: 'BRL' });
    const added = original.add(Money.from({ amount: '50.00', currency: 'BRL' }));

    expect(original.amount).toBe('100.00');
    expect(added.amount).toBe('150.00');
  });

  it('should support negate() for internal calculations', () => {
    const m = Money.from({ amount: '15.00', currency: 'BRL' });
    const neg = m.negate();
    expect(neg.isNegative()).toBe(true);
    expect(neg.amount).toBe('-15.00');
  });

  it('should reject invalid amounts (NaN, Infinity, scientific notation, wrong scale, negative)', () => {
    const invalidAmounts = [
      '',
      'NaN',
      'Infinity',
      '-Infinity',
      '1e5',
      '25',
      '25.5',
      '25.555',
      '-10.00',
      'abc',
      '10,00',
    ];

    for (const amount of invalidAmounts) {
      expect(() => Money.from({ amount, currency: 'BRL' })).toThrow(InvalidMoneyError);
    }
  });

  it('should reject invalid currency codes', () => {
    const invalidCurrencies = ['', 'br', 'BRLX', '123', 'bRl'];
    for (const currency of invalidCurrencies) {
      expect(() => Money.from({ amount: '10.00', currency })).toThrow(InvalidMoneyError);
    }
  });

  it('should throw CurrencyMismatchError when operating across different currencies', () => {
    const brl = Money.from({ amount: '10.00', currency: 'BRL' });
    const usd = Money.from({ amount: '10.00', currency: 'USD' });

    expect(() => brl.add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.isLessThan(usd)).toThrow(CurrencyMismatchError);
    expect(brl.equals(usd)).toBe(false);
  });
});

describe('Canonical Payload Hash', () => {
  const basePayload = {
    providerId: 'provider-a',
    externalTransactionId: 'tx-100',
    playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
    walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
  };

  it('should produce identical hashes regardless of property order', () => {
    const hash1 = computeCanonicalPayloadHash(basePayload);
    const hash2 = computeCanonicalPayloadHash({
      money: { currency: 'BRL', amount: '25.00' },
      kind: 'BET',
      gameId: 'fortune-chimp',
      roundId: 'round-1',
      walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
      playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
      externalTransactionId: 'tx-100',
      providerId: 'provider-a',
    });

    expect(hash1).toBe(hash2);
  });

  it('should produce a different hash when any business field changes', () => {
    const hash1 = computeCanonicalPayloadHash(basePayload);
    const hashDifferentAmount = computeCanonicalPayloadHash({
      ...basePayload,
      money: { amount: '25.01', currency: 'BRL' },
    });
    const hashDifferentKind = computeCanonicalPayloadHash({
      ...basePayload,
      kind: 'WIN',
    });

    expect(hash1).not.toBe(hashDifferentAmount);
    expect(hash1).not.toBe(hashDifferentKind);
  });
});