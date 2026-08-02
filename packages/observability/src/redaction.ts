import { scrubText } from './coordinates.js';
import { isRedactedKey } from './deny-list.js';

/**
 * Deep redaction applied to every value that reaches a durable sink.
 *
 * Denied keys are DROPPED rather than masked. Traversal covers plain objects,
 * arrays, Maps, Sets, Errors and — critically — JSON encoded inside a string,
 * because `logger.info({ body: JSON.stringify(event) })` is the most common way
 * a whole location event escapes redaction.
 */

export type RedactOptions = {
  /** Guards against pathological structures. Default 12. */
  maxDepth?: number;
  /** Parse, redact and re-encode JSON-looking strings. Default true. */
  redactJsonStrings?: boolean;
  /** Scrub coordinates/emails out of free text. Default true. */
  scrubStrings?: boolean;
  /** Include `stack` when serialising an Error. Default false. */
  includeErrorStack?: boolean;
};

type ResolvedOptions = Required<RedactOptions>;

const DEFAULTS: ResolvedOptions = {
  maxDepth: 12,
  redactJsonStrings: true,
  scrubStrings: true,
  includeErrorStack: false,
};

export const MAX_DEPTH_PLACEHOLDER = '[max-depth]';
export const CIRCULAR_PLACEHOLDER = '[circular]';

/** Strings longer than this are not JSON-probed; the parse cost is not worth it. */
const MAX_JSON_PROBE_LENGTH = 64 * 1024;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

function looksLikeJson(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 2 || trimmed.length > MAX_JSON_PROBE_LENGTH) return false;
  return (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  );
}

function redactString(value: string, options: ResolvedOptions, depth: number): string {
  if (options.redactJsonStrings && looksLikeJson(value)) {
    try {
      const parsed: unknown = JSON.parse(value);
      const cleaned = redactValue(parsed, options, depth + 1, new WeakSet());
      return JSON.stringify(cleaned) ?? '';
    } catch {
      // Not actually JSON — fall through to text scrubbing.
    }
  }
  return options.scrubStrings ? scrubText(value) : value;
}

function redactError(
  error: Error,
  options: ResolvedOptions,
  depth: number,
  seen: WeakSet<object>,
): Record<string, unknown> {
  const serialized: Record<string, unknown> = {
    name: error.name,
    message: scrubText(error.message),
  };
  if (options.includeErrorStack && typeof error.stack === 'string') {
    serialized.stack = scrubText(error.stack);
  }
  // AppError and friends carry a `code`; surface it because it is safe and it
  // is the single most useful field when triaging.
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' || typeof code === 'number') {
    serialized.code = code;
  }
  const cause = (error as { cause?: unknown }).cause;
  if (cause !== undefined && depth < options.maxDepth) {
    serialized.cause = redactValue(cause, options, depth + 1, seen);
  }
  return serialized;
}

function redactValue(
  value: unknown,
  options: ResolvedOptions,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (depth > options.maxDepth) return MAX_DEPTH_PLACEHOLDER;

  if (value === null) return null;

  switch (typeof value) {
    case 'string':
      return redactString(value, options, depth);
    case 'number':
      return Number.isFinite(value) ? value : String(value);
    case 'boolean':
      return value;
    case 'bigint':
      return value.toString();
    case 'undefined':
    case 'function':
    case 'symbol':
      return undefined;
    default:
      break;
  }

  const objectValue = value as object;
  if (seen.has(objectValue)) return CIRCULAR_PLACEHOLDER;
  seen.add(objectValue);

  try {
    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? null : value.toISOString();
    }
    if (value instanceof Error) {
      return redactError(value, options, depth, seen);
    }
    if (Array.isArray(value)) {
      return value.map((entry) => redactValue(entry, options, depth + 1, seen));
    }
    if (value instanceof Set) {
      return [...value].map((entry) => redactValue(entry, options, depth + 1, seen));
    }
    if (value instanceof Map) {
      const result: Record<string, unknown> = {};
      for (const [key, entry] of value) {
        const keyText = String(key);
        if (isRedactedKey(keyText)) continue;
        result[keyText] = redactValue(entry, options, depth + 1, seen);
      }
      return result;
    }
    // Anything else — plain objects and class instances alike — is walked by
    // its own enumerable properties.
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (isRedactedKey(key)) continue;
      const redacted = redactValue(entry, options, depth + 1, seen);
      if (redacted !== undefined) result[key] = redacted;
    }
    return result;
  } finally {
    seen.delete(objectValue);
  }
}

/**
 * Returns a redacted deep copy. The input is never mutated, so a caller can
 * keep using the original object after logging it.
 */
export function redact<T>(value: T, options: RedactOptions = {}): unknown {
  return redactValue(value, { ...DEFAULTS, ...options }, 0, new WeakSet());
}

/** Convenience for the common "redact a context bag" case. */
export function redactRecord(
  value: Record<string, unknown> | undefined,
  options: RedactOptions = {},
): Record<string, unknown> {
  if (!value) return {};
  const redacted = redact(value, options);
  return isPlainRecord(redacted) ? redacted : {};
}

/**
 * Redacts and then serialises. Anything that still cannot be encoded (a rogue
 * getter that throws, a BigInt smuggled through a custom class) degrades to a
 * placeholder rather than taking down the caller.
 */
export function redactToJson(value: unknown, options: RedactOptions = {}): string {
  try {
    return JSON.stringify(redact(value, options)) ?? 'null';
  } catch {
    return JSON.stringify({ error: 'unserializable-log-payload' });
  }
}
