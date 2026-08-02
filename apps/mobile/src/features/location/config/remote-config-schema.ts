import { z } from 'zod';

import { TRACKING_STATES, type TrackingState } from '@family/contracts';

/**
 * Wire schema for signed remote configuration (spec §30).
 *
 * Two properties matter more than the field list:
 *
 * 1. **Strict objects everywhere.** An unknown key is a hard parse failure, not
 *    a stripped field. That is what makes it impossible for the backend — or
 *    anyone who compromises it — to introduce a flag like `skipConsentCheck`
 *    and have older clients silently ignore the *name* while a future client
 *    honours it. New tunables require a client release.
 *
 * 2. **Numbers are unconstrained here and clamped afterwards.** If the schema
 *    rejected an out-of-range value outright, one bad field would discard the
 *    whole config and pin the device on stale settings. Instead the payload
 *    parses, `enforceGuardrails` corrects every offending field, and the
 *    corrections are reported so they show up in device health.
 */

/** A finite number. `z.number()` alone admits NaN and ±Infinity from JSON. */
const FiniteNumber = z.number().refine(Number.isFinite, 'Must be a finite number.');

const PerTrackingState = z.strictObject(
  Object.fromEntries(TRACKING_STATES.map((state) => [state, FiniteNumber])) as Record<
    TrackingState,
    typeof FiniteNumber
  >,
);

export const RemoteRetryPolicySchema = z.strictObject({
  baseDelayMs: FiniteNumber,
  maxDelayMs: FiniteNumber,
  multiplier: FiniteNumber,
  jitterRatio: FiniteNumber,
  maxAttempts: FiniteNumber,
});

export const RemoteEngineConfigSchema = z.strictObject({
  configVersion: z.number().int().nonnegative(),
  distanceFilters: PerTrackingState,
  targetFreshnessSeconds: PerTrackingState,
  maxStaleSeconds: FiniteNumber,
  liveSessionMaxSeconds: FiniteNumber,
  liveSessionUpdateIntervalSeconds: FiniteNumber,
  lowBatteryThreshold: FiniteNumber,
  criticalBatteryThreshold: FiniteNumber,
  uploadBatchSize: FiniteNumber,
  minUploadIntervalSeconds: FiniteNumber,
  retry: RemoteRetryPolicySchema,
  maxAcceptableAccuracyMeters: FiniteNumber,
});
export type RemoteEngineConfig = z.infer<typeof RemoteEngineConfigSchema>;

export const RemoteConfigSignatureSchema = z.strictObject({
  /** Only algorithms this build can actually verify are listed. */
  algorithm: z.enum(['HMAC-SHA256']),
  /** Must match the key id provisioned to this device at registration. */
  keyId: z.string().min(1).max(128),
  /** base64 detached signature over the canonical JSON of `config`. */
  value: z.string().min(1).max(512),
  signedAt: z.string().datetime(),
});
export type RemoteConfigSignature = z.infer<typeof RemoteConfigSignatureSchema>;

export const SignedRemoteConfigEnvelopeSchema = z.strictObject({
  config: RemoteEngineConfigSchema,
  signature: RemoteConfigSignatureSchema,
});
export type SignedRemoteConfigEnvelope = z.infer<typeof SignedRemoteConfigEnvelopeSchema>;

/**
 * Key names that would, if ever honoured, let configuration override a consent
 * or permission decision.
 *
 * `z.strictObject` already rejects all of them, so this list is a *tripwire*:
 * it exists so that the rejection is explicit and attributable in device health
 * rather than showing up as an anonymous schema error, and so that a future
 * author who loosens the schema hits a named constant in review.
 */
export const CONSENT_BYPASS_KEYS: readonly string[] = [
  'forceTracking',
  'forceSharing',
  'skipConsentCheck',
  'skipPermissionCheck',
  'bypassConsent',
  'ignoreSharingPaused',
  'silentMode',
  'hideSharingIndicator',
  'suppressForegroundNotification',
  'suppressNotification',
  'covertMode',
  'stealth',
  'trackWithoutConsent',
  'requirePermission',
  'requireConsent',
];

export type ConsentBypassScan = { found: string[] };

/** Recursive scan; a nested `{"overrides":{"forceTracking":true}}` is caught too. */
export function scanForConsentBypassKeys(value: unknown, depth = 0): ConsentBypassScan {
  if (depth > 8 || value === null || typeof value !== 'object') {
    return { found: [] };
  }
  const found = new Set<string>();
  const visit = (node: unknown, level: number): void => {
    if (level > 8 || node === null || typeof node !== 'object') {
      return;
    }
    if (Array.isArray(node)) {
      for (const entry of node) {
        visit(entry, level + 1);
      }
      return;
    }
    for (const [key, entry] of Object.entries(node as Record<string, unknown>)) {
      if (CONSENT_BYPASS_KEYS.includes(key)) {
        found.add(key);
      }
      visit(entry, level + 1);
    }
  };
  visit(value, depth);
  return { found: [...found] };
}
