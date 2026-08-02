import type { AppEnv } from '@family/contracts';
import type { LogLevel } from '@family/observability';

import { optionalAppEnv, optionalEnv, requireEnv, type EnvSource } from './runtime/env.js';

/**
 * Every table this service authorises against is required.
 *
 * The §18 checklist reads the account, the device registry, the membership row
 * and the subscription before it will reveal a position. Making any of them
 * optional would mean a stack that forgot one silently *skips* a check, so the
 * configuration fails closed instead: a missing name aborts the container.
 */

export type QueryConfig = {
  readonly env: AppEnv;
  readonly serviceName: string;
  readonly logLevel: LogLevel;
  readonly currentLocationsTable: string;
  readonly locationHistoryTable: string;
  readonly familyMembershipsTable: string;
  readonly usersTable: string;
  readonly devicesTable: string;
  readonly subscriptionsTable: string;
  readonly auditEventsTable: string;
  /** Optional: without it a fix is returned with no resolved place name. */
  readonly savedPlacesTable: string | null;
  readonly coordinateKeyId: string;
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

export function loadConfig(source: EnvSource): QueryConfig {
  const env = optionalAppEnv(source, 'APP_ENV', 'development');

  return {
    env,
    serviceName: optionalEnv(source, 'SERVICE_NAME') ?? 'location-query',
    logLevel: resolveLogLevel(source, env),
    currentLocationsTable: requireEnv(source, 'CURRENT_LOCATIONS_TABLE'),
    locationHistoryTable: requireEnv(source, 'LOCATION_HISTORY_TABLE'),
    familyMembershipsTable: requireEnv(source, 'FAMILY_MEMBERSHIPS_TABLE'),
    usersTable: requireEnv(source, 'USERS_TABLE'),
    devicesTable: requireEnv(source, 'DEVICES_TABLE'),
    subscriptionsTable: requireEnv(source, 'SUBSCRIPTIONS_TABLE'),
    auditEventsTable: requireEnv(source, 'AUDIT_EVENTS_TABLE'),
    savedPlacesTable: optionalEnv(source, 'SAVED_PLACES_TABLE'),
    coordinateKeyId: requireEnv(source, 'COORDINATE_KEY_ID'),
    userPoolId: optionalEnv(source, 'USER_POOL_ID'),
    userPoolClientId: optionalEnv(source, 'USER_POOL_CLIENT_ID'),
  };
}
