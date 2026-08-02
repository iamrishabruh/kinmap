import { z } from 'zod';

import { AppEnvSchema, type AppEnv } from '@family/contracts';

/**
 * Typed configuration for the trigger function, failing closed on anything
 * required. Only variable names ever appear in the error — never a value.
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

const AuthEventsEnvironmentSchema = z.object({
  APP_ENV: AppEnvSchema,
  SERVICE_NAME: NonEmpty.default('auth-events'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  APP_DOMAIN: NonEmpty,
  USERS_TABLE: NonEmpty,

  /**
   * The policy versions a new account must have accepted. They change with a
   * deployment, which is why they are configuration rather than a database
   * lookup: the trigger must be able to reject a stale acceptance even if every
   * other dependency is unavailable.
   */
  TERMS_VERSION: NonEmpty.default('2026-01-01'),
  PRIVACY_POLICY_VERSION: NonEmpty.default('2026-01-01'),

  /**
   * Key for the email HMAC that backs the `byEmailHash` index. Optional so the
   * pool can be deployed before the secret exists; the fallback is keyed on the
   * user pool id, which is environment-scoped but not secret, so a dedicated
   * key should be configured before production traffic.
   */
  EMAIL_HASH_SECRET: NonEmpty.optional(),
});

export type AuthEventsConfig = {
  readonly env: AppEnv;
  readonly serviceName: string;
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error';
  readonly appDomain: string;
  readonly usersTable: string;
  readonly termsVersion: string;
  readonly privacyPolicyVersion: string;
  readonly emailHashSecret: string | null;
};

export type EnvironmentSource = Readonly<Record<string, string | undefined>>;

export function loadAuthEventsConfig(source: EnvironmentSource): AuthEventsConfig {
  const parsed = AuthEventsEnvironmentSchema.safeParse(source);
  if (!parsed.success) {
    const variables = [
      ...new Set(parsed.error.issues.map((issue) => issue.path.map(String).join('.'))),
    ].sort();
    throw new ConfigurationError(
      `The auth-events service is missing required configuration: ${variables.join(', ')}.`,
      variables,
    );
  }

  const value = parsed.data;
  return {
    env: value.APP_ENV,
    serviceName: value.SERVICE_NAME,
    logLevel: value.LOG_LEVEL,
    appDomain: value.APP_DOMAIN,
    usersTable: value.USERS_TABLE,
    termsVersion: value.TERMS_VERSION,
    privacyPolicyVersion: value.PRIVACY_POLICY_VERSION,
    emailHashSecret: value.EMAIL_HASH_SECRET ?? null,
  };
}
