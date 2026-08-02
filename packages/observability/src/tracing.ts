import { looksLikeCoordinateValue, scrubText } from './coordinates.js';
import { isRedactedKey } from './deny-list.js';

/**
 * OpenTelemetry helpers.
 *
 * The OTel API surface is described structurally rather than imported, so this
 * package stays dependency-free and works with whatever `@opentelemetry/api`
 * version a service pins — the shapes below are a subset of `Span`/`Tracer`.
 *
 * Span attributes are indexed and retained by the tracing backend, so they get
 * the same treatment as metric dimensions: denied keys are dropped and
 * coordinate-shaped values are refused.
 */

export type SpanAttributeValue = string | number | boolean | string[] | number[] | boolean[];

export type SpanAttributes = Record<string, SpanAttributeValue | null | undefined>;

/** Mirrors `@opentelemetry/api`'s SpanStatusCode. */
export const SPAN_STATUS = { UNSET: 0, OK: 1, ERROR: 2 } as const;
export type SpanStatusCode = (typeof SPAN_STATUS)[keyof typeof SPAN_STATUS];

export interface SpanLike {
  setAttribute(key: string, value: SpanAttributeValue): unknown;
  setAttributes?(attributes: Record<string, SpanAttributeValue>): unknown;
  setStatus(status: { code: SpanStatusCode; message?: string }): unknown;
  recordException?(exception: { name?: string; message: string }): unknown;
  addEvent?(name: string, attributes?: Record<string, SpanAttributeValue>): unknown;
  end(endTime?: number): void;
}

export interface TracerLike {
  startSpan(name: string, options?: { attributes?: Record<string, SpanAttributeValue> }): SpanLike;
}

function isScalarSafe(value: string | number | boolean): boolean {
  return typeof value === 'boolean' || !looksLikeCoordinateValue(value);
}

/**
 * Drops denied keys, drops coordinate-shaped values, and scrubs free text.
 * Never throws: a span is best-effort telemetry and must not fail a request.
 */
export function sanitizeAttributes(
  attributes: SpanAttributes | undefined,
): Record<string, SpanAttributeValue> {
  const sanitized: Record<string, SpanAttributeValue> = {};
  if (!attributes) return sanitized;

  for (const [key, value] of Object.entries(attributes)) {
    if (value === null || value === undefined) continue;
    if (isRedactedKey(key)) continue;

    if (Array.isArray(value)) {
      const entries = value as Array<string | number | boolean>;
      // A partially-safe array would silently change meaning, so drop the whole
      // attribute if any element looks like a coordinate.
      if (!entries.every((entry) => isScalarSafe(entry))) continue;
      sanitized[key] = entries.every((entry): entry is string => typeof entry === 'string')
        ? entries.map(scrubText)
        : (entries as SpanAttributeValue);
      continue;
    }

    if (!isScalarSafe(value)) continue;
    sanitized[key] = typeof value === 'string' ? scrubText(value) : value;
  }
  return sanitized;
}

/** Applies sanitised attributes to a span, one key at a time if needed. */
export function setSpanAttributes(span: SpanLike, attributes: SpanAttributes): void {
  const sanitized = sanitizeAttributes(attributes);
  if (typeof span.setAttributes === 'function') {
    span.setAttributes(sanitized);
    return;
  }
  for (const [key, value] of Object.entries(sanitized)) {
    span.setAttribute(key, value);
  }
}

/** Records an exception with a scrubbed message and no stack. */
export function recordSpanException(span: SpanLike, error: unknown): void {
  const name = error instanceof Error ? error.name : 'Error';
  const rawMessage = error instanceof Error ? error.message : String(error);
  const message = scrubText(rawMessage);

  span.recordException?.({ name, message });
  span.setStatus({ code: SPAN_STATUS.ERROR, message });
}

/**
 * Runs `fn` inside a span, sanitising attributes on the way in and exceptions
 * on the way out. The span always ends, including on throw.
 */
export async function withSpan<T>(
  tracer: TracerLike,
  name: string,
  attributes: SpanAttributes,
  fn: (span: SpanLike) => Promise<T> | T,
): Promise<T> {
  const span = tracer.startSpan(name, { attributes: sanitizeAttributes(attributes) });
  try {
    const result = await fn(span);
    span.setStatus({ code: SPAN_STATUS.OK });
    return result;
  } catch (error) {
    recordSpanException(span, error);
    throw error;
  } finally {
    span.end();
  }
}

/**
 * Adds a span event with sanitised attributes. Silently no-ops on a span
 * implementation that does not support events.
 */
export function addSpanEvent(span: SpanLike, name: string, attributes?: SpanAttributes): void {
  span.addEvent?.(name, sanitizeAttributes(attributes));
}
