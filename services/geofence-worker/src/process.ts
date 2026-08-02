import type { FamilyId, PlaceId, SavedPlace } from '@family/contracts';

import {
  DEFAULT_GEOFENCE_TUNING,
  evaluateGeofence,
  isTransition,
  type GeofenceFix,
  type GeofenceOutcome,
  type GeofenceTuning,
} from './geofence.js';
import { GeofenceNotificationCommandSchema, type GeofenceNotificationCommand } from './messages.js';
import type { GeofenceStateStore, MembershipReader, SavedPlaceReader } from './ports.js';

/**
 * Orchestration around the pure evaluator: which fences apply, what to persist,
 * and what to announce. Still free of AWS types so it can be unit-tested.
 */

export type ProcessDeps = {
  readonly memberships: MembershipReader;
  readonly places: SavedPlaceReader;
  readonly state: GeofenceStateStore;
  readonly tuning?: GeofenceTuning;
  /** Injected so command ids are deterministic in tests. */
  readonly newCommandId: () => string;
};

export type FenceResult = {
  readonly familyId: FamilyId;
  readonly placeId: PlaceId;
  readonly outcome: GeofenceOutcome;
  /** False when a concurrent invocation had already advanced the row. */
  readonly persisted: boolean;
};

export type ProcessResult = {
  readonly commands: GeofenceNotificationCommand[];
  readonly results: FenceResult[];
  readonly evaluatedFamilies: number;
  readonly evaluatedPlaces: number;
};

/**
 * Evaluates one accepted fix against every fence the subject is visible within.
 *
 * Authorisation note: the set of families comes from the membership table, not
 * from anything in the message. A client cannot cause its fix to be evaluated
 * against a family it is not an active, sharing member of.
 */
export async function processAcceptedLocation(
  fix: GeofenceFix,
  deps: ProcessDeps,
): Promise<ProcessResult> {
  const tuning = deps.tuning ?? DEFAULT_GEOFENCE_TUNING;
  const commands: GeofenceNotificationCommand[] = [];
  const results: FenceResult[] = [];

  const families = await deps.memberships.listEvaluableFamilies({ userId: fix.userId });
  let evaluatedPlaces = 0;

  for (const membership of families) {
    const places = await deps.places.listPlaces({ familyId: membership.familyId });

    for (const place of places) {
      evaluatedPlaces += 1;

      const previous = await deps.state.get({ userId: fix.userId, placeId: place.placeId });
      const evaluation = evaluateGeofence(fix, place, previous, tuning);

      if (!evaluation.stateChanged || evaluation.nextState === null) {
        results.push({
          familyId: membership.familyId,
          placeId: place.placeId,
          outcome: evaluation.outcome,
          persisted: false,
        });
        continue;
      }

      const persisted = await deps.state.put({
        state: evaluation.nextState,
        expectedVersion: previous === null ? null : previous.version,
      });

      results.push({
        familyId: membership.familyId,
        placeId: place.placeId,
        outcome: evaluation.outcome,
        persisted,
      });

      // The command is emitted only after the state write wins the race, so a
      // transition that lost to a concurrent worker is not announced twice.
      if (
        persisted &&
        isTransition(evaluation.outcome) &&
        wantsNotification(place, evaluation.outcome)
      ) {
        commands.push(
          GeofenceNotificationCommandSchema.parse({
            commandId: deps.newCommandId(),
            kind: evaluation.outcome,
            familyId: membership.familyId,
            subjectUserId: fix.userId,
            recipientUserIds: null,
            placeId: place.placeId,
            transition: evaluation.outcome,
            occurredAt: fix.capturedAt,
            sourceEventId: fix.eventId,
          } satisfies GeofenceNotificationCommand),
        );
      }
    }
  }

  return {
    commands,
    results,
    evaluatedFamilies: families.length,
    evaluatedPlaces,
  };
}

function wantsNotification(
  place: Pick<SavedPlace, 'notifyOnArrival' | 'notifyOnDeparture'>,
  outcome: 'ARRIVAL' | 'DEPARTURE',
): boolean {
  return outcome === 'ARRIVAL' ? place.notifyOnArrival : place.notifyOnDeparture;
}
