/**
 * Deterministic identifier factories.
 *
 * Real UUIDs make failing tests unreadable and diffs unstable. These produce
 * valid v4-shaped UUIDs from a counter, so `userId(1)` is always the same value
 * and an assertion failure names something a human can follow.
 */
function uuidFrom(prefix: string, n: number): string {
  const hex = n.toString(16).padStart(12, '0');
  const tag = prefix.slice(0, 4).padEnd(4, '0');
  return `${tag}0000-0000-4000-8000-${hex}`;
}

export const userId = (n: number): string => uuidFrom('user', n);
export const familyId = (n: number): string => uuidFrom('fam', n);
export const deviceId = (n: number): string => uuidFrom('dev', n);
export const placeId = (n: number): string => uuidFrom('plce', n);
export const eventId = (n: number): string => uuidFrom('evnt', n);
export const sessionId = (n: number): string => uuidFrom('sess', n);
export const invitationId = (n: number): string => uuidFrom('invt', n);

/** Monotonic sequence generator matching the per-device ordering contract. */
export function createSequence(start = 0): () => number {
  let n = start;
  return () => n++;
}
