import { AppError, type DeviceId, type FamilyId, type UserId } from '@family/contracts';
import type { EncryptedCoordinateRecord } from '@family/crypto';
import type { StrictLocationEvent } from '@family/schemas';

/**
 * Persisted row shapes for stored fixes.
 *
 * Two invariants are enforced structurally rather than by review:
 *
 *  1. Neither row type has a `latitude` or `longitude` field. The only carrier
 *     of a position is `sealed`, an {@link EncryptedCoordinateRecord}, so a row
 *     cannot be built with a plaintext coordinate even by accident.
 *  2. `LocationHistory` keys are `USER#<id>#DAY#<yyyy-mm-dd>` / `TIME#<iso>#EVENT#<id>`,
 *     matching the table's partition design: a history read is a bounded query
 *     over at most one partition per day, and "delete last Tuesday" is a
 *     partition-scoped delete rather than a scan.
 */

export const LOCATION_RECORD_SCHEMA_VERSION = 1;

const SECONDS_PER_DAY = 86_400;

export type StoredCurrentLocation = {
  readonly userId: UserId;
  readonly deviceId: DeviceId;
  readonly eventId: string;
  readonly sequenceNumber: number;
  readonly capturedAt: string;
  readonly receivedAt: string;
  readonly trackingState: StrictLocationEvent['trackingMode'];
  readonly motionState: NonNullable<StrictLocationEvent['motionState']>;
  readonly horizontalAccuracy: number;
  readonly altitude: number | null;
  readonly heading: number | null;
  readonly speed: number | null;
  readonly batteryLevel: number | null;
  readonly isLowPowerMode: boolean | null;
  readonly coordinateScopeFamilyId: FamilyId;
  readonly sealed: EncryptedCoordinateRecord;
  readonly schemaVersion: number;
};

export type StoredHistoryPoint = {
  readonly pk: string;
  readonly sk: string;
  readonly userId: UserId;
  readonly deviceId: DeviceId;
  readonly eventId: string;
  readonly sequenceNumber: number;
  readonly capturedAt: string;
  readonly receivedAt: string;
  readonly trackingState: StrictLocationEvent['trackingMode'];
  readonly motionState: NonNullable<StrictLocationEvent['motionState']>;
  readonly horizontalAccuracy: number;
  readonly altitude: number | null;
  readonly heading: number | null;
  readonly speed: number | null;
  readonly coordinateScopeFamilyId: FamilyId;
  readonly sealed: EncryptedCoordinateRecord;
  /** DynamoDB TTL, epoch seconds. Physical deletion; readers also expire logically. */
  readonly expiresAt: number;
  readonly schemaVersion: number;
};

function instantOf(isoTimestamp: string): number {
  const parsed = Date.parse(isoTimestamp);
  if (Number.isNaN(parsed)) {
    // Unreachable for a schema-validated event; fail loudly rather than writing
    // a row under a key derived from `Invalid Date`.
    throw new AppError('VALIDATION_FAILED', 'The request could not be validated.', [
      { path: 'capturedAt', message: 'This value is not in the expected format.' },
    ]);
  }
  return parsed;
}

/** `2026-08-02`, always in UTC so a traveller's rows do not straddle partitions. */
export function utcDay(isoTimestamp: string): string {
  return new Date(instantOf(isoTimestamp)).toISOString().slice(0, 10);
}

export function historyPartitionKey(userId: UserId, isoTimestamp: string): string {
  return `USER#${userId}#DAY#${utcDay(isoTimestamp)}`;
}

export function historyPartitionKeyForDay(userId: UserId, day: string): string {
  return `USER#${userId}#DAY#${day}`;
}

export function historySortKey(isoTimestamp: string, eventId: string): string {
  // ISO-8601 UTC instants sort lexicographically, so a range query on this key
  // is a range query on time.
  return `TIME#${new Date(instantOf(isoTimestamp)).toISOString()}#EVENT#${eventId}`;
}

/** TTL relative to *capture*, not to receipt: a late upload does not buy extra retention. */
export function historyExpiresAt(isoTimestamp: string, retentionDays: number): number {
  return Math.floor(instantOf(isoTimestamp) / 1000) + retentionDays * SECONDS_PER_DAY;
}

export type RecordBuildInput = {
  readonly event: StrictLocationEvent;
  readonly userId: UserId;
  readonly receivedAt: string;
  readonly coordinateScopeFamilyId: FamilyId;
  readonly sealed: EncryptedCoordinateRecord;
};

export function buildCurrentLocationRecord(input: RecordBuildInput): StoredCurrentLocation {
  const { event } = input;
  return {
    userId: input.userId,
    deviceId: event.deviceId,
    eventId: event.eventId,
    sequenceNumber: event.sequenceNumber,
    capturedAt: event.capturedAt,
    receivedAt: input.receivedAt,
    trackingState: event.trackingMode,
    motionState: event.motionState ?? 'UNKNOWN',
    horizontalAccuracy: event.horizontalAccuracy,
    altitude: event.altitude ?? null,
    heading: event.heading ?? null,
    speed: event.speed ?? null,
    batteryLevel: event.batteryLevel ?? null,
    isLowPowerMode: event.isLowPowerMode ?? null,
    coordinateScopeFamilyId: input.coordinateScopeFamilyId,
    sealed: input.sealed,
    schemaVersion: LOCATION_RECORD_SCHEMA_VERSION,
  };
}

export function buildHistoryRecord(
  input: RecordBuildInput,
  retentionDays: number,
): StoredHistoryPoint {
  const { event } = input;
  return {
    pk: historyPartitionKey(input.userId, event.capturedAt),
    sk: historySortKey(event.capturedAt, event.eventId),
    userId: input.userId,
    deviceId: event.deviceId,
    eventId: event.eventId,
    sequenceNumber: event.sequenceNumber,
    capturedAt: event.capturedAt,
    receivedAt: input.receivedAt,
    trackingState: event.trackingMode,
    motionState: event.motionState ?? 'UNKNOWN',
    horizontalAccuracy: event.horizontalAccuracy,
    altitude: event.altitude ?? null,
    heading: event.heading ?? null,
    speed: event.speed ?? null,
    coordinateScopeFamilyId: input.coordinateScopeFamilyId,
    sealed: input.sealed,
    expiresAt: historyExpiresAt(event.capturedAt, retentionDays),
    schemaVersion: LOCATION_RECORD_SCHEMA_VERSION,
  };
}
