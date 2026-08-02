import { create } from 'zustand';

import {
  type DeviceLocationHealth,
  LOCATION_PRODUCING_STATES,
  type LocationPermissionState,
  type SharingStatus,
  type TrackingState,
} from '@family/contracts';

import { type ConfigSource, type ConfigRejectionReason } from '../config/remote-config-client';
import { type ConsentBlockReason } from '../engine/consent';
import { type UploadErrorCode } from '../errors';

/**
 * The UI's view of the location engine.
 *
 * This store is the *only* thing the sharing indicator reads, and the engine
 * controller writes to it before it calls into native code. That ordering is
 * the mechanism behind "the person being located can always see that sharing is
 * active": there is no way to start the engine that does not first publish
 * `sharingStatus: 'SHARING'` to every subscribed screen (spec §10, §25).
 *
 * Nothing here is a coordinate. The map reads points from the store's SQLite
 * layer directly; the indicator only ever needs the state machine.
 */

export type LocationFeatureStatus = 'IDLE' | 'INITIALIZING' | 'READY' | 'UNAVAILABLE';

export type LocationEngineSnapshot = {
  status: LocationFeatureStatus;
  /** True once the native engine has been asked to start and has not been stopped. */
  isEngineRunning: boolean;
  trackingState: TrackingState;
  sharingStatus: SharingStatus;
  consentBlockedBy: ConsentBlockReason | null;
  /** ALWAYS + background refresh; WHEN_IN_USE gives foreground-only sharing. */
  backgroundCapable: boolean;
  permission: LocationPermissionState | null;
  health: DeviceLocationHealth | null;
  configVersion: number;
  configSource: ConfigSource;
  configRejection: ConfigRejectionReason | null;
  configAdjustmentCount: number;
  pendingEventCount: number;
  oldestPendingEventAt: string | null;
  lastUploadAttemptAt: string | null;
  lastUploadError: UploadErrorCode | null;
  lastAcceptedAt: string | null;
  /** Set when the native module is missing or the keystore is unusable. */
  unavailableReason: string | null;
};

export type LocationEngineActions = {
  patch(next: Partial<LocationEngineSnapshot>): void;
  reset(): void;
};

export const INITIAL_ENGINE_SNAPSHOT: LocationEngineSnapshot = {
  status: 'IDLE',
  isEngineRunning: false,
  trackingState: 'DISABLED',
  sharingStatus: 'NEVER_ENABLED',
  consentBlockedBy: null,
  backgroundCapable: false,
  permission: null,
  health: null,
  configVersion: 0,
  configSource: 'SAFE_DEFAULTS',
  configRejection: null,
  configAdjustmentCount: 0,
  pendingEventCount: 0,
  oldestPendingEventAt: null,
  lastUploadAttemptAt: null,
  lastUploadError: null,
  lastAcceptedAt: null,
  unavailableReason: null,
};

export const useLocationEngineStore = create<LocationEngineSnapshot & LocationEngineActions>(
  (set) => ({
    ...INITIAL_ENGINE_SNAPSHOT,
    patch: (next) => set(next),
    reset: () => set({ ...INITIAL_ENGINE_SNAPSHOT }),
  }),
);

/** Non-React accessor for the engine controller and background tasks. */
export const locationEngineStore = {
  getState: () => useLocationEngineStore.getState(),
  patch: (next: Partial<LocationEngineSnapshot>) => useLocationEngineStore.getState().patch(next),
  reset: () => useLocationEngineStore.getState().reset(),
  subscribe: useLocationEngineStore.subscribe,
};

export function isProducingLocation(trackingState: TrackingState): boolean {
  return LOCATION_PRODUCING_STATES.includes(trackingState);
}
