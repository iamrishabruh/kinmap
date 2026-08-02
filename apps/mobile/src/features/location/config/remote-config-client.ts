import { type LocationEngineConfig } from '@family/contracts';

import { type Clock, isoToEpochMs, systemClock } from '../internal/clock';
import { type LocationStore } from '../storage/types';

import { cloneEngineConfig, SAFE_DEFAULT_ENGINE_CONFIG } from './defaults';
import { type ConfigAdjustment, enforceGuardrails, isWithinGuardrails } from './guardrails';
import {
  scanForConsentBypassKeys,
  type SignedRemoteConfigEnvelope,
  SignedRemoteConfigEnvelopeSchema,
} from './remote-config-schema';
import {
  canonicalPayloadFor,
  MAX_SIGNATURE_AGE_SECONDS,
  type RemoteConfigVerifier,
} from './signature';

/**
 * Fetches, verifies, clamps and caches the engine's remote configuration
 * (spec §30).
 *
 * Ordering is the whole design: **verify, then parse, then clamp, then apply.**
 * Nothing from the network reaches `enforceGuardrails` until its signature has
 * been checked, and nothing reaches the native engine until it has been
 * clamped. Any failure at any step leaves the previously cached config — or the
 * built-in safe defaults — in place.
 *
 * Remote configuration tunes *how* the engine samples. It can never decide
 * *whether* the engine runs: that decision lives in `engine/consent.ts` and is
 * derived only from the user's own choices and the OS permission state.
 */

export const CONFIG_REJECTION_REASONS = [
  'NO_VERIFIER',
  'SIGNATURE_INVALID',
  'SIGNATURE_STALE',
  'SCHEMA_INVALID',
  'CONSENT_BYPASS_ATTEMPT',
  'VERSION_REGRESSION',
  'TRANSPORT_ERROR',
  'GUARDRAIL_FAILURE',
] as const;

export type ConfigRejectionReason = (typeof CONFIG_REJECTION_REASONS)[number];

export type ConfigSource = 'SAFE_DEFAULTS' | 'CACHED' | 'REMOTE_SIGNED';

export type ResolvedEngineConfig = {
  config: LocationEngineConfig;
  source: ConfigSource;
  adjustments: ConfigAdjustment[];
  rejection: ConfigRejectionReason | null;
};

export interface RemoteConfigTransport {
  /**
   * @returns the signed envelope, or null when the backend reports the device
   * is already on the current version (HTTP 304).
   * @throws on any transport-level failure; the client falls back to cache.
   */
  fetchConfig(input: { currentVersion: number | null }): Promise<SignedRemoteConfigEnvelope | null>;
}

export type RemoteConfigClientDeps = {
  store: LocationStore;
  transport: RemoteConfigTransport;
  /** Null disables remote configuration entirely; safe defaults are used. */
  verifier: RemoteConfigVerifier | null;
  clock?: Clock;
  onResolved?: (resolved: ResolvedEngineConfig) => void;
};

function safeDefaults(rejection: ConfigRejectionReason | null): ResolvedEngineConfig {
  return {
    config: cloneEngineConfig(SAFE_DEFAULT_ENGINE_CONFIG),
    source: 'SAFE_DEFAULTS',
    adjustments: [],
    rejection,
  };
}

export class RemoteConfigClient {
  private readonly clock: Clock;

  constructor(private readonly deps: RemoteConfigClientDeps) {
    this.clock = deps.clock ?? systemClock;
  }

  /**
   * Configuration to boot with, read from cache without touching the network.
   * A cached config was already verified and clamped when it was stored, and it
   * is clamped again on read so that a tampered database file cannot widen it.
   */
  async loadCached(): Promise<ResolvedEngineConfig> {
    let cached: Awaited<ReturnType<LocationStore['loadRemoteConfig']>>;
    try {
      cached = await this.deps.store.loadRemoteConfig();
    } catch {
      return this.publish(safeDefaults(null));
    }
    if (!cached) {
      return this.publish(safeDefaults(null));
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(cached.configJson);
    } catch {
      return this.publish(safeDefaults('SCHEMA_INVALID'));
    }

    const { config, adjustments } = enforceGuardrails(parsed as LocationEngineConfig);
    if (!isWithinGuardrails(config)) {
      return this.publish(safeDefaults('GUARDRAIL_FAILURE'));
    }
    return this.publish({ config, source: 'CACHED', adjustments, rejection: null });
  }

  /**
   * Fetches and applies a new configuration.
   *
   * Never throws: the caller is a background effect, and a config refresh
   * failing must never take down tracking that the user has consented to.
   */
  async refresh(): Promise<ResolvedEngineConfig> {
    const fallback = await this.loadCached();

    if (!this.deps.verifier) {
      // No provisioned signing key means no way to tell the backend's config
      // from an attacker's. Run on what we already trust.
      return this.publish({ ...fallback, rejection: 'NO_VERIFIER' });
    }

    let envelope: SignedRemoteConfigEnvelope | null;
    try {
      envelope = await this.deps.transport.fetchConfig({
        currentVersion: fallback.source === 'CACHED' ? fallback.config.configVersion : null,
      });
    } catch {
      return this.publish({ ...fallback, rejection: 'TRANSPORT_ERROR' });
    }

    if (!envelope) {
      return this.publish(fallback);
    }

    const rejected = (reason: ConfigRejectionReason): ResolvedEngineConfig =>
      this.publish({ ...fallback, rejection: reason });

    // 1. Tripwire before anything else, so an attempt to smuggle a consent
    //    override is attributed precisely rather than as a generic schema error.
    const bypass = scanForConsentBypassKeys(envelope);
    if (bypass.found.length > 0) {
      return rejected('CONSENT_BYPASS_ATTEMPT');
    }

    // 2. Shape.
    const parsed = SignedRemoteConfigEnvelopeSchema.safeParse(envelope);
    if (!parsed.success) {
      return rejected('SCHEMA_INVALID');
    }
    const { config: rawConfig, signature } = parsed.data;

    // 3. Freshness of the signature, to bound replay of an old config.
    const signedAtMs = isoToEpochMs(signature.signedAt);
    const ageSeconds = (this.clock.now() - signedAtMs) / 1000;
    if (!Number.isFinite(ageSeconds) || ageSeconds > MAX_SIGNATURE_AGE_SECONDS) {
      return rejected('SIGNATURE_STALE');
    }

    // 4. Authenticity. Only now is the payload trusted at all.
    // A verifier that throws is treated exactly like one that returns false:
    // an unverifiable config is never applied.
    const verified = await this.deps.verifier
      .verify({ canonicalPayload: canonicalPayloadFor(rawConfig), signature })
      .catch(() => false);
    if (!verified) {
      return rejected('SIGNATURE_INVALID');
    }

    // 5. Monotonic versions: a valid but older config must not be replayed to
    //    walk the device back onto settings that have since been fixed.
    if (fallback.source === 'CACHED' && rawConfig.configVersion < fallback.config.configVersion) {
      return rejected('VERSION_REGRESSION');
    }

    // 6. Clamp. Out-of-range values are corrected, never honoured.
    const { config, adjustments } = enforceGuardrails(rawConfig as LocationEngineConfig);
    if (!isWithinGuardrails(config)) {
      return rejected('GUARDRAIL_FAILURE');
    }

    // 7. Persist the clamped form only. Raw server numbers are never stored, so
    //    a later read cannot resurrect an out-of-range value.
    try {
      await this.deps.store.saveRemoteConfig({
        configVersion: config.configVersion,
        fetchedAt: this.clock.nowIso(),
        signatureKeyId: signature.keyId,
        configJson: JSON.stringify(config),
      });
    } catch {
      // Applying in memory is still correct; the next launch re-fetches.
    }

    return this.publish({ config, source: 'REMOTE_SIGNED', adjustments, rejection: null });
  }

  private publish(resolved: ResolvedEngineConfig): ResolvedEngineConfig {
    this.deps.onResolved?.(resolved);
    return resolved;
  }
}
