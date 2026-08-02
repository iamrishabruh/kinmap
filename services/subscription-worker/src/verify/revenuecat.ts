import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * RevenueCat webhook authentication.
 *
 * RevenueCat authenticates by echoing back a shared secret in the
 * `Authorization` header. There is no signature over the body, so the secret is
 * the only thing standing between an attacker and a forged "this user is now on
 * FAMILY_PLUS" event — which makes a constant-time comparison mandatory rather
 * than fastidious.
 *
 * `timingSafeEqual` throws on length mismatch, and that throw is itself a
 * length oracle. Both sides are therefore hashed to a fixed 32 bytes first, so
 * the comparison is constant-time in both the length and the content.
 */

/** Accepts `Bearer <secret>`, `Token <secret>` or the bare secret. */
export function extractBearerSecret(headerValue: string | undefined): string | null {
  if (headerValue === undefined) return null;
  const trimmed = headerValue.trim();
  if (trimmed.length === 0) return null;
  const match = /^(?:bearer|token)\s+(.+)$/i.exec(trimmed);
  return match?.[1]?.trim() ?? trimmed;
}

export function timingSafeStringEqual(a: string, b: string): boolean {
  const digestA = createHash('sha256').update(a, 'utf8').digest();
  const digestB = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(digestA, digestB);
}

export type RevenueCatVerificationResult =
  | { readonly verified: true }
  | { readonly verified: false; readonly reason: 'NOT_CONFIGURED' | 'MISSING' | 'MISMATCH' };

export function verifyRevenueCatWebhook(input: {
  authorizationHeader: string | undefined;
  /** The configured shared secret. Undefined means the provider is disabled. */
  expectedSecret: string | undefined;
}): RevenueCatVerificationResult {
  if (input.expectedSecret === undefined || input.expectedSecret.length === 0) {
    // Fail closed: an unconfigured provider accepts nothing.
    return { verified: false, reason: 'NOT_CONFIGURED' };
  }
  const presented = extractBearerSecret(input.authorizationHeader);
  if (presented === null) {
    return { verified: false, reason: 'MISSING' };
  }
  return timingSafeStringEqual(presented, input.expectedSecret)
    ? { verified: true }
    : { verified: false, reason: 'MISMATCH' };
}
