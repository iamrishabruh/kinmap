import { AppEnvSchema, type AppEnv } from '@family/contracts';

/**
 * Typed configuration for services/geofence-worker.
 *
 * Fails closed: a missing or blank required variable throws at module load, so
 * a misconfigured deployment dies at cold start instead of silently evaluating
 * geofences against the wrong table.
 */

export type EnvSource = Readonly<Record<string, string | undefined>>;

export class ConfigurationError extends Error {
  constructor(readonly variable: string) {
    // Names the variable, never its value: several of these hold ARNs and ids
    // that we would rather not see echoed into a cold-start log line.
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

export type GeofenceWorkerConfig = {
  readonly appEnv: AppEnv;
  readonly serviceName: string;
  readonly metricsNamespace: string;
  readonly savedPlacesTable: string;
  readonly familyMembershipsTable: string;
  readonly geofenceStateTable: string;
  readonly coordinateKeyId: string;
  readonly notificationCommandsQueueUrl: string;
  /** Geofence state rows outlive activity by this long before TTL reaps them. */
  readonly stateTtlDays: number;
  readonly arrivalDwellSeconds: number;
  readonly departureDwellSeconds: number;
};

export function loadConfig(source: EnvSource = process.env): GeofenceWorkerConfig {
  const appEnv = readAppEnv(source);
  return {
    appEnv,
    serviceName: optionalString(source, 'SERVICE_NAME') ?? 'geofence-worker',
    metricsNamespace: optionalString(source, 'METRICS_NAMESPACE') ?? `Kinmap/${appEnv}`,
    savedPlacesTable: requireString(source, 'SAVED_PLACES_TABLE'),
    familyMembershipsTable: requireString(source, 'FAMILY_MEMBERSHIPS_TABLE'),
    geofenceStateTable: requireString(source, 'GEOFENCE_STATE_TABLE'),
    coordinateKeyId: requireString(source, 'COORDINATE_KEY_ID'),
    notificationCommandsQueueUrl: requireString(source, 'NOTIFICATION_COMMANDS_QUEUE_URL'),
    stateTtlDays: optionalNumber(source, 'GEOFENCE_STATE_TTL_DAYS', 90),
    arrivalDwellSeconds: optionalNumber(source, 'GEOFENCE_ARRIVAL_DWELL_SECONDS', 60),
    departureDwellSeconds: optionalNumber(source, 'GEOFENCE_DEPARTURE_DWELL_SECONDS', 120),
  };
}
