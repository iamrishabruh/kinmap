import { AppEnvSchema, type AppEnv } from '@family/contracts';

/**
 * Typed configuration for services/deletion-worker. Fails closed: a deletion
 * job that cannot find one of its tables must not report success, so every
 * table name is required at cold start.
 */

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

export type DeletionWorkerConfig = {
  readonly appEnv: AppEnv;
  readonly serviceName: string;
  readonly metricsNamespace: string;
  readonly deletionJobsTable: string;
  readonly usersTable: string;
  readonly devicesTable: string;
  readonly familiesTable: string;
  readonly familyMembershipsTable: string;
  readonly currentLocationsTable: string;
  readonly locationHistoryTable: string;
  readonly savedPlacesTable: string;
  readonly notificationPreferencesTable: string;
  readonly liveSessionsTable: string;
  readonly geofenceStateTable: string;
  readonly deletionQueueUrl: string;
  readonly userPoolId: string;
  /**
   * HMAC pepper for the tombstone identifier. Without it the tombstone would be
   * a plain hash of the user id and therefore trivially re-identifiable.
   */
  readonly tombstonePepper: string;
  /** How far back to sweep history day partitions that TTL may have missed. */
  readonly historyLookbackDays: number;
  /** Work budget per invocation, so a huge account still makes progress. */
  readonly maxHistoryDaysPerInvocation: number;
  readonly maxDeletesPerSecond: number;
};

export function loadConfig(source: EnvSource = process.env): DeletionWorkerConfig {
  const appEnv = readAppEnv(source);
  return {
    appEnv,
    serviceName: optionalString(source, 'SERVICE_NAME') ?? 'deletion-worker',
    metricsNamespace: optionalString(source, 'METRICS_NAMESPACE') ?? `Kinmap/${appEnv}`,
    deletionJobsTable: requireString(source, 'DELETION_JOBS_TABLE'),
    usersTable: requireString(source, 'USERS_TABLE'),
    devicesTable: requireString(source, 'DEVICES_TABLE'),
    familiesTable: requireString(source, 'FAMILIES_TABLE'),
    familyMembershipsTable: requireString(source, 'FAMILY_MEMBERSHIPS_TABLE'),
    currentLocationsTable: requireString(source, 'CURRENT_LOCATIONS_TABLE'),
    locationHistoryTable: requireString(source, 'LOCATION_HISTORY_TABLE'),
    savedPlacesTable: requireString(source, 'SAVED_PLACES_TABLE'),
    notificationPreferencesTable: requireString(source, 'NOTIFICATION_PREFERENCES_TABLE'),
    liveSessionsTable: requireString(source, 'LIVE_SESSIONS_TABLE'),
    geofenceStateTable: requireString(source, 'GEOFENCE_STATE_TABLE'),
    deletionQueueUrl: requireString(source, 'DELETION_QUEUE_URL'),
    userPoolId: requireString(source, 'COGNITO_USER_POOL_ID'),
    tombstonePepper: requireString(source, 'DELETION_TOMBSTONE_PEPPER'),
    historyLookbackDays: optionalNumber(source, 'HISTORY_DELETION_LOOKBACK_DAYS', 400),
    maxHistoryDaysPerInvocation: optionalNumber(source, 'MAX_HISTORY_DAYS_PER_INVOCATION', 30),
    maxDeletesPerSecond: optionalNumber(source, 'MAX_DELETES_PER_SECOND', 200),
  };
}
