import { createHash } from 'node:crypto';

import { AppError, type UserId } from '@family/contracts';
import { IdempotencyKeySchema } from '@family/schemas';

import type { IdempotencyStore } from '../repositories/idempotency.js';
import type { HttpRequest } from '../types.js';

/**
 * Idempotency for unsafe methods.
 *
 * The first request with a given key takes a conditional claim on the
 * Idempotency table; the stored response is replayed for every later request
 * that presents the same key with the same body.
 *
 * Two properties are load-bearing:
 *
 *  - The stored key is `<userId>#<clientKey>`. A key is therefore scoped to one
 *    principal, so a caller can neither collide with somebody else's key nor use
 *    key reuse to learn that another account made a particular request.
 *  - The request is fingerprinted by a hash of method, path and body. Reusing a
 *    key with a *different* body is a client bug, and answering it with the
 *    earlier response would silently drop a real request — so it is rejected
 *    with `IDEMPOTENCY_KEY_REUSED` instead.
 */

export const IDEMPOTENCY_HEADER = 'idempotency-key';
export const REPLAY_HEADER = 'idempotent-replay';

export type IdempotentOutcome = {
  readonly statusCode: number;
  readonly body: string;
  readonly replayed: boolean;
};

/** Reads and validates the client's key, or null when none was supplied. */
export function readIdempotencyKey(request: HttpRequest): string | null {
  const raw = request.headers[IDEMPOTENCY_HEADER];
  if (raw === undefined || raw.trim() === '') {
    return null;
  }
  const parsed = IdempotencyKeySchema.safeParse(raw.trim());
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', 'The idempotency key is not valid.', [
      { path: IDEMPOTENCY_HEADER, message: 'This value is not in the expected format.' },
    ]);
  }
  return parsed.data;
}

export function scopedKey(userId: UserId | null, clientKey: string): string {
  return `${userId ?? 'anonymous'}#${clientKey}`;
}

/**
 * A hash, never the body itself: the stored fingerprint must not become a copy
 * of a request payload sitting in a second table.
 */
export function fingerprint(request: HttpRequest): string {
  return createHash('sha256')
    .update(`${request.method}\n${request.path}\n${request.rawBody ?? ''}`, 'utf8')
    .digest('hex');
}

export async function withIdempotency(input: {
  store: IdempotencyStore;
  key: string;
  fingerprint: string;
  now: Date;
  run: () => Promise<{ statusCode: number; body: string }>;
}): Promise<IdempotentOutcome> {
  const claim = await input.store.claim({
    key: input.key,
    fingerprint: input.fingerprint,
    now: input.now,
  });

  if (claim.outcome === 'EXISTS') {
    const record = claim.record;
    if (record.fingerprint !== input.fingerprint) {
      throw new AppError(
        'IDEMPOTENCY_KEY_REUSED',
        'This idempotency key was already used for a different request.',
      );
    }
    if (record.status === 'COMPLETED' && record.statusCode !== null && record.body !== null) {
      return { statusCode: record.statusCode, body: record.body, replayed: true };
    }
    // The original request is still running. Answering now would either
    // duplicate the effect or invent a response the first call has not produced.
    throw new AppError('CONFLICT', 'An identical request is still being processed.');
  }

  let result: { statusCode: number; body: string };
  try {
    result = await input.run();
  } catch (error) {
    // The key is freed so the client can retry with it. Leaving the claim in
    // place would turn a transient failure into a permanently poisoned key.
    await input.store.release({ key: input.key });
    throw error;
  }

  await input.store.complete({
    key: input.key,
    statusCode: result.statusCode,
    body: result.body,
    now: input.now,
  });
  return { ...result, replayed: false };
}

/** Raised when a route requires a key and the caller did not supply one. */
export function missingIdempotencyKeyError(): AppError {
  return new AppError('VALIDATION_FAILED', 'This endpoint requires an idempotency key.', [
    { path: IDEMPOTENCY_HEADER, message: 'This field is required.' },
  ]);
}
