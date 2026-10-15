import { createHash } from 'crypto';
import { MoneyProps } from './money.vo';

export interface CanonicalWagerPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string | null;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === 'object') {
    const sortedKeys = Object.keys(value as Record<string, unknown>).sort();
    const result: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      const val = (value as Record<string, unknown>)[key];
      if (val !== undefined) {
        result[key] = canonicalize(val);
      }
    }
    return result;
  }
  return value;
}

export function computeCanonicalPayloadHash(payload: CanonicalWagerPayload): string {
  const normalized: CanonicalWagerPayload = {
    providerId: payload.providerId,
    externalTransactionId: payload.externalTransactionId,
    playerId: payload.playerId,
    walletId: payload.walletId,
    roundId: payload.roundId,
    gameId: payload.gameId,
    kind: payload.kind,
    money: {
      amount: payload.money.amount,
      currency: payload.money.currency,
    },
    referenceExternalTransactionId: payload.referenceExternalTransactionId ?? null,
  };

  const jsonString = JSON.stringify(canonicalize(normalized));
  return createHash('sha256').update(jsonString).digest('hex');
}