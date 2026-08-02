import type { AppEnv } from '@family/contracts';
import type { LogLevel } from '@family/observability';

import { optionalAppEnv, optionalEnv, requireEnv, type EnvSource } from './runtime/env.js';

/**
 * Wiring contract for the invitation service.
 *
 * `INVITE_LINK_BASE_URL` is required rather than defaulted: a link built against
 * the wrong host would send a real invitation token to a domain we do not
 * control, so guessing is not an acceptable failure mode.
 */

export type InvitationServiceConfig = {
  readonly env: AppEnv;
  readonly serviceName: string;
  readonly logLevel: LogLevel;
  readonly invitationsTable: string;
  readonly familiesTable: string;
  readonly familyMembershipsTable: string;
  readonly usersTable: string;
  readonly devicesTable: string;
  readonly subscriptionsTable: string;
  readonly auditEventsTable: string;
  readonly inviteLinkBaseUrl: string;
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

export function loadConfig(source: EnvSource): InvitationServiceConfig {
  const env = optionalAppEnv(source, 'APP_ENV', 'development');

  return {
    env,
    serviceName: optionalEnv(source, 'SERVICE_NAME') ?? 'invitation-service',
    logLevel: resolveLogLevel(source, env),
    invitationsTable: requireEnv(source, 'INVITATIONS_TABLE'),
    familiesTable: requireEnv(source, 'FAMILIES_TABLE'),
    familyMembershipsTable: requireEnv(source, 'FAMILY_MEMBERSHIPS_TABLE'),
    usersTable: requireEnv(source, 'USERS_TABLE'),
    devicesTable: requireEnv(source, 'DEVICES_TABLE'),
    subscriptionsTable: requireEnv(source, 'SUBSCRIPTIONS_TABLE'),
    auditEventsTable: requireEnv(source, 'AUDIT_EVENTS_TABLE'),
    inviteLinkBaseUrl: requireEnv(source, 'INVITE_LINK_BASE_URL'),
    userPoolId: optionalEnv(source, 'USER_POOL_ID'),
    userPoolClientId: optionalEnv(source, 'USER_POOL_CLIENT_ID'),
  };
}
