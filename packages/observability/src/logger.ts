import type { AppEnv } from '@family/contracts';

import { scrubText } from './coordinates.js';
import { redactRecord, redactToJson, type RedactOptions } from './redaction.js';

/**
 * Structured JSON logging.
 *
 * Every record carries level / requestId / service / env so that a CloudWatch
 * Logs Insights query can pivot on any of them, and every context bag passes
 * through the shared redaction layer on the way out (spec §20).
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

export const LOG_LEVEL_SEVERITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export type LogContext = Record<string, unknown>;

export type LogRecord = {
  level: LogLevel;
  time: string;
  service: string;
  env: AppEnv;
  message: string;
  requestId?: string;
} & LogContext;

export type LogSink = (record: LogRecord, serialized: string) => void;

export type LoggerOptions = {
  service: string;
  env: AppEnv;
  /** Records below this level are dropped. Default `debug` outside production. */
  level?: LogLevel;
  requestId?: string;
  /** Merged into every record; redacted once, at construction time. */
  bindings?: LogContext;
  sink?: LogSink;
  now?: () => Date;
  redactOptions?: RedactOptions;
};

export interface Logger {
  readonly level: LogLevel;
  readonly service: string;
  readonly env: AppEnv;
  readonly requestId: string | undefined;
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  /** Returns a new logger with extra (redacted) bindings merged in. */
  child(bindings: LogContext): Logger;
  /** Returns a new logger stamping every record with `requestId`. */
  withRequestId(requestId: string): Logger;
  isLevelEnabled(level: LogLevel): boolean;
}

type ConsoleLike = Partial<Record<LogLevel | 'log', (...args: unknown[]) => void>>;
type StdoutLike = { write(chunk: string): unknown };

/**
 * Resolved lazily and structurally so this package needs neither `@types/node`
 * nor the DOM lib, and works unchanged in a Lambda and in Hermes.
 */
function resolveDefaultSink(): LogSink {
  const runtime = globalThis as { process?: { stdout?: StdoutLike }; console?: ConsoleLike };
  const stdout = runtime.process?.stdout;
  if (stdout && typeof stdout.write === 'function') {
    return (_record, serialized) => {
      stdout.write(`${serialized}\n`);
    };
  }
  return (record, serialized) => {
    const consoleLike = runtime.console;
    const write = consoleLike?.[record.level] ?? consoleLike?.log;
    write?.(serialized);
  };
}

const defaultSink: LogSink = (record, serialized) => {
  resolveDefaultSink()(record, serialized);
};

function defaultLevel(env: AppEnv): LogLevel {
  return env === 'production' ? 'info' : 'debug';
}

class StructuredLogger implements Logger {
  readonly level: LogLevel;
  readonly service: string;
  readonly env: AppEnv;
  readonly requestId: string | undefined;

  readonly #bindings: LogContext;
  readonly #sink: LogSink;
  readonly #now: () => Date;
  readonly #redactOptions: RedactOptions;
  readonly #severity: number;

  constructor(options: LoggerOptions) {
    this.service = options.service;
    this.env = options.env;
    this.level = options.level ?? defaultLevel(options.env);
    this.requestId = options.requestId;
    this.#redactOptions = options.redactOptions ?? {};
    this.#bindings = redactRecord(options.bindings, this.#redactOptions);
    this.#sink = options.sink ?? defaultSink;
    this.#now = options.now ?? (() => new Date());
    this.#severity = LOG_LEVEL_SEVERITY[this.level];
  }

  isLevelEnabled(level: LogLevel): boolean {
    return LOG_LEVEL_SEVERITY[level] >= this.#severity;
  }

  debug(message: string, context?: LogContext): void {
    this.#emit('debug', message, context);
  }

  info(message: string, context?: LogContext): void {
    this.#emit('info', message, context);
  }

  warn(message: string, context?: LogContext): void {
    this.#emit('warn', message, context);
  }

  error(message: string, context?: LogContext): void {
    this.#emit('error', message, context);
  }

  child(bindings: LogContext): Logger {
    return new StructuredLogger(this.#options({ bindings: { ...this.#bindings, ...bindings } }));
  }

  withRequestId(requestId: string): Logger {
    return new StructuredLogger(this.#options({ requestId }));
  }

  #options(overrides: Partial<LoggerOptions>): LoggerOptions {
    return {
      service: this.service,
      env: this.env,
      level: this.level,
      requestId: this.requestId,
      bindings: this.#bindings,
      sink: this.#sink,
      now: this.#now,
      redactOptions: this.#redactOptions,
      ...overrides,
    };
  }

  #emit(level: LogLevel, message: string, context?: LogContext): void {
    if (!this.isLevelEnabled(level)) return;

    // Errors are the one value callers routinely pass positionally; normalise
    // them so a thrown object never bypasses redaction.
    const safeContext = redactRecord(context, {
      ...this.#redactOptions,
      includeErrorStack: this.#redactOptions.includeErrorStack ?? level === 'error',
    });

    const record: LogRecord = {
      ...this.#bindings,
      ...safeContext,
      level,
      time: this.#now().toISOString(),
      service: this.service,
      env: this.env,
      // Messages are meant to be static, but interpolating "user at 37.77,-122.4"
      // into one is exactly the mistake this layer exists to survive.
      message: scrubText(message),
    };
    if (this.requestId !== undefined) record.requestId = this.requestId;

    // Context and message are already scrubbed; re-scrubbing here would only
    // risk mangling the placeholders the first pass inserted.
    const serialized = redactToJson(record, { ...this.#redactOptions, scrubStrings: false });
    this.#sink(record, serialized);
  }
}

/**
 * Creates a structured logger. Prefer one logger per service, then `child()`
 * per request rather than constructing new ones in hot paths.
 */
export function createLogger(options: LoggerOptions): Logger {
  return new StructuredLogger(options);
}

/**
 * Collects records in memory instead of writing them. Used by tests across the
 * repo to assert that nothing sensitive was emitted.
 */
export function createMemorySink(): { sink: LogSink; records: LogRecord[]; lines: string[] } {
  const records: LogRecord[] = [];
  const lines: string[] = [];
  return {
    records,
    lines,
    sink: (record, serialized) => {
      records.push(record);
      lines.push(serialized);
    },
  };
}
