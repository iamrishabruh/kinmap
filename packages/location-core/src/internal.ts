/**
 * Dependency-free numeric and structural helpers shared by the modules in this
 * package. Kept in its own module so `config.ts` and `queue.ts` never have to
 * import one another (an ESM cycle around a class declaration is a footgun).
 *
 * Nothing here logs, and nothing here accepts or formats a coordinate.
 */

export type NumericRange = { readonly min: number; readonly max: number };

/** Clamp into `range`; non-finite input collapses to the conservative minimum. */
export function clampInto(value: number, range: NumericRange): number {
  if (!Number.isFinite(value)) return range.min;
  if (value < range.min) return range.min;
  if (value > range.max) return range.max;
  return value;
}

/** Read a finite number out of untrusted input, falling back when it is not one. */
export function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Clamp an arbitrary number into [0, 1]; used to defuse a hostile RNG. */
export function clampUnitInterval(value: number, fallback = 0.5): number {
  if (!Number.isFinite(value)) return fallback;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Exhaustiveness guard. Deliberately does NOT stringify the offending value:
 * unreachable branches in this package can be reached only by a malformed
 * event, and an event may carry a coordinate (spec §20).
 */
export function assertNever(value: never, message: string): never {
  void value;
  throw new Error(message);
}

/** Parse an ISO-8601 timestamp, returning null rather than NaN when invalid. */
export function parseIsoMs(value: string | null | undefined): number | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
