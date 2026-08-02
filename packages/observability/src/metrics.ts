import { looksLikeCoordinateValue } from './coordinates.js';
import { isRedactedKey } from './deny-list.js';
import { redact } from './redaction.js';

/**
 * CloudWatch Embedded Metric Format.
 *
 * Metric dimensions are the highest-risk telemetry surface in this product:
 * they are high-cardinality by design, they are queryable for months, and they
 * are trivially exported. A coordinate must therefore be impossible to put in
 * one — so `putMetric` throws rather than silently dropping, because a metric
 * that fails loudly in a test is better than one that leaks quietly in prod.
 */

export const EMF_VERSION = '0';

export type MetricUnit =
  'Count' | 'Milliseconds' | 'Seconds' | 'Bytes' | 'Kilobytes' | 'Megabytes' | 'Percent' | 'None';

export type MetricDimensions = Record<string, string | number | boolean>;

export type PutMetricInput = {
  namespace: string;
  name: string;
  value: number;
  unit?: MetricUnit;
  dimensions?: MetricDimensions;
  /** Non-dimensional context; redacted, never indexed by CloudWatch. */
  properties?: Record<string, unknown>;
  /** Epoch milliseconds. Defaults to now. */
  timestamp?: number;
};

export type EmfPayload = {
  _aws: {
    Timestamp: number;
    CloudWatchMetrics: Array<{
      Namespace: string;
      Dimensions: string[][];
      Metrics: Array<{ Name: string; Unit: MetricUnit }>;
    }>;
  };
} & Record<string, unknown>;

export type MetricSink = (payload: EmfPayload, serialized: string) => void;

/** CloudWatch hard limits. */
const MAX_DIMENSIONS = 30;
const MAX_DIMENSION_VALUE_LENGTH = 255;

/** Thrown when telemetry would have carried a precise location. */
export class CoordinateLeakError extends Error {
  constructor(
    message: string,
    readonly field: string,
  ) {
    super(message);
    this.name = 'CoordinateLeakError';
  }
}

/** Thrown for structurally invalid metrics (bad name, non-finite value). */
export class MetricValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MetricValidationError';
  }
}

/**
 * Rejects a dimension whose name is on the deny-list or whose value looks like
 * a coordinate. Exported so callers can pre-validate a dimension they build
 * dynamically.
 */
export function assertSafeDimension(name: string, value: string | number | boolean): void {
  if (isRedactedKey(name)) {
    throw new CoordinateLeakError(
      `Metric dimension "${name}" is on the redaction deny-list and must never be emitted.`,
      name,
    );
  }
  if (looksLikeCoordinateValue(name)) {
    throw new CoordinateLeakError('Metric dimension name looks like a coordinate.', name);
  }
  if (typeof value !== 'boolean' && looksLikeCoordinateValue(value)) {
    throw new CoordinateLeakError(
      `Metric dimension "${name}" has a coordinate-shaped value. Emit a coarse geohash instead (spec §20).`,
      name,
    );
  }
}

function normalizeDimensions(dimensions: MetricDimensions): Record<string, string> {
  const entries = Object.entries(dimensions);
  if (entries.length > MAX_DIMENSIONS) {
    throw new MetricValidationError(
      `A metric may carry at most ${MAX_DIMENSIONS} dimensions; received ${entries.length}.`,
    );
  }

  const normalized: Record<string, string> = {};
  for (const [name, value] of entries) {
    if (value === undefined || value === null) continue;
    assertSafeDimension(name, value);
    const text = String(value);
    if (text.length === 0) continue;
    if (text.length > MAX_DIMENSION_VALUE_LENGTH) {
      throw new MetricValidationError(
        `Metric dimension "${name}" exceeds ${MAX_DIMENSION_VALUE_LENGTH} characters.`,
      );
    }
    normalized[name] = text;
  }
  return normalized;
}

/** Builds the EMF document without emitting it. Useful in tests and batching. */
export function buildEmfPayload(input: PutMetricInput): EmfPayload {
  if (input.name.trim().length === 0) {
    throw new MetricValidationError('Metric name must not be empty.');
  }
  if (isRedactedKey(input.name)) {
    throw new CoordinateLeakError(
      `Metric name "${input.name}" is on the redaction deny-list.`,
      input.name,
    );
  }
  if (!Number.isFinite(input.value)) {
    throw new MetricValidationError(`Metric "${input.name}" must have a finite value.`);
  }

  const dimensions = normalizeDimensions(input.dimensions ?? {});
  const dimensionNames = Object.keys(dimensions);
  const properties = (redact(input.properties ?? {}) ?? {}) as Record<string, unknown>;

  return {
    _aws: {
      Timestamp: input.timestamp ?? Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: input.namespace,
          // A single dimension set: every dimension is required to resolve the
          // metric, which keeps cardinality predictable.
          Dimensions: dimensionNames.length > 0 ? [dimensionNames] : [[]],
          Metrics: [{ Name: input.name, Unit: input.unit ?? 'Count' }],
        },
      ],
    },
    ...properties,
    ...dimensions,
    [input.name]: input.value,
  };
}

type ConsoleLike = { log?: (...args: unknown[]) => void };
type StdoutLike = { write(chunk: string): unknown };

function resolveDefaultMetricSink(): MetricSink {
  const runtime = globalThis as { process?: { stdout?: StdoutLike }; console?: ConsoleLike };
  const stdout = runtime.process?.stdout;
  if (stdout && typeof stdout.write === 'function') {
    return (_payload, serialized) => {
      stdout.write(`${serialized}\n`);
    };
  }
  return (_payload, serialized) => {
    runtime.console?.log?.(serialized);
  };
}

/**
 * Emits one EMF record on stdout, where the Lambda log driver turns it into a
 * CloudWatch metric without an API call.
 *
 * @throws CoordinateLeakError if any dimension is (or looks like) a location.
 */
export function putMetric(input: PutMetricInput, sink?: MetricSink): EmfPayload {
  const payload = buildEmfPayload(input);
  const serialized = JSON.stringify(payload);
  (sink ?? resolveDefaultMetricSink())(payload, serialized);
  return payload;
}

/**
 * Binds a namespace and a set of default dimensions so call-sites stay short.
 */
export function createMetrics(options: {
  namespace: string;
  dimensions?: MetricDimensions;
  sink?: MetricSink;
}): {
  putMetric: (input: Omit<PutMetricInput, 'namespace'>) => EmfPayload;
  count: (name: string, value?: number, dimensions?: MetricDimensions) => EmfPayload;
  duration: (name: string, milliseconds: number, dimensions?: MetricDimensions) => EmfPayload;
} {
  const base = normalizeDimensions(options.dimensions ?? {});

  const emit = (input: Omit<PutMetricInput, 'namespace'>): EmfPayload =>
    putMetric(
      {
        ...input,
        namespace: options.namespace,
        dimensions: { ...base, ...(input.dimensions ?? {}) },
      },
      options.sink,
    );

  return {
    putMetric: emit,
    count: (name, value = 1, dimensions) =>
      emit({ name, value, unit: 'Count', dimensions: dimensions ?? {} }),
    duration: (name, milliseconds, dimensions) =>
      emit({ name, value: milliseconds, unit: 'Milliseconds', dimensions: dimensions ?? {} }),
  };
}
