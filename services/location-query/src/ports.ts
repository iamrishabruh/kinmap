import type { FamilyMembershipRecord } from '@family/auth';
import type {
  AuditEvent,
  DeviceId,
  FamilyId,
  MotionState,
  PlaceId,
  TrackingState,
  UserId,
} from '@family/contracts';
import type { Coordinates, EncryptedCoordinateRecord, KeyContext } from '@family/crypto';

/**
 * Read-side seams.
 *
 * Stored rows never carry a plaintext position: the only carrier is `sealed`,
 * and opening it requires the `CoordinateOpener` — which in production is backed
 * by the one IAM role in the platform that holds `kms:Decrypt` on the coordinate
 * key. A test binds the same interface to the offline KMS stub.
 */

/**
 * A membership row plus the read-side fields the authorization types do not
 * carry. `sharingChangedAt` is coarse ("sharing stopped at") and is the only
 * timestamp a hidden member's card is allowed to show.
 */
export type FamilyMemberRow = FamilyMembershipRecord & {
  readonly sharingChangedAt: string | null;
};

export interface MembershipDirectory {
  listFamilyMembers(familyId: FamilyId): Promise<FamilyMemberRow[]>;
  listFamiliesForUser(userId: UserId): Promise<FamilyMemberRow[]>;
}

/** Shared by the current-fix and history rows: metadata plus ciphertext. */
export type SealedFixRow = {
  readonly userId: UserId;
  readonly deviceId: DeviceId;
  readonly eventId: string;
  readonly capturedAt: string;
  readonly receivedAt: string;
  readonly trackingState: TrackingState;
  readonly motionState: MotionState;
  readonly horizontalAccuracy: number;
  readonly altitude: number | null;
  readonly heading: number | null;
  readonly speed: number | null;
  readonly batteryLevel: number | null;
  readonly isLowPowerMode: boolean | null;
  /** The family the row's encryption context was bound to when it was written. */
  readonly coordinateScopeFamilyId: FamilyId;
  readonly sealed: EncryptedCoordinateRecord;
  /** DynamoDB TTL, epoch seconds. Present on history rows. */
  readonly expiresAt?: number;
};

/** A history row additionally exposes its keys so a cursor can resume from it. */
export type SealedHistoryRow = SealedFixRow & {
  readonly day: string;
  readonly sortKey: string;
};

export interface CurrentLocationReader {
  /** The freshest stored fix across the member's devices, or null. */
  latestForUser(userId: UserId): Promise<SealedFixRow | null>;
}

export type HistoryPageRequest = {
  readonly userId: UserId;
  readonly day: string;
  readonly lowSortKey: string;
  readonly highSortKey: string;
  /** Resume strictly after this sort key, when continuing a page. */
  readonly exclusiveStartSortKey: string | null;
  readonly limit: number;
};

export interface HistoryReader {
  queryDay(request: HistoryPageRequest): Promise<SealedHistoryRow[]>;
}

export type SavedPlaceRow = {
  readonly placeId: PlaceId;
  readonly name: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly radiusMeters: number;
};

export interface SavedPlaceReader {
  listForFamily(familyId: FamilyId): Promise<SavedPlaceRow[]>;
}

/** The slice of `EncryptionService` a reader needs. */
export interface CoordinateOpener {
  decryptCoordinates(
    record: EncryptedCoordinateRecord,
    keyContext: KeyContext,
  ): Promise<Coordinates>;
}

/**
 * Every sensitive read is recorded (spec §18). A write failure fails the
 * request: a read that cannot be accounted for must not happen.
 */
export interface AuditWriter {
  record(event: AuditEvent): Promise<void>;
}
