export interface LedgerCursorPayload {
  createdAt: string; // ISO string
  id: string;        // UUID
}

export function encodeLedgerCursor(payload: LedgerCursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeLedgerCursor(cursor: string): LedgerCursorPayload {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed = JSON.parse(raw) as LedgerCursorPayload;
    if (!parsed.createdAt || !parsed.id || Number.isNaN(Date.parse(parsed.createdAt))) {
      throw new Error('Invalid cursor structure');
    }
    return parsed;
  } catch {
    throw new Error('INVALID_PAGINATION_CURSOR');
  }
}