/**
 * @family/location-core — the shared, platform-independent tracking brain.
 *
 * Everything here is pure: no timers, no I/O, no `Date.now()`, no logging. The
 * host (React Native, or a test) supplies the clock, the storage and the
 * network; this package supplies the decisions. That is what makes the safety
 * and privacy invariants in spec §10, §11, §20 and §30 testable rather than
 * merely asserted.
 */
export * from './state-machine.js';
export * from './queue.js';
export * from './freshness.js';
export * from './config.js';
