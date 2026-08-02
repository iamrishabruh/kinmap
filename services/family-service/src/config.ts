import type { AppEnv } from '@family/contracts';
import type { LogLevel } from '@family/observability';

import { optionalAppEnv, optionalEnv, requireEnv, type EnvSource } from './runtime/env.js';

/**
 * Wiring contract for the family service.
 *
 * Membership is the platform's authorisation source of truth, so every table
 * the §18 checklist consults is required. The event bus is required too: a
 * removal that cannot be announced would leave a removed member's location
 * cached on other devices, which is the one outcome this service exists to
 * prevent.
 */

export type FamilyServiceConfig = {
  readonly env: AppEnv;
  readonly serviceName: string;
  readonly logLevel: LogLevel;
  readonly familiesTable: string;
  readonly familyMembershipsTable: string;
  readonly usersTable: string;
  readonly devicesTable: string;
  readonly subscriptionsTable: string;
  readonly auditEventsTable: string;
  readonly familyEventBusName: string;
  readonly familyEventSource: string;
  readonly safetyResourcesUrl: string | null;
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

export function loadConfig(source: EnvSource): FamilyServiceConfig {
  const env = optionalAppEnv(source, 'APP_ENV', 'development');

  return {
    env,
    serviceName: optionalEnv(source, 'SERVICE_NAME') ?? 'family-service',
    logLevel: resolveLogLevel(source, env),
    familiesTable: requireEnv(source, 'FAMILIES_TABLE'),
    familyMembershipsTable: requireEnv(source, 'FAMILY_MEMBERSHIPS_TABLE'),
    usersTable: requireEnv(source, 'USERS_TABLE'),
    devicesTable: requireEnv(source, 'DEVICES_TABLE'),
    subscriptionsTable: requireEnv(source, 'SUBSCRIPTIONS_TABLE'),
    auditEventsTable: requireEnv(source, 'AUDIT_EVENTS_TABLE'),
    familyEventBusName: requireEnv(source, 'FAMILY_EVENT_BUS_NAME'),
    familyEventSource: optionalEnv(source, 'FAMILY_EVENT_SOURCE') ?? 'kinmap.family',
    safetyResourcesUrl: optionalEnv(source, 'SAFETY_RESOURCES_URL'),
    userPoolId: optionalEnv(source, 'USER_POOL_ID'),
    userPoolClientId: optionalEnv(source, 'USER_POOL_CLIENT_ID'),
  };
}
