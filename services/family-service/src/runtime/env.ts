import { AppEnvSchema, type AppEnv } from '@family/contracts';

/**
 * Typed environment access that FAILS CLOSED.
 *
 * A service that boots with a missing table name would otherwise discover the
 * problem halfway through a request, after it had already decided that a caller
 * was authorised. Every required variable is therefore resolved once, at module
 * load, and a missing one aborts the container rather than degrading it.
 *
 * Nothing here ever logs a value: environment variables carry table names and
 * key ids, which are not secrets but are also not useful telemetry.
 */

export type EnvSource = Record<string, string | undefined>;

export class ConfigurationError extends Error {
  constructor(readonly variable: string) {
    super(`Required configuration variable ${variable} is missing or empty.`);
    this.name = 'ConfigurationError';
  }
}

function read(source: EnvSource, name: string): string | undefined {
  const value = source[name];
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** @throws ConfigurationError when the variable is absent or blank. */
export function requireEnv(source: EnvSource, name: string): string {
  const value = read(source, name);
  if (value === undefined) {
    throw new ConfigurationError(name);
  }
  return value;
}

export function optionalEnv(source: EnvSource, name: string): string | null {
  return read(source, name) ?? null;
}

export function optionalStringEnv(source: EnvSource, name: string, fallback: string): string {
  return read(source, name) ?? fallback;
}

/**
 * Integer with an inclusive range. An out-of-range or non-numeric value is a
 * configuration error, never a silent clamp: a typo that halves retention must
 * not deploy successfully.
 */
export function optionalIntEnv(
  source: EnvSource,
  name: string,
  fallback: number,
  bounds: { min: number; max: number },
): number {
  const raw = read(source, name);
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < bounds.min || parsed > bounds.max) {
    throw new ConfigurationError(name);
  }
  return parsed;
}

export function optionalAppEnv(source: EnvSource, name: string, fallback: AppEnv): AppEnv {
  const raw = read(source, name);
  if (raw === undefined) {
    return fallback;
  }
  const parsed = AppEnvSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigurationError(name);
  }
  return parsed.data;
}
