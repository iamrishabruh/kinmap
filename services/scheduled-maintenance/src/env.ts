import { AppEnvSchema, LIMITS, type AppEnv } from '@family/contracts';

/** Typed configuration for services/scheduled-maintenance. Fails closed. */

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

export function optionalList(source: EnvSource, name: string): string[] {
  const raw = optionalString(source, name);
  if (raw === undefined) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function readAppEnv(source: EnvSource): AppEnv {
  const parsed = AppEnvSchema.safeParse(optionalString(source, 'APP_ENV') ?? 'development');
  return parsed.success ? parsed.data : 'development';
}

export type MaintenanceConfig = {
  readonly appEnv: AppEnv;
  readonly serviceName: string;
  readonly metricsNamespace: string;
  readonly liveSessionsTable: string;
  readonly invitationsTable: string;
  readonly currentLocationsTable: string;
  readonly locationHistoryTable: string;
  readonly devicesTable: string;
  /** Queues whose depth is published as a metric. */
  readonly monitoredQueueUrls: readonly string[];
  /** SNS platform applications swept for orphaned endpoints. */
  readonly platformApplicationArns: readonly string[];
  readonly historyRetentionDays: number;
  /** Rows any single job may examine before deferring the rest to the next tick. */
  readonly maxItemsPerJob: number;
  /**
   * Ceiling on destructive writes per second. A retention sweep must not be
   * able to consume a table's whole write capacity and throttle live traffic.
   */
  readonly maxWritesPerSecond: number;
};

export function loadConfig(source: EnvSource = process.env): MaintenanceConfig {
  const appEnv = readAppEnv(source);
  return {
    appEnv,
    serviceName: optionalString(source, 'SERVICE_NAME') ?? 'scheduled-maintenance',
    metricsNamespace: optionalString(source, 'METRICS_NAMESPACE') ?? `Kinmap/${appEnv}`,
    liveSessionsTable: requireString(source, 'LIVE_SESSIONS_TABLE'),
    invitationsTable: requireString(source, 'INVITATIONS_TABLE'),
    currentLocationsTable: requireString(source, 'CURRENT_LOCATIONS_TABLE'),
    locationHistoryTable: requireString(source, 'LOCATION_HISTORY_TABLE'),
    devicesTable: requireString(source, 'DEVICES_TABLE'),
    monitoredQueueUrls: optionalList(source, 'MONITORED_QUEUE_URLS'),
    platformApplicationArns: optionalList(source, 'PLATFORM_APPLICATION_ARNS'),
    historyRetentionDays: optionalNumber(
      source,
      'HISTORY_RETENTION_DAYS',
      LIMITS.HISTORY_RETENTION_DAYS,
    ),
    maxItemsPerJob: optionalNumber(source, 'MAX_ITEMS_PER_JOB', 1000),
    maxWritesPerSecond: optionalNumber(source, 'MAX_WRITES_PER_SECOND', 25),
  };
}
