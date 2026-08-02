import type {
  DeviceLocationHealth,
  LocationPermissionState,
  SavedPlace,
  TrackingState,
} from './domain.js';

/**
 * The single boundary between shared TypeScript product logic and the native
 * Swift/Kotlin background-location implementations (spec §9). Both platforms
 * implement this exact surface; no product code may reach past it.
 */
export interface NativeLocationEngine {
  configure(config: LocationEngineConfig): Promise<void>;
  startPassiveTracking(): Promise<void>;
  startLiveSession(session: LiveSessionConfig): Promise<void>;
  stopLiveSession(): Promise<void>;
  pauseSharing(): Promise<void>;
  resumeSharing(): Promise<void>;
  getPermissionState(): Promise<LocationPermissionState>;
  getDeviceHealth(): Promise<DeviceLocationHealth>;
  flushPendingEvents(): Promise<FlushResult>;
  registerGeofences(places: SavedPlace[]): Promise<void>;
  unregisterGeofences(placeIds: string[]): Promise<void>;
}

/**
 * Tunable engine parameters. Delivered by signed remote configuration and
 * clamped in native code to the guardrails below (spec §30).
 */
export type LocationEngineConfig = {
  configVersion: number;
  /** Metres of movement before a new fix is recorded, per state. */
  distanceFilters: Record<TrackingState, number>;
  /** Target seconds between stored points, per state. Best-effort, not a promise. */
  targetFreshnessSeconds: Record<TrackingState, number>;
  /** Seconds after which a stored location is considered STALE. */
  maxStaleSeconds: number;
  /** Hard ceiling on a live session, always <= LIMITS.MAX_LIVE_SESSION_SECONDS. */
  liveSessionMaxSeconds: number;
  liveSessionUpdateIntervalSeconds: number;
  lowBatteryThreshold: number;
  criticalBatteryThreshold: number;
  uploadBatchSize: number;
  minUploadIntervalSeconds: number;
  retry: RetryPolicy;
  /** Reject fixes worse than this horizontal accuracy, in metres. */
  maxAcceptableAccuracyMeters: number;
};

export type RetryPolicy = {
  baseDelayMs: number;
  maxDelayMs: number;
  multiplier: number;
  /** Fraction of the delay applied as random jitter, 0..1. */
  jitterRatio: number;
  maxAttempts: number;
};

export type LiveSessionConfig = {
  sessionId: string;
  /** Clamped natively; the server also enforces expiry. */
  durationSeconds: number;
  updateIntervalSeconds: number;
  requestedBy: string;
  expiresAt: string;
};

export type FlushResult = {
  uploadedCount: number;
  remainingCount: number;
  /** Sanitised reason — never contains coordinates (spec §11, §20). */
  lastError: string | null;
  attemptedAt: string;
};

/**
 * Guardrails enforced in native code. Remote configuration is clamped into
 * these ranges so a bad or hostile config can never disable privacy controls
 * or drain a device's battery.
 */
export const CONFIG_GUARDRAILS = {
  distanceFilterMeters: { min: 10, max: 5000 },
  targetFreshnessSeconds: { min: 10, max: 3600 },
  maxStaleSeconds: { min: 300, max: 86_400 },
  liveSessionMaxSeconds: { min: 60, max: 600 },
  liveSessionUpdateIntervalSeconds: { min: 10, max: 30 },
  lowBatteryThreshold: { min: 0.05, max: 0.5 },
  criticalBatteryThreshold: { min: 0.02, max: 0.2 },
  uploadBatchSize: { min: 1, max: 100 },
  minUploadIntervalSeconds: { min: 30, max: 3600 },
  maxAcceptableAccuracyMeters: { min: 5, max: 500 },
} as const;
