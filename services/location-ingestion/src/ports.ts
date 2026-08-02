import type { DeviceRecord, FamilyMembershipRecord, UserAccountRecord } from '@family/auth';
import type { DeviceId, UserId } from '@family/contracts';
import type { Coordinates, EncryptedCoordinateRecord, KeyContext } from '@family/crypto';

import type { StoredCurrentLocation, StoredHistoryPoint } from './domain/records.js';

/**
 * Data-access seams.
 *
 * The ingestion pipeline depends on these interfaces rather than on the AWS SDK,
 * so the whole accept/reject/encrypt/persist flow runs in a unit test with an
 * in-memory KMS stub and no credentials. `src/repositories/*` binds them to
 * DynamoDB and EventBridge at the composition root in `handler.ts`.
 */

export interface AccountReader {
  getAccount(userId: UserId): Promise<UserAccountRecord | null>;
}

export interface DeviceReader {
  /** Scoped by user: a device id alone must never resolve to its owner. */
  getDevice(userId: UserId, deviceId: DeviceId): Promise<DeviceRecord | null>;
}

export interface MembershipReader {
  listForUser(userId: UserId): Promise<FamilyMembershipRecord[]>;
}

export type UploadWindowDecision = {
  readonly allowed: boolean;
  readonly retryAfterSeconds: number;
};

/**
 * Enforces `LIMITS.MIN_UPLOAD_INTERVAL_SECONDS` across containers. Reserving is
 * a conditional write, not a read-then-write, so two concurrent uploads from the
 * same device cannot both pass.
 */
export interface UploadWindowGate {
  reserve(deviceId: DeviceId, now: Date): Promise<UploadWindowDecision>;
}

export interface CurrentLocationStore {
  /** Capture time of the stored fix, or null. Never returns the position itself. */
  readCapturedAt(userId: UserId, deviceId: DeviceId): Promise<string | null>;
  /**
   * Conditional write that only accepts a strictly newer `capturedAt`.
   * Resolves false when the stored fix is already newer, so an out-of-order
   * retry cannot regress the current position.
   */
  putIfNewer(record: StoredCurrentLocation): Promise<boolean>;
}

export interface HistoryWriter {
  append(records: readonly StoredHistoryPoint[]): Promise<void>;
}

export type AcceptedLocationEvent = {
  readonly subjectUserId: UserId;
  readonly deviceId: DeviceId;
  readonly eventId: string;
  readonly sequenceNumber: number;
  readonly capturedAt: string;
  readonly receivedAt: string;
  readonly trackingMode: string;
  readonly motionState: string;
  readonly horizontalAccuracy: number;
  readonly coordinateScopeFamilyId: string;
  /** Ciphertext only. The bus, its rules and its targets never see a position. */
  readonly sealed: EncryptedCoordinateRecord;
};

export interface AcceptedLocationPublisher {
  publish(events: readonly AcceptedLocationEvent[]): Promise<void>;
}

/** The slice of `EncryptionService` this service uses; it holds no decrypt grant. */
export interface CoordinateSealer {
  encryptCoordinates(
    coordinates: Coordinates,
    keyContext: KeyContext,
  ): Promise<EncryptedCoordinateRecord>;
}
