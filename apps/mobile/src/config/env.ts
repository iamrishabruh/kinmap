import Constants from 'expo-constants';
import { z } from 'zod';

import { AppEnvSchema } from '@family/contracts';

/**
 * Public runtime configuration.
 *
 * Everything here comes from `app.config.ts` -> `extra`, which is embedded in
 * the shipped binary and therefore readable by anyone (spec §29). No secret may
 * ever be added to this module.
 *
 * Parsing is deliberately lenient: a missing value produces `undefined` rather
 * than a crash at import time, because a developer without a populated
 * `.env.local` must still be able to open the app and reach a screen that
 * explains what is missing. Call `requireEnv()` at the point of use when a
 * value is genuinely required — that fails loudly, in context, with a message
 * naming the variable to set.
 */

const ExtraSchema = z.object({
  appEnv: AppEnvSchema.catch('development'),
  apiBaseUrl: z.string().url().optional(),
  cognitoUserPoolId: z.string().optional(),
  cognitoClientId: z.string().optional(),
  cognitoDomain: z.string().optional(),
  awsRegion: z.string().optional(),
  sentryDsn: z.string().optional(),
  revenueCatIosKey: z.string().optional(),
  revenueCatAndroidKey: z.string().optional(),
  googleMapsPublicKey: z.string().optional(),
  googleIosClientId: z.string().optional(),
  googleWebClientId: z.string().optional(),
  supportEmail: z.string().optional(),
  privacyUrl: z.string().url().optional(),
  termsUrl: z.string().url().optional(),
});

export type Env = z.infer<typeof ExtraSchema> & {
  appVersion: string;
};

function readExtra(): Record<string, unknown> {
  const extra = Constants.expoConfig?.extra;
  return typeof extra === 'object' && extra !== null ? (extra as Record<string, unknown>) : {};
}

function buildEnv(): Env {
  const parsed = ExtraSchema.safeParse(readExtra());
  const base = parsed.success ? parsed.data : ExtraSchema.parse({});
  return {
    ...base,
    appVersion: Constants.expoConfig?.version ?? '0.0.0',
  };
}

export const env: Env = buildEnv();

/** Keys whose absence is a build/configuration error rather than a user error. */
type RequiredEnvKey = Extract<
  keyof Env,
  | 'apiBaseUrl'
  | 'googleIosClientId'
  | 'googleWebClientId'
  | 'privacyUrl'
  | 'termsUrl'
  | 'supportEmail'
>;

const ENV_SOURCE: Record<RequiredEnvKey, string> = {
  apiBaseUrl: 'API_BASE_URL',
  googleIosClientId: 'GOOGLE_IOS_CLIENT_ID',
  googleWebClientId: 'GOOGLE_WEB_CLIENT_ID',
  privacyUrl: 'PRIVACY_URL',
  termsUrl: 'TERMS_URL',
  supportEmail: 'SUPPORT_EMAIL',
};

/**
 * Reads a required public value, throwing a message that names the environment
 * variable to set. Never include the value in the message — some of these are
 * long identifiers that end up in crash reports.
 */
export function requireEnv(key: RequiredEnvKey): string {
  const value = env[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(
      `Missing public configuration "${key}". Set ${ENV_SOURCE[key]} in EAS ` +
        `environment variables or apps/mobile/.env.local and rebuild.`,
    );
  }
  return value;
}

export function hasEnv(key: RequiredEnvKey): boolean {
  const value = env[key];
  return typeof value === 'string' && value.length > 0;
}

export const isProduction = env.appEnv === 'production';
