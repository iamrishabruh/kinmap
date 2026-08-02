import type { FamilyId, PlaceId, SavedPlace, UserId } from '@family/contracts';

import type { GeofenceState } from './geofence.js';

/**
 * Data-access seams. The orchestration in `process.ts` depends only on these,
 * so the whole worker is exercisable in a unit test with no table and no
 * credentials — the same discipline @family/auth applies to authorization.
 */

/** The subset of a membership row that decides whether we may evaluate at all. */
export type EvaluableMembership = {
  readonly familyId: FamilyId;
  readonly userId: UserId;
};

export interface MembershipReader {
  /**
   * Families in which the subject is ACTIVE **and** currently sharing.
   *
   * The filtering is the repository's job precisely so that a caller cannot
   * forget it: a paused member's fix must not be evaluated at all, because an
   * arrival alert is itself a disclosure of location.
   */
  listEvaluableFamilies(input: { userId: UserId }): Promise<EvaluableMembership[]>;
}

export interface SavedPlaceReader {
  listPlaces(input: { familyId: FamilyId }): Promise<SavedPlace[]>;
}

export interface GeofenceStateStore {
  get(input: { userId: UserId; placeId: PlaceId }): Promise<GeofenceState | null>;
  /**
   * Conditional write on `version`. Returns false when another invocation won
   * the race; the caller drops its verdict rather than overwriting a newer one,
   * which is what keeps a transition firing exactly once under concurrency.
   */
  put(input: { state: GeofenceState; expectedVersion: number | null }): Promise<boolean>;
}

export interface NotificationCommandPublisher {
  publish(commands: readonly unknown[]): Promise<void>;
}
