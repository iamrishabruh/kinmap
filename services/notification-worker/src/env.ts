import { AppEnvSchema, type AppEnv } from '@family/contracts';

/**
 * Typed configuration for services/notification-worker. Fails closed on a
 * missing required variable so a misconfigured deployment cannot silently
 * deliver to the wrong platform application or skip deduplication.
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

export type NotificationWorkerConfig = {
  readonly appEnv: AppEnv;
  readonly serviceName: string;
  readonly metricsNamespace: string;
  readonly devicesTable: string;
  readonly notificationPreferencesTable: string;
  readonly familyMembershipsTable: string;
  readonly liveSessionsTable: string;
  readonly savedPlacesTable: string;
  readonly usersTable: string;
  /** Deduplication claims and rate-limit counters share the idempotency table. */
  readonly idempotencyTable: string;
  readonly apnsPlatformApplicationArn: string | undefined;
  readonly apnsSandboxPlatformApplicationArn: string | undefined;
  readonly fcmPlatformApplicationArn: string | undefined;
  readonly deduplicationTtlSeconds: number;
  readonly rateLimitPerMinute: number;
};

export function loadConfig(source: EnvSource = process.env): NotificationWorkerConfig {
  const appEnv = readAppEnv(source);
  return {
    appEnv,
    serviceName: optionalString(source, 'SERVICE_NAME') ?? 'notification-worker',
    metricsNamespace: optionalString(source, 'METRICS_NAMESPACE') ?? `Kinmap/${appEnv}`,
    devicesTable: requireString(source, 'DEVICES_TABLE'),
    notificationPreferencesTable: requireString(source, 'NOTIFICATION_PREFERENCES_TABLE'),
    familyMembershipsTable: requireString(source, 'FAMILY_MEMBERSHIPS_TABLE'),
    liveSessionsTable: requireString(source, 'LIVE_SESSIONS_TABLE'),
    savedPlacesTable: requireString(source, 'SAVED_PLACES_TABLE'),
    usersTable: requireString(source, 'USERS_TABLE'),
    idempotencyTable: requireString(source, 'IDEMPOTENCY_TABLE'),
    apnsPlatformApplicationArn: optionalString(source, 'APNS_PLATFORM_APPLICATION_ARN'),
    apnsSandboxPlatformApplicationArn: optionalString(
      source,
      'APNS_SANDBOX_PLATFORM_APPLICATION_ARN',
    ),
    fcmPlatformApplicationArn: optionalString(source, 'FCM_PLATFORM_APPLICATION_ARN'),
    deduplicationTtlSeconds: optionalNumber(source, 'NOTIFICATION_DEDUPE_TTL_SECONDS', 24 * 3600),
    rateLimitPerMinute: optionalNumber(source, 'NOTIFICATION_RATE_LIMIT_PER_MINUTE', 20),
  };
}
