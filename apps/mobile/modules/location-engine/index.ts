import { requireOptionalNativeModule } from 'expo-modules-core';

import type {
  DeviceLocationHealth,
  FlushResult,
  LiveSessionConfig,
  LocationEngineConfig,
  LocationPermissionState,
  NativeLocationEngine,
  SavedPlace,
} from '@family/contracts';

/**
 * TypeScript face of the native background-location engine.
 *
 * The Swift and Kotlin implementations satisfy exactly the
 * `NativeLocationEngine` contract from @family/contracts (spec §9); this file
 * adds nothing to that surface beyond an event emitter and a safe fallback.
 *
 * Resolution is deliberately *optional*: in Expo Go, on web, and in Jest the
 * native module is absent. Rather than crashing at import time, we expose a
 * stub whose every method rejects. The app then renders "location sharing is
 * unavailable on this build" instead of pretending tracking is running — a
 * silent no-op here would mean a user believes they are visible to their family
 * when they are not.
 */

type LocationEngineEvents = {
  onEngineStateChange: (payload: { state: string; reason?: string }) => void;
  onPermissionChange: (payload: LocationPermissionState) => void;
  onGeofenceTransition: (payload: {
    placeId: string;
    transition: 'ARRIVAL' | 'DEPARTURE';
    occurredAt: string;
  }) => void;
  onQueueChange: (payload: { pendingEventCount: number }) => void;
};

type NativeModuleShape = NativeLocationEngine & {
  addListener<K extends keyof LocationEngineEvents>(
    event: K,
    listener: LocationEngineEvents[K],
  ): { remove(): void };
};

const nativeModule = requireOptionalNativeModule<NativeModuleShape>('LocationEngineModule');

export class NativeEngineUnavailableError extends Error {
  constructor(method: string) {
    super(
      `The native location engine is not linked in this build (called "${method}"). ` +
        'Use a development build; location cannot run in Expo Go or on web.',
    );
    this.name = 'NativeEngineUnavailableError';
  }
}

function unavailable(method: string): () => Promise<never> {
  return () => Promise.reject(new NativeEngineUnavailableError(method));
}

/**
 * Fallback used when no native module is present. Every method rejects; nothing
 * resolves to a value that could be mistaken for "tracking is active".
 */
const unavailableEngine: NativeModuleShape = {
  configure: unavailable('configure'),
  startPassiveTracking: unavailable('startPassiveTracking'),
  startLiveSession: unavailable('startLiveSession'),
  stopLiveSession: unavailable('stopLiveSession'),
  pauseSharing: unavailable('pauseSharing'),
  resumeSharing: unavailable('resumeSharing'),
  getPermissionState: unavailable('getPermissionState'),
  getDeviceHealth: unavailable('getDeviceHealth'),
  flushPendingEvents: unavailable('flushPendingEvents'),
  registerGeofences: unavailable('registerGeofences'),
  unregisterGeofences: unavailable('unregisterGeofences'),
  addListener: () => ({ remove: () => undefined }),
};

const engine: NativeModuleShape = nativeModule ?? unavailableEngine;

export const isNativeEngineLinked = nativeModule !== null;

export const LocationEngine: NativeLocationEngine = {
  configure: (config: LocationEngineConfig) => engine.configure(config),
  startPassiveTracking: () => engine.startPassiveTracking(),
  startLiveSession: (session: LiveSessionConfig) => engine.startLiveSession(session),
  stopLiveSession: () => engine.stopLiveSession(),
  pauseSharing: () => engine.pauseSharing(),
  resumeSharing: () => engine.resumeSharing(),
  getPermissionState: (): Promise<LocationPermissionState> => engine.getPermissionState(),
  getDeviceHealth: (): Promise<DeviceLocationHealth> => engine.getDeviceHealth(),
  flushPendingEvents: (): Promise<FlushResult> => engine.flushPendingEvents(),
  registerGeofences: (places: SavedPlace[]) => engine.registerGeofences(places),
  unregisterGeofences: (placeIds: string[]) => engine.unregisterGeofences(placeIds),
};

export function addListener<K extends keyof LocationEngineEvents>(
  event: K,
  listener: LocationEngineEvents[K],
): { remove(): void } {
  return engine.addListener(event, listener);
}

export default LocationEngine;
export type { LocationEngineEvents };
