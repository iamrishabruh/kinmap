import { type NativeLocationEngine } from '@family/contracts';

import * as LocationEngineModule from '../../../../modules/location-engine';
import { LocationFeatureError } from '../errors';

// The Swift/Kotlin implementations live in the local Expo module at
// apps/mobile/modules/location-engine. This relative import is the ONLY place
// in the app that reaches for it; everything else depends on the
// `NativeLocationEngine` interface from @family/contracts (spec §9).

/**
 * Resolution and injection point for the native engine.
 *
 * Two things happen here and nowhere else:
 *
 *  - the module's export shape (default export vs. named) is normalised once,
 *    so a change on the native side is a one-line fix rather than a sweep;
 *  - the resolved object is checked to actually implement the contract before
 *    any product code calls it, so a partially-linked module fails loudly at
 *    startup instead of throwing `undefined is not a function` from a
 *    background task at 3am.
 */

const REQUIRED_METHODS: ReadonlyArray<keyof NativeLocationEngine> = [
  'configure',
  'startPassiveTracking',
  'startLiveSession',
  'stopLiveSession',
  'pauseSharing',
  'resumeSharing',
  'getPermissionState',
  'getDeviceHealth',
  'flushPendingEvents',
  'registerGeofences',
  'unregisterGeofences',
];

/**
 * Optional event surface. The contract interface is request/response only; when
 * the native module also emits push updates we subscribe to them and fall back
 * to polling when it does not.
 */
export type LocationEngineEventSource = {
  addListener(event: 'onEngineStateChange', listener: () => void): { remove(): void };
};

let injected: NativeLocationEngine | null = null;
let resolved: NativeLocationEngine | null = null;

function implementsContract(candidate: unknown): candidate is NativeLocationEngine {
  if (!candidate || typeof candidate !== 'object') {
    return false;
  }
  const record = candidate as Record<string, unknown>;
  return REQUIRED_METHODS.every((method) => typeof record[method] === 'function');
}

/**
 * Replaces the native engine. Used by tests and by the Expo Go / web fallbacks,
 * where no native module is linked.
 */
export function setNativeLocationEngine(engine: NativeLocationEngine | null): void {
  injected = engine;
  resolved = null;
}

/**
 * @throws LocationFeatureError NATIVE_ENGINE_UNAVAILABLE when the module is not
 * linked or does not implement the contract. Callers must degrade to
 * "sharing unavailable" rather than pretending tracking is on.
 */
export function getNativeLocationEngine(): NativeLocationEngine {
  if (injected) {
    return injected;
  }
  if (resolved) {
    return resolved;
  }

  const namespace = LocationEngineModule as unknown as Record<string, unknown>;
  const candidates = [
    namespace.default,
    namespace.LocationEngine,
    namespace.locationEngine,
    namespace,
  ];

  for (const candidate of candidates) {
    if (implementsContract(candidate)) {
      resolved = candidate;
      return candidate;
    }
  }

  throw new LocationFeatureError('NATIVE_ENGINE_UNAVAILABLE', 'binding');
}

/** Non-throwing probe used to render "sharing unavailable on this build". */
export function isNativeLocationEngineAvailable(): boolean {
  try {
    getNativeLocationEngine();
    return true;
  } catch {
    return false;
  }
}

export function getLocationEngineEventSource(): LocationEngineEventSource | null {
  const namespace = LocationEngineModule as unknown as Record<string, unknown>;
  const candidate = (namespace.default ?? namespace) as Record<string, unknown>;
  return typeof candidate.addListener === 'function'
    ? (candidate as unknown as LocationEngineEventSource)
    : null;
}
