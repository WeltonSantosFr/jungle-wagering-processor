import Decimal from 'decimal.js';
import { CurrencyMismatchError, InvalidMoneyError } from '../errors/domain.errors';

export interface MoneyProps {
  amount: string; // decimal string, ex.: "25.00"
  currency: string; // ISO-4217
}

const STRICT_DECIMAL_REGEX = /^\d+\.\d{2}$/;
const CURRENCY_REGEX = /^[A-Z]{3}$/;

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    if (!props || typeof props.amount !== 'string' || typeof props.currency !== 'string') {
      throw new InvalidMoneyError('Money requires string amount and currency');
    }

    if (!CURRENCY_REGEX.test(props.currency)) {
      throw new InvalidMoneyError(`Invalid ISO-4217 currency code: '${props.currency}'`);
    }

    // Rejeita NaN, Infinity, notação científica, negativos, string vazia ou escala != 2 casas
    if (!STRICT_DECIMAL_REGEX.test(props.amount)) {
      throw new InvalidMoneyError(
        `Invalid money amount '${props.amount}'. Expected non-negative decimal string with exact scale of 2 (e.g., "25.00")`,
      );
    }

    return new Money(new Decimal(props.amount), props.currency);
  }

  /** Uso interno em cálculos controlados (ex.: reconciliação com diferença negativa ou negate) */
  private static fromInternalDecimal(value: Decimal, currency: string): Money {
    return new Money(value, currency);
  }

  static zero(currency: string): Money {
    return Money.from({ amount: '0.00', currency });
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.fromInternalDecimal(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.fromInternalDecimal(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return Money.fromInternalDecimal(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return {
      amount: this.value.toFixed(2),
      currency: this.currency,
    };
  }

  toString(): string {
    return `${this.value.toFixed(2)} ${this.currency}`;
  }

  get amount(): string {
    return this.value.toFixed(2);
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}