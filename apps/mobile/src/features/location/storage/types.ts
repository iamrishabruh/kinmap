import {
  type FamilyRole,
  type Freshness,
  type LocationEvent,
  type SharingStatus,
  type TrackingState,
} from '@family/contracts';

import { type UploadErrorCode } from '../errors';

/**
 * The persisted local model (spec §11).
 *
 * Every field that could identify a person or a place travels through the
 * `sealed*` columns; the plaintext columns exist only for indexing and for
 * values that are already public to the device owner (timestamps, counters,
 * enum states). A dump of the SQLite file therefore reveals when a device was
 * active, never where it was or who it was with.
 */

export type PendingEventRecord = {
  event: LocationEvent;
  queuedAt: string;
  attempts: number;
  nextAttemptAt: string;
  lastErrorCode: UploadErrorCode | null;
};

export type StoredLocationPoint = {
  latitude: number;
  longitude: number;
  horizontalAccuracy: number;
  capturedAt: string;
  acceptedAt: string;
  trackingMode: TrackingState;
};

export type PersistedEngineState = {
  trackingState: TrackingState;
  sharingStatus: SharingStatus;
  /** The user's explicit opt-in. Absent this, nothing may start (spec §10). */
  sharingEnabled: boolean;
  sharingPaused: boolean;
  /** Monotonic per-device counter carried on every uploaded event. */
  lastSequenceNumber: number;
  lastUploadAttemptAt: string | null;
  lastUploadError: UploadErrorCode | null;
  updatedAt: string;
};

export type CachedFamilyMetadata = {
  familyId: string;
  /** Encrypted: family name, member display names, avatar URLs, place names. */
  metadata: CachedFamilyMetadataPayload;
  memberCount: number;
  role: FamilyRole;
  cachedAt: string;
};

export type CachedFamilyMetadataPayload = {
  familyName: string;
  members: Array<{
    userId: string;
    displayName: string;
    avatarUrl: string | null;
    role: FamilyRole;
  }>;
  savedPlaceNames: Array<{ placeId: string; name: string }>;
};

/**
 * A map pin for another family member.
 *
 * `point` is null whenever the member is not actively sharing. It is not merely
 * hidden in the UI — there is no coordinate on the device at all, so a paused
 * member cannot be located by reading the database (spec §19).
 */
export type CachedMarker = {
  familyId: string;
  userId: string;
  sharingStatus: SharingStatus;
  freshness: Freshness;
  capturedAt: string | null;
  point: { latitude: number; longitude: number; horizontalAccuracy: number } | null;
  cachedAt: string;
};

export const PENDING_MUTATION_KINDS = [
  'SHARING_ENABLE',
  'SHARING_PAUSE',
  'SHARING_RESUME',
  'SHARING_DISABLE',
  'LEAVE_FAMILY',
  'REMOVE_MEMBER',
  'SAVED_PLACE_CREATE',
  'SAVED_PLACE_UPDATE',
  'SAVED_PLACE_DELETE',
  'ACCEPT_TERMS',
  'DEVICE_UPDATE',
  'HISTORY_DELETE',
  'ACCOUNT_DELETE',
] as const;

export type PendingMutationKind = (typeof PENDING_MUTATION_KINDS)[number];

export type PendingMutation = {
  mutationId: string;
  kind: PendingMutationKind;
  /** Stable across retries so the server can deduplicate (spec §21). */
  idempotencyKey: string;
  payload: Record<string, unknown>;
  createdAt: string;
  attempts: number;
  nextAttemptAt: string;
  lastErrorCode: UploadErrorCode | null;
};

export type StoredRemoteConfig = {
  configVersion: number;
  fetchedAt: string;
  signatureKeyId: string;
  /** Already clamped. Raw server values are never persisted. */
  configJson: string;
};

export type AcceptanceVersions = {
  termsVersion: string | null;
  termsAcceptedAt: string | null;
  privacyVersion: string | null;
  privacyAcceptedAt: string | null;
  updatedAt: string;
};

export type QueueStats = {
  pendingCount: number;
  oldestQueuedAt: string | null;
  readyCount: number;
};

/**
 * The persistence port.
 *
 * The engine, the upload coordinator and the provider all depend on this
 * interface rather than on `expo-sqlite`, which is what lets the queue and
 * purge semantics be tested exhaustively without a native database.
 */
export interface LocationStore {
  initialize(): Promise<void>;
  close(): Promise<void>;

  // --- pending location events -------------------------------------------
  enqueueEvents(events: readonly LocationEvent[], now: string): Promise<{ dropped: number }>;
  /** Events whose `nextAttemptAt` has come due, oldest first. */
  claimReadyEvents(limit: number, now: string): Promise<PendingEventRecord[]>;
  removeEvents(eventIds: readonly string[]): Promise<void>;
  recordEventAttempt(
    eventIds: readonly string[],
    input: { nextAttemptAt: string; errorCode: UploadErrorCode },
  ): Promise<void>;
  /** Drops events older than the queue is permitted to hold (LIMITS.MAX_QUEUE_AGE_HOURS). */
  pruneExpiredEvents(now: string, maxAgeHours: number): Promise<number>;
  getQueueStats(now: string): Promise<QueueStats>;
  purgePendingEvents(): Promise<number>;

  // --- last accepted location --------------------------------------------
  setLastAcceptedLocation(point: StoredLocationPoint): Promise<void>;
  getLastAcceptedLocation(): Promise<StoredLocationPoint | null>;

  // --- engine state -------------------------------------------------------
  saveEngineState(state: PersistedEngineState): Promise<void>;
  loadEngineState(): Promise<PersistedEngineState | null>;
  /** Reserves `count` sequence numbers and returns the first one. */
  reserveSequenceNumbers(count: number, now: string): Promise<number>;

  // --- cached family metadata --------------------------------------------
  saveFamilyMetadata(records: readonly CachedFamilyMetadata[]): Promise<void>;
  loadFamilyMetadata(): Promise<CachedFamilyMetadata[]>;

  // --- cached markers -----------------------------------------------------
  saveMarkers(markers: readonly CachedMarker[]): Promise<void>;
  loadMarkers(familyId: string): Promise<CachedMarker[]>;

  // --- pending mutations --------------------------------------------------
  enqueueMutation(mutation: PendingMutation): Promise<void>;
  claimReadyMutations(limit: number, now: string): Promise<PendingMutation[]>;
  removeMutation(mutationId: string): Promise<void>;
  recordMutationAttempt(
    mutationId: string,
    input: { nextAttemptAt: string; errorCode: UploadErrorCode },
  ): Promise<void>;

  // --- remote configuration ----------------------------------------------
  saveRemoteConfig(record: StoredRemoteConfig): Promise<void>;
  loadRemoteConfig(): Promise<StoredRemoteConfig | null>;

  // --- terms / privacy acceptance ----------------------------------------
  saveAcceptanceVersions(record: AcceptanceVersions): Promise<void>;
  loadAcceptanceVersions(): Promise<AcceptanceVersions | null>;

  /**
   * Irreversibly removes every row this feature owns. Called on sign-out,
   * device revocation and account deletion.
   */
  purgeAll(): Promise<void>;
}
