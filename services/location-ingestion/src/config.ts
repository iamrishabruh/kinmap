import { LIMITS, type AppEnv } from '@family/contracts';
import type { LogLevel } from '@family/observability';

import {
  optionalAppEnv,
  optionalEnv,
  optionalIntEnv,
  requireEnv,
  type EnvSource,
  optionalStringEnv,
} from './runtime/env.js';

/**
 * The wiring contract this service is deployed against.
 *
 * Table names arrive as `<NAME>_TABLE`, the coordinate CMK as `COORDINATE_KEY_ID`.
 * Every variable the pipeline cannot function without is required, so a stack
 * that forgot one fails at cold start rather than at the first request.
 */

export type IngestionConfig = {
  readonly env: AppEnv;
  readonly serviceName: string;
  readonly logLevel: LogLevel;
  readonly currentLocationsTable: string;
  readonly locationHistoryTable: string;
  readonly familyMembershipsTable: string;
  readonly idempotencyTable: string;
  readonly usersTable: string;
  /** Optional: when absent the token's device binding is the only device check. */
  readonly devicesTable: string | null;
  readonly coordinateKeyId: string;
  /** EMF namespace. Defaults to the convention the other services use. */
  readonly metricsNamespace: string;
  readonly locationEventBusName: string;
  readonly locationEventSource: string;
  readonly historyRetentionDays: number;
  /** Optional: only needed on a route that is not behind the JWT authorizer. */
  readonly userPoolId: string | null;
  readonly userPoolClientId: string | null;
};

const LOG_LEVELS: readonly string[] = ['debug', 'info', 'warn', 'error'];

function resolveLogLevel(source: EnvSource, env: AppEnv): LogLevel {
  const raw = optionalEnv(source, 'LOG_LEVEL');
  if (raw !== null && LOG_LEVELS.includes(raw)) {
    return raw as LogLevel;
  }
  return env === 'production' ? 'info' : 'debug';
}

export function loadConfig(source: EnvSource): IngestionConfig {
  const env = optionalAppEnv(source, 'APP_ENV', 'development');

  return {
    env,
    serviceName: optionalEnv(source, 'SERVICE_NAME') ?? 'location-ingestion',
    logLevel: resolveLogLevel(source, env),
    currentLocationsTable: requireEnv(source, 'CURRENT_LOCATIONS_TABLE'),
    locationHistoryTable: requireEnv(source, 'LOCATION_HISTORY_TABLE'),
    familyMembershipsTable: requireEnv(source, 'FAMILY_MEMBERSHIPS_TABLE'),
    idempotencyTable: requireEnv(source, 'IDEMPOTENCY_TABLE'),
    usersTable: requireEnv(source, 'USERS_TABLE'),
    devicesTable: optionalEnv(source, 'DEVICES_TABLE'),
    coordinateKeyId: requireEnv(source, 'COORDINATE_KEY_ID'),
    metricsNamespace: optionalStringEnv(source, 'METRICS_NAMESPACE', `Kinmap/${env}`),
    locationEventBusName: requireEnv(source, 'LOCATION_EVENT_BUS_NAME'),
    locationEventSource: optionalEnv(source, 'LOCATION_EVENT_SOURCE') ?? 'kinmap.location',
    historyRetentionDays: optionalIntEnv(
      source,
      'HISTORY_RETENTION_DAYS',
      LIMITS.HISTORY_RETENTION_DAYS,
      { min: 1, max: 400 },
    ),
    userPoolId: optionalEnv(source, 'USER_POOL_ID'),
    userPoolClientId: optionalEnv(source, 'USER_POOL_CLIENT_ID'),
  };
}
