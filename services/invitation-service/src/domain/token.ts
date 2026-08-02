import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Invitation tokens (spec §17).
 *
 * An invitation token is a bearer credential that grants membership of a family,
 * and therefore visibility of people's positions. It is treated exactly like a
 * password:
 *
 *  - 32 bytes from the CSPRNG. At 256 bits, guessing is not a threat model.
 *  - Returned to the creator EXACTLY ONCE, at issue. Nothing else in the API
 *    ever returns it, and nothing writes it to a log, a metric, or a trace.
 *  - Only its SHA-256 hash is persisted, and the hash is the table's partition
 *    key — so a database dump yields no usable invitation links.
 *
 * A plain SHA-256 is the right primitive here (rather than a password KDF)
 * precisely because the input is 256 bits of uniform randomness: there is no
 * low-entropy guess space for an offline attacker to search.
 */

export const INVITATION_TOKEN_BYTES = 32;

/** Hex-encoded SHA-256: 64 characters, constant length for every input. */
export const INVITATION_HASH_LENGTH = 64;

export type IssuedInvitationToken = {
  /** Show once, hand to the share sheet, discard. NEVER persist this. */
  readonly token: string;
  /** Safe to store and to use as a key. */
  readonly tokenHash: string;
};

/** base64url: URL-safe, no padding, and matches `InvitationTokenSchema`. */
export function generateInvitationToken(
  random: (size: number) => Buffer = randomBytes,
): IssuedInvitationToken {
  const token = random(INVITATION_TOKEN_BYTES).toString('base64url');
  return { token, tokenHash: hashInvitationToken(token) };
}

export function hashInvitationToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Constant-time hash comparison.
 *
 * The stored hash is already the lookup key, so a mismatch here is rare — but
 * comparing with `===` would still leak, through timing, how many leading
 * characters of a guessed hash were correct. `timingSafeEqual` removes that
 * signal, and the unequal-length branch performs an equivalent comparison rather
 * than returning early, so length is not a side channel either.
 */
export function timingSafeHashEquals(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');

  if (leftBytes.length !== rightBytes.length) {
    // Burn a comparison of the same shape, then fail.
    timingSafeEqual(leftBytes, leftBytes);
    return false;
  }
  return timingSafeEqual(leftBytes, rightBytes);
}

/**
 * The universal link handed to the share sheet.
 *
 * Treat the result as a secret: it embeds the raw token. It is built here rather
 * than in the handler so there is one place that knows the token ends up in a
 * URL — the single most common way a credential like this leaks into an access
 * log or a referrer header.
 */
export function buildInviteUrl(baseUrl: string, token: string): string {
  const normalized = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  return `${normalized}/${encodeURIComponent(token)}`;
}
