import { AppEnvSchema, type AppEnv } from '@family/contracts';

/** Typed configuration for services/audit-worker. Fails closed. */

export type EnvSource = Readonly<Record<string, string | undefined>>;

export class ConfigurationError extends Error {
  constructor(readonly variable: string) {
    super(`Required environment variable ${variable} is missing or empty.`);
    this.name = 'ConfigurationError';
  }
}

export function requireString(source: EnvSource, name: string): string {
  const raw = source[name];
  if (raw === undefined) throw new ConfigurationError(name);
  const trimmed = raw.trim();
  if (trimmed.length === 0) throw new ConfigurationError(name);
  return trimmed;
}

export function optionalString(source: EnvSource, name: string): string | undefined {
  const raw = source[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function optionalNumber(source: EnvSource, name: string, fallback: number): number {
  const raw = optionalString(source, name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function readAppEnv(source: EnvSource): AppEnv {
  const parsed = AppEnvSchema.safeParse(optionalString(source, 'APP_ENV') ?? 'development');
  return parsed.success ? parsed.data : 'development';
}

export type AuditWorkerConfig = {
  readonly appEnv: AppEnv;
  readonly serviceName: string;
  readonly metricsNamespace: string;
  readonly auditEventsTable: string;
  readonly usersTable: string;
  /**
   * How long an audit event is kept. Long enough to answer "who looked at me
   * last year", short enough that the trail is not itself a surveillance
   * archive.
   */
  readonly retentionDays: number;
};

export function loadConfig(source: EnvSource = process.env): AuditWorkerConfig {
  const appEnv = readAppEnv(source);
  return {
    appEnv,
    serviceName: optionalString(source, 'SERVICE_NAME') ?? 'audit-worker',
    metricsNamespace: optionalString(source, 'METRICS_NAMESPACE') ?? `Kinmap/${appEnv}`,
    auditEventsTable: requireString(source, 'AUDIT_EVENTS_TABLE'),
    usersTable: requireString(source, 'USERS_TABLE'),
    retentionDays: optionalNumber(source, 'AUDIT_RETENTION_DAYS', 365),
  };
}
