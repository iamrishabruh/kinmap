/**
 * Privacy guardrails expressed as `no-restricted-syntax` selectors.
 *
 * These are a *second* line of defence. The first is `@family/observability`,
 * which drops denied keys at runtime. Lint exists so that a coordinate never
 * even reaches the redaction layer, because a reviewer reading a diff should be
 * able to see the violation without running anything.
 *
 * Kept in plain ESM (no TypeScript) so that ESLint can load it directly.
 */

/** Identifiers that carry, or are conventionally used to carry, a precise fix. */
export const COORDINATE_IDENTIFIERS = [
  'latitude',
  'longitude',
  'lat',
  'lng',
  'lon',
  'coord',
  'coords',
  'coordinate',
  'coordinates',
  'latLng',
  'latLon',
  'latitudeE7',
  'longitudeE7',
  'preciseLocation',
];

/** Receiver objects whose calls end up in a durable sink (logs/traces/metrics). */
export const SINK_OBJECTS = [
  'logger',
  'log',
  'console',
  'Sentry',
  'sentry',
  'tracer',
  'span',
  'metrics',
  'metric',
  'analytics',
];

/** Bare functions that behave like a sink call. */
export const SINK_FUNCTIONS = [
  'log',
  'logger',
  'debug',
  'info',
  'warn',
  'error',
  'trace',
  'captureException',
  'captureMessage',
  'addBreadcrumb',
  'putMetric',
  'recordEvent',
];

const alternation = (names) => names.join('|');

const COORD_RE = `/^(${alternation(COORDINATE_IDENTIFIERS)})$/`;
const SINK_OBJECT_RE = `/^(${alternation(SINK_OBJECTS)})$/`;
const SINK_FUNCTION_RE = `/^(${alternation(SINK_FUNCTIONS)})$/`;

const COORDINATE_MESSAGE =
  'Never pass a coordinate into a log, metric, trace or Sentry call. ' +
  'Emit a coarse geohash from @family/observability instead (spec §20).';

/**
 * Bans coordinate-shaped identifiers, property keys and string keys anywhere
 * inside a call whose receiver is a logging/telemetry sink.
 *
 * Covers `logger.info({ latitude })`, `console.error(event.longitude)`,
 * `Sentry.addBreadcrumb({ data: { coords } })` and `metrics.put({ 'lat': x })`.
 */
export const coordinateLoggingRules = [
  {
    selector: `CallExpression[callee.object.name=${SINK_OBJECT_RE}] Identifier[name=${COORD_RE}]`,
    message: COORDINATE_MESSAGE,
  },
  {
    selector: `CallExpression[callee.object.name=${SINK_OBJECT_RE}] Literal[value=${COORD_RE}]`,
    message: COORDINATE_MESSAGE,
  },
  {
    selector: `CallExpression[callee.name=${SINK_FUNCTION_RE}] Identifier[name=${COORD_RE}]`,
    message: COORDINATE_MESSAGE,
  },
  {
    selector: `CallExpression[callee.name=${SINK_FUNCTION_RE}] Literal[value=${COORD_RE}]`,
    message: COORDINATE_MESSAGE,
  },
  {
    // `JSON.stringify(locationEvent)` handed straight to a sink is the most
    // common way a whole event body leaks in one line.
    selector: `CallExpression[callee.object.name=${SINK_OBJECT_RE}] CallExpression[callee.object.name='JSON'][callee.property.name='stringify']`,
    message:
      'Do not stringify a payload into a telemetry call; pass a structured object so redaction can drop denied keys.',
  },
];

/**
 * Services run unattended and ship stdout straight to CloudWatch, so an ad-hoc
 * `console.log` is both unstructured and unredacted.
 */
export const noConsoleLogRules = [
  {
    selector:
      "CallExpression[callee.type='MemberExpression'][callee.object.name='console'][callee.property.name='log']",
    message:
      'console.log is banned in services. Use createLogger() from @family/observability so output is structured and redacted.',
  },
  {
    selector:
      "CallExpression[callee.type='MemberExpression'][callee.object.name='console'][callee.property.name='debug']",
    message:
      'console.debug is banned in services. Use createLogger().debug() from @family/observability.',
  },
];

export default {
  COORDINATE_IDENTIFIERS,
  SINK_OBJECTS,
  SINK_FUNCTIONS,
  coordinateLoggingRules,
  noConsoleLogRules,
};
