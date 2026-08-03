import { z } from 'zod';

import { AppEnvSchema, type AppEnv } from '@family/contracts';

/**
 * Typed configuration for the API function.
 *
 * The helper FAILS CLOSED: a missing or malformed required variable throws at
 * module load, so the function never serves a request with, say, an undefined
 * table name silently resolving to the string "undefined". Only variable
 * *names* ever appear in the error — never a value, because an environment
 * block can hold identifiers we do not want in a CloudWatch log line.
 *
 * Names follow the shared wiring contract: a table reaches a service as its
 * logical name in SCREAMING_SNAKE_CASE with a `_TABLE` suffix.
 */

export class ConfigurationError extends Error {
  constructor(
    message: string,
    readonly variables: readonly string[],
  ) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

const NonEmpty = z.string().min(1);

const LogLevelSchema = z.enum(['debug', 'info', 'warn', 'error']);

/**
 * Only the variables this function actually reads are declared. Requiring a
 * variable the service does not use would turn an unrelated infrastructure
 * change into a cold-start failure.
 */
const ApiEnvironmentSchema = z.object({
  APP_ENV: AppEnvSchema,
  SERVICE_NAME: NonEmpty.default('api'),
  LOG_LEVEL: LogLevelSchema.default('info'),

  USER_POOL_ID: NonEmpty,
  USER_POOL_CLIENT_ID: NonEmpty,
  WEB_DOMAIN: NonEmpty,

  USERS_TABLE: NonEmpty,
  DEVICES_TABLE: NonEmpty,
  FAMILIES_TABLE: NonEmpty,
  FAMILY_MEMBERSHIPS_TABLE: NonEmpty,
  SUBSCRIPTIONS_TABLE: NonEmpty,
  AUDIT_EVENTS_TABLE: NonEmpty,
  IDEMPOTENCY_TABLE: NonEmpty,
  REMOTE_CONFIGURATION_TABLE: NonEmpty,
  DELETION_JOBS_TABLE: NonEmpty,

  /**
   * HMAC key for the audit trail's source-IP hash. Optional on purpose: with no
   * key we store `null` rather than an unsalted digest, because a bare SHA-256
   * of an IPv4 address is reversible by exhaustive search.
   */
  AUDIT_IP_HASH_SECRET: NonEmpty.optional(),
  /** Days between a deletion request and the irreversible purge. */
  ACCOUNT_DELETION_GRACE_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  /** How long an idempotency claim is replayable for. */
  IDEMPOTENCY_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(86_400),
  /** Retention applied to audit rows via the table's TTL attribute. */
  AUDIT_RETENTION_DAYS: z.coerce.number().int().min(30).max(3_650).default(365),
});

export type ApiEnvironment = z.infer<typeof ApiEnvironmentSchema>;

export type ApiTables = {
  readonly users: string;
  readonly devices: string;
  readonly families: string;
  readonly familyMemberships: string;
  readonly subscriptions: string;
  readonly auditEvents: string;
  readonly idempotency: string;
  readonly remoteConfiguration: string;
  readonly deletionJobs: string;
};

export type ApiConfig = {
  readonly env: AppEnv;
  readonly serviceName: string;
  readonly logLevel: z.infer<typeof LogLevelSchema>;
  readonly userPoolId: string;
  readonly userPoolClientId: string;
  readonly webDomain: string;
  readonly tables: ApiTables;
  readonly auditIpHashSecret: string | null;
  readonly accountDeletionGraceDays: number;
  readonly idempotencyTtlSeconds: number;
  /** EMF namespace. Defaults to the convention the other services use. */
  readonly metricsNamespace: string;
  readonly auditRetentionDays: number;
};

export type EnvironmentSource = Readonly<Record<string, string | undefined>>;

/**
 * Parses and validates the environment. Throws {@link ConfigurationError}
 * naming every variable that failed, so one deployment mistake is reported in
 * one go instead of one cold start at a time.
 */
export function loadApiConfig(source: EnvironmentSource): ApiConfig {
  const parsed = ApiEnvironmentSchema.safeParse(source);
  if (!parsed.success) {
    const variables = [
      ...new Set(parsed.error.issues.map((issue) => issue.path.map(String).join('.'))),
    ].sort();
    throw new ConfigurationError(
      `The api service is missing required configuration: ${variables.join(', ')}.`,
      variables,
    );
  }

  const value: ApiEnvironment = parsed.data;
  return {
    env: value.APP_ENV,
    serviceName: value.SERVICE_NAME,
    logLevel: value.LOG_LEVEL,
    userPoolId: value.USER_POOL_ID,
    userPoolClientId: value.USER_POOL_CLIENT_ID,
    webDomain: value.WEB_DOMAIN,
    tables: {
      users: value.USERS_TABLE,
      devices: value.DEVICES_TABLE,
      families: value.FAMILIES_TABLE,
      familyMemberships: value.FAMILY_MEMBERSHIPS_TABLE,
      subscriptions: value.SUBSCRIPTIONS_TABLE,
      auditEvents: value.AUDIT_EVENTS_TABLE,
      idempotency: value.IDEMPOTENCY_TABLE,
      remoteConfiguration: value.REMOTE_CONFIGURATION_TABLE,
      deletionJobs: value.DELETION_JOBS_TABLE,
    },
    auditIpHashSecret: value.AUDIT_IP_HASH_SECRET ?? null,
    accountDeletionGraceDays: value.ACCOUNT_DELETION_GRACE_DAYS,
    idempotencyTtlSeconds: value.IDEMPOTENCY_TTL_SECONDS,
    metricsNamespace: source['METRICS_NAMESPACE'] ?? `Kinmap/${value.APP_ENV}`,
    auditRetentionDays: value.AUDIT_RETENTION_DAYS,
  };
}
