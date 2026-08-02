/**
 * Injectable clock. Backoff windows, queue expiry and freshness buckets are all
 * time-driven, so time has to be a dependency rather than an ambient global if
 * those behaviours are to be testable without sleeping.
 */
export type Clock = {
  /** Epoch milliseconds. */
  now(): number;
  /** RFC 3339 UTC instant, matching every `z.string().datetime()` in the contract. */
  nowIso(): string;
};

export const systemClock: Clock = {
  now: () => Date.now(),
  nowIso: () => new Date().toISOString(),
};

export function isoAfter(clock: Clock, offsetMs: number): string {
  return new Date(clock.now() + offsetMs).toISOString();
}

/** `NaN` for an unparsable timestamp so comparisons fail closed. */
export function isoToEpochMs(value: string): number {
  return Date.parse(value);
}
