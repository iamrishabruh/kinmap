import { z } from 'zod';

import {
  AppEnvSchema,
  CONFIG_GUARDRAILS,
  DeviceIdSchema,
  type LocationEngineConfig,
  type RetryPolicy,
  TrackingStateSchema,
} from '@family/contracts';

import { AppVersionSchema, IsoDateTimeSchema, PlatformSchema } from './common.js';

/**
 * Remote configuration endpoints.
 *
 * `GET /v1/configuration`
 * `GET /v1/configuration/bootstrap`
 *
 * Everything here is clamped to `CONFIG_GUARDRAILS` at the schema level, so a
 * hostile or buggy configuration cannot widen a privacy control or drain a
 * device's battery even before native code applies its own clamps.
 */

// ---------------------------------------------------------------------------
// Location engine configuration
// ---------------------------------------------------------------------------

export const RetryPolicySchema = z.strictObject({
  baseDelayMs: z.number().int().min(100).max(60_000),
  maxDelayMs: z.number().int().min(1_000).max(3_600_000),
  multiplier: z.number().min(1).max(10),
  jitterRatio: z.number().min(0).max(1),
  maxAttempts: z.number().int().min(1).max(20),
}) satisfies z.ZodType<RetryPolicy>;

/** Metres of movement before a new fix is recorded, one entry per state. */
export const DistanceFiltersSchema = z.record(
  TrackingStateSchema,
  z
    .number()
    .min(CONFIG_GUARDRAILS.distanceFilterMeters.min)
    .max(CONFIG_GUARDRAILS.distanceFilterMeters.max),
);

/** Target seconds between stored points, one entry per state. */
export const TargetFreshnessSecondsSchema = z.record(
  TrackingStateSchema,
  z
    .number()
    .min(CONFIG_GUARDRAILS.targetFreshnessSeconds.min)
    .max(CONFIG_GUARDRAILS.targetFreshnessSeconds.max),
);

export const LocationEngineConfigSchema = z.strictObject({
  configVersion: z.number().int().nonnegative(),
  distanceFilters: DistanceFiltersSchema,
  targetFreshnessSeconds: TargetFreshnessSecondsSchema,
  maxStaleSeconds: z
    .number()
    .min(CONFIG_GUARDRAILS.maxStaleSeconds.min)
    .max(CONFIG_GUARDRAILS.maxStaleSeconds.max),
  liveSessionMaxSeconds: z
    .number()
    .min(CONFIG_GUARDRAILS.liveSessionMaxSeconds.min)
    .max(CONFIG_GUARDRAILS.liveSessionMaxSeconds.max),
  liveSessionUpdateIntervalSeconds: z
    .number()
    .min(CONFIG_GUARDRAILS.liveSessionUpdateIntervalSeconds.min)
    .max(CONFIG_GUARDRAILS.liveSessionUpdateIntervalSeconds.max),
  lowBatteryThreshold: z
    .number()
    .min(CONFIG_GUARDRAILS.lowBatteryThreshold.min)
    .max(CONFIG_GUARDRAILS.lowBatteryThreshold.max),
  criticalBatteryThreshold: z
    .number()
    .min(CONFIG_GUARDRAILS.criticalBatteryThreshold.min)
    .max(CONFIG_GUARDRAILS.criticalBatteryThreshold.max),
  uploadBatchSize: z
    .number()
    .int()
    .min(CONFIG_GUARDRAILS.uploadBatchSize.min)
    .max(CONFIG_GUARDRAILS.uploadBatchSize.max),
  minUploadIntervalSeconds: z
    .number()
    .int()
    .min(CONFIG_GUARDRAILS.minUploadIntervalSeconds.min)
    .max(CONFIG_GUARDRAILS.minUploadIntervalSeconds.max),
  retry: RetryPolicySchema,
  maxAcceptableAccuracyMeters: z
    .number()
    .min(CONFIG_GUARDRAILS.maxAcceptableAccuracyMeters.min)
    .max(CONFIG_GUARDRAILS.maxAcceptableAccuracyMeters.max),
}) satisfies z.ZodType<LocationEngineConfig>;

// ---------------------------------------------------------------------------
// Feature flags
// ---------------------------------------------------------------------------

export const FeatureFlagsSchema = z.strictObject({
  liveSessionsEnabled: z.boolean(),
  geofencingEnabled: z.boolean(),
  historyEnabled: z.boolean(),
  batteryOptimizationPromptEnabled: z.boolean(),
  supportChatEnabled: z.boolean(),
});
export type FeatureFlags = z.infer<typeof FeatureFlagsSchema>;

// ---------------------------------------------------------------------------
// GET /v1/configuration
// ---------------------------------------------------------------------------

export const ConfigurationQuerySchema = z.strictObject({
  platform: PlatformSchema,
  appVersion: AppVersionSchema,
  osVersion: z.string().min(1).max(40),
  deviceId: DeviceIdSchema.nullable().default(null),
  /** Version the device already has; the server may answer "unchanged". */
  currentConfigVersion: z.coerce.number().int().nonnegative().nullable().default(null),
});
export type ConfigurationQuery = z.infer<typeof ConfigurationQuerySchema>;

export const ConfigurationResponseSchema = z.strictObject({
  configVersion: z.number().int().nonnegative(),
  environment: AppEnvSchema,
  engine: LocationEngineConfigSchema,
  features: FeatureFlagsSchema,
  /** Detached signature over the canonical JSON; verified before it is applied. */
  signature: z.string().min(1).max(4096),
  signatureKeyId: z.string().min(1).max(128),
  issuedAt: IsoDateTimeSchema,
  /** After this the device refetches; it never applies an expired config. */
  expiresAt: IsoDateTimeSchema,
  /** Seconds until the client should poll again. */
  refreshAfterSeconds: z.number().int().positive(),
});
export type ConfigurationResponse = z.infer<typeof ConfigurationResponseSchema>;

// ---------------------------------------------------------------------------
// GET /v1/configuration/bootstrap  — pre-authentication
// ---------------------------------------------------------------------------

/**
 * Served to an unauthenticated app on cold start, so it carries nothing
 * user-specific: no ids, no flags derived from an account.
 */
export const BootstrapConfigurationResponseSchema = z.strictObject({
  environment: AppEnvSchema,
  minimumSupportedAppVersion: AppVersionSchema,
  /** True when the running build must be updated before it may sign in. */
  updateRequired: z.boolean(),
  storeUrl: z.string().url().max(2048),
  termsVersion: z.string().min(1).max(32),
  privacyPolicyVersion: z.string().min(1).max(32),
  statusPageUrl: z.string().url().max(2048),
  maintenanceMessage: z.string().max(500).nullable(),
});
export type BootstrapConfigurationResponse = z.infer<typeof BootstrapConfigurationResponseSchema>;
