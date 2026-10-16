import { randomBytes } from 'crypto';
import { DomainError } from '../../domain/errors/domain.errors';

/**
 * Gera um UUIDv7 (RFC 9562) ordenável cronologicamente sem dependências externas.
 */
export function uuidv7(nowMs: number = Date.now()): string {
  const bytes = randomBytes(16);
  const timeBigInt = BigInt(nowMs);

  // 48 bits de timestamp big-endian
  bytes[0] = Number((timeBigInt >> 40n) & 0xffn);
  bytes[1] = Number((timeBigInt >> 32n) & 0xffn);
  bytes[2] = Number((timeBigInt >> 24n) & 0xffn);
  bytes[3] = Number((timeBigInt >> 16n) & 0xffn);
  bytes[4] = Number((timeBigInt >> 8n) & 0xffn);
  bytes[5] = Number(timeBigInt & 0xffn);

  // version 7 (0111)
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  // variant RFC 4122 (10xx)
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export class ResourceNotFoundError extends DomainError {
  constructor(resource: string, identifier: string) {
    super(`${resource} '${identifier}' not found`, 'RESOURCE_NOT_FOUND');
  }
}

export class ResourceConflictError extends DomainError {
  constructor(message: string, code = 'RESOURCE_CONFLICT') {
    super(message, code);
  }
}

export function isPostgresUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === '23505'
  );
}