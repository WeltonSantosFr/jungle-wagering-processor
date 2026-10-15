import { describe, expect, it } from 'bun:test';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../src/domain/entities/wager-transaction.entity';
import { LedgerDirection } from '../../src/domain/entities/wallet-ledger-entry.entity';
import { Money } from '../../src/domain/value-objects/money.vo';
import {
  DomainError,
  FailureCode,
  InvalidTransactionStateError,
} from '../../src/domain/errors/domain.errors';
import { OutboxMessage } from '../../src/domain/entities/outbox-message.entity';
import { WagerTransactionProcessed } from '../../src/domain/events/integration.events';

function makeTx(
  kind: WagerTransactionKind,
  amount = '25.00',
  referenceExternalTransactionId?: string,
): WagerTransaction {
  return WagerTransaction.create({
    id: `tx-${kind.toLowerCase()}`,
    providerId: 'provider-a',
    externalTransactionId: `ext-${kind.toLowerCase()}`,
    idempotencyKey: `provider-a:ext-${kind.toLowerCase()}`,
    payloadHash: 'hash-123',
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: Money.from({ amount, currency: 'BRL' }),
    referenceExternalTransactionId,
  });
}

describe('WagerTransaction Domain Rules & State Machine', () => {
  it('should start in PENDING status and validate reference requirement for REFUND and ROLLBACK', () => {
    const bet = makeTx(WagerTransactionKind.Bet);
    expect(bet.status).toBe(WagerTransactionStatus.Pending);
    expect(bet.requiresReference()).toBe(false);
    expect(bet.affectsBalance()).toBe(true);

    expect(() => makeTx(WagerTransactionKind.Refund)).toThrow(DomainError);
    expect(() => makeTx(WagerTransactionKind.Rollback)).toThrow(DomainError);

    const refund = makeTx(WagerTransactionKind.Refund, '25.00', 'ext-bet');
    expect(refund.requiresReference()).toBe(true);
  });

  it('should indicate LOSS does not affect balance and allows 0.00 amount', () => {
    const loss = makeTx(WagerTransactionKind.Loss, '0.00');
    expect(loss.affectsBalance()).toBe(false);
    expect(() => loss.ledgerDirectionFor()).toThrow(DomainError);
  });

  it('should compute correct LedgerDirection for BET, WIN, REFUND, and ROLLBACK', () => {
    const bet = makeTx(WagerTransactionKind.Bet, '25.00');
    const win = makeTx(WagerTransactionKind.Win, '50.00');
    const refund = makeTx(WagerTransactionKind.Refund, '25.00', 'ext-bet');
    const rollbackBet = makeTx(WagerTransactionKind.Rollback, '25.00', 'ext-bet');
    const rollbackWin = makeTx(WagerTransactionKind.Rollback, '50.00', 'ext-win');

    expect(bet.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(win.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(refund.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);

    // ROLLBACK inverte a direção da referência
    expect(rollbackBet.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    expect(rollbackWin.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
  });

  it('should forbid transitions once in a terminal status (PROCESSED, REJECTED, FAILED)', () => {
    const bet = makeTx(WagerTransactionKind.Bet);
    bet.markProcessed(undefined, new Date(), Money.from({ amount: '75.00', currency: 'BRL' }));

    expect(bet.isTerminal()).toBe(true);
    expect(() => bet.reject(FailureCode.INSUFFICIENT_FUNDS)).toThrow(InvalidTransactionStateError);
    expect(() => bet.markPendingReference()).toThrow(InvalidTransactionStateError);

    const rejectedBet = makeTx(WagerTransactionKind.Bet);
    rejectedBet.reject(FailureCode.INSUFFICIENT_FUNDS);
    expect(rejectedBet.isTerminal()).toBe(true);
    expect(() => rejectedBet.markProcessed(undefined, new Date())).toThrow(
      InvalidTransactionStateError,
    );
  });

  it('should detect payload hash mismatches for idempotency checks', () => {
    const bet = makeTx(WagerTransactionKind.Bet);
    expect(bet.matchesPayload('hash-123')).toBe(true);
    expect(bet.matchesPayload('different-hash')).toBe(false);
  });

  it('should serialize IntegrationEvent and enqueue in OutboxMessage properly', () => {
    const bet = makeTx(WagerTransactionKind.Bet);
    bet.markProcessed(undefined, new Date());

    const event = WagerTransactionProcessed.from(
      bet,
      { amount: '75.00', currency: 'BRL' },
      { eventId: 'evt-1', correlationId: 'corr-1' },
    );

    const outbox = OutboxMessage.enqueue(event);
    expect(outbox.isPending()).toBe(true);
    expect(outbox.eventType).toBe('WagerTransactionProcessed');
    expect((outbox.payload as Record<string, unknown>).version).toBe(1);

    const now = new Date();
    outbox.scheduleRetry(now);
    expect(outbox.attempts).toBe(1);
    expect(outbox.isDue(now)).toBe(false);

    outbox.markPublished(new Date());
    expect(outbox.isPending()).toBe(false);
  });
});