/**
 * @family/validation — the validators every service shares.
 *
 * Three rules hold across this package and are covered by the tests in
 * `src/__tests__`:
 *
 *  1. No function here ever formats a coordinate into a string. Failures are
 *     reported as fixed identifiers (`LocationRejectionReason`,
 *     `HistoryRangeRejectionReason`) and fixed sentences, so any of them can go
 *     straight into a log line, a metric dimension, or an API error body.
 *  2. `coarseGeohash` is the only sanctioned location-derived value for
 *     observability, and it is hard-capped at a coarse precision.
 *  3. "Cannot tell" is never reported as "is a duplicate" — an unusable
 *     timestamp or coordinate makes `isDuplicate` return false, so real
 *     movement is never silently discarded.
 */

export * from './parse.js';
export * from './geo.js';
export * from './location.js';
export * from './history-range.js';
