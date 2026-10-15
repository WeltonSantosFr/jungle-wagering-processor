export enum FailureCode {
  INSUFFICIENT_FUNDS = 'INSUFFICIENT_FUNDS',
  REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE = 'REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE',
  REFERENCE_NOT_FOUND_TIMEOUT = 'REFERENCE_NOT_FOUND_TIMEOUT',
  INVALID_REFERENCE_KIND = 'INVALID_REFERENCE_KIND',
  INVALID_REFERENCE_STATUS = 'INVALID_REFERENCE_STATUS',
  REFERENCE_MISMATCH = 'REFERENCE_MISMATCH',
  REFERENCE_AMOUNT_MISMATCH = 'REFERENCE_AMOUNT_MISMATCH',
  REFERENCE_ALREADY_REVERSED = 'REFERENCE_ALREADY_REVERSED',
  CURRENCY_MISMATCH = 'CURRENCY_MISMATCH',
  WALLET_PLAYER_MISMATCH = 'WALLET_PLAYER_MISMATCH',
  PERMANENT_INFRASTRUCTURE_FAILURE = 'PERMANENT_INFRASTRUCTURE_FAILURE',
}

export class DomainError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class InvalidMoneyError extends DomainError {
  constructor(message: string) {
    super(message, 'INVALID_MONEY');
  }
}

export class CurrencyMismatchError extends DomainError {
  constructor(expected: string, actual: string) {
    super(`Currency mismatch: expected ${expected}, got ${actual}`, FailureCode.CURRENCY_MISMATCH);
  }
}

export class InsufficientFundsError extends DomainError {
  constructor(
    message = 'Insufficient funds in wallet',
    public readonly failureCode: FailureCode = FailureCode.INSUFFICIENT_FUNDS,
  ) {
    super(message, failureCode);
  }
}

export class InvalidTransactionStateError extends DomainError {
  constructor(currentStatus: string, targetAction: string) {
    super(
      `Cannot perform '${targetAction}' when transaction is in state '${currentStatus}'`,
      'INVALID_TRANSACTION_STATE',
    );
  }
}

export class IdempotencyConflictError extends DomainError {
  constructor(idempotencyKey: string) {
    super(
      `Idempotency conflict: key '${idempotencyKey}' was already used with a different payload`,
      'IDEMPOTENCY_CONFLICT',
    );
  }
}

export class LedgerArithmeticError extends DomainError {
  constructor(message: string) {
    super(message, 'LEDGER_ARITHMETIC_ERROR');
  }
}