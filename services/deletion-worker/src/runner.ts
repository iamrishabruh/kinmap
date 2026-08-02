import type { FamilyId, UserId } from '@family/contracts';

import {
  buildTombstone,
  completeStep,
  deletionJobAgeHours,
  historyDayPartitions,
  isComplete,
  markFailed,
  nextHistoryDays,
  withCursor,
  type DeletionJob,
  type DeletionStep,
} from './job.js';
import {
  dissolvedFamilies,
  planMembershipRemoval,
  survivingFamilies,
  type FamilyDisposition,
  type MembershipRow,
} from './membership-plan.js';
import type {
  DeletionJobStore,
  DeletionMetricsSink,
  DeletionRateLimiter,
  DeviceRepository,
  IdentityDeleter,
  JobRescheduler,
  MembershipRepository,
  PushEndpointRegistry,
  SharingRevoker,
  TombstoneWriter,
  UserDataDeleter,
} from './ports.js';

/**
 * The ordered, resumable, checkpointed deletion run.
 *
 * One invocation executes as many steps as its budget allows, persisting the
 * job after every step and after every history day partition. When the budget
 * runs out the job is rescheduled and the next invocation picks up from the
 * checkpoint — never from the beginning.
 */

export type RunnerDeps = {
  readonly jobs: DeletionJobStore;
  readonly sharing: SharingRevoker;
  readonly memberships: MembershipRepository;
  readonly devices: DeviceRepository;
  readonly pushEndpoints: PushEndpointRegistry;
  readonly data: UserDataDeleter;
  readonly identity: IdentityDeleter;
  readonly tombstones: TombstoneWriter;
  readonly rescheduler: JobRescheduler;
  readonly rateLimiter: DeletionRateLimiter;
  readonly metrics: DeletionMetricsSink;
  readonly tombstonePepper: string;
  readonly historyLookbackDays: number;
  readonly maxHistoryDaysPerInvocation: number;
  readonly rescheduleDelaySeconds: number;
  readonly now: () => Date;
};

export type RunResult = {
  readonly job: DeletionJob;
  readonly stepsExecuted: DeletionStep[];
  readonly rescheduled: boolean;
  readonly rowsDeleted: number;
};

/**
 * The dispositions are recomputed at the start of every run rather than stored,
 * because the family may have changed between invocations — a member who left
 * in the meantime must not be handed ownership of a family.
 */
async function computeDispositions(
  userId: UserId,
  memberships: MembershipRepository,
): Promise<{ dispositions: FamilyDisposition[]; rows: MembershipRow[] }> {
  const rows = await memberships.listMemberships({ userId });
  const otherMembersByFamily = new Map<FamilyId, MembershipRow[]>();

  for (const row of rows) {
    const members = await memberships.listFamilyMembers({ familyId: row.familyId });
    otherMembersByFamily.set(
      row.familyId,
      members.filter((member) => member.userId !== userId),
    );
  }

  return {
    dispositions: planMembershipRemoval({ userId, memberships: rows, otherMembersByFamily }),
    rows,
  };
}

export async function runDeletionJob(initial: DeletionJob, deps: RunnerDeps): Promise<RunResult> {
  let job = initial;
  const stepsExecuted: DeletionStep[] = [];
  let rowsDeleted = 0;

  deps.metrics.recordJobAgeHours(deletionJobAgeHours(job, deps.now()));

  if (isComplete(job)) {
    // Re-running a finished job is a no-op, not an error: SQS redelivers.
    return { job, stepsExecuted, rescheduled: false, rowsDeleted };
  }

  if (job.startedAt === null) {
    job = { ...job, startedAt: deps.now().toISOString(), status: 'RUNNING' };
    await deps.jobs.save(job);
  }

  // Recomputed once per invocation and shared by the membership and saved-place
  // steps, so both act on the same view of the family.
  let dispositions: FamilyDisposition[] | null = null;
  const dispositionsFor = async (): Promise<FamilyDisposition[]> => {
    dispositions ??= (await computeDispositions(job.userId, deps.memberships)).dispositions;
    return dispositions;
  };

  try {
    while (!isComplete(job)) {
      const step = job.step;

      switch (step) {
        case 'REVOKE_SHARING': {
          // First, always. Every later step takes time, and for all of it the
          // account must already be invisible to the family.
          await deps.rateLimiter.acquire(1);
          rowsDeleted += await deps.sharing.revokeAllSharing({ userId: job.userId });
          job = completeStep(job, deps.now());
          break;
        }

        case 'REMOVE_MEMBERSHIPS': {
          for (const disposition of await dispositionsFor()) {
            await deps.rateLimiter.acquire(1);
            if (disposition.action === 'TRANSFER_OWNERSHIP') {
              await deps.memberships.transferOwnership({
                familyId: disposition.familyId,
                fromUserId: job.userId,
                toUserId: disposition.successorUserId,
              });
            }
            await deps.memberships.removeMembership({
              familyId: disposition.familyId,
              userId: job.userId,
            });
            if (disposition.action === 'DISSOLVE') {
              await deps.memberships.dissolveFamily({ familyId: disposition.familyId });
            }
          }
          job = completeStep(job, deps.now());
          break;
        }

        case 'REVOKE_DEVICES': {
          const devices = await deps.devices.listDevices({ userId: job.userId });
          for (const device of devices) {
            await deps.rateLimiter.acquire(1);
            await deps.devices.revokeDevice({ userId: job.userId, deviceId: device.deviceId });
            if (device.pushEndpointArn !== null) {
              // The push endpoint outlives the device row and would otherwise
              // keep accepting publishes for a deleted account.
              await deps.pushEndpoints.deleteEndpoint({ endpointArn: device.pushEndpointArn });
            }
          }
          job = completeStep(job, deps.now());
          break;
        }

        case 'DELETE_CURRENT_LOCATIONS': {
          await deps.rateLimiter.acquire(1);
          rowsDeleted += await deps.data.deleteCurrentLocations({ userId: job.userId });
          job = completeStep(job, deps.now());
          break;
        }

        case 'DELETE_LOCATION_HISTORY': {
          const days = historyDayPartitions({
            requestedAt: job.requestedAt,
            lookbackDays: deps.historyLookbackDays,
            now: deps.now(),
          });
          const slice = nextHistoryDays({
            days,
            cursor: job.cursor,
            limit: deps.maxHistoryDaysPerInvocation,
          });

          for (const day of slice.days) {
            await deps.rateLimiter.acquire(1);
            const removed = await deps.data.deleteHistoryDay({ userId: job.userId, day });
            rowsDeleted += removed;
            deps.metrics.recordRowsDeleted(step, removed);
            // Checkpoint after EVERY partition: a timeout here must not replay
            // hundreds of days of deletes on the next invocation.
            job = withCursor(job, day, deps.now());
            await deps.jobs.save(job);
          }

          if (!slice.done) {
            // Budget exhausted mid-step. Persist and hand back to the queue.
            await deps.rescheduler.reschedule({
              jobId: job.jobId,
              delaySeconds: deps.rescheduleDelaySeconds,
            });
            return { job, stepsExecuted, rescheduled: true, rowsDeleted };
          }

          job = completeStep(job, deps.now());
          break;
        }

        case 'DELETE_SAVED_PLACES': {
          const plan = await dispositionsFor();
          await deps.rateLimiter.acquire(1);
          rowsDeleted += await deps.data.purgeSavedPlaces({
            userId: job.userId,
            dissolvedFamilyIds: dissolvedFamilies(plan),
            reassignments: survivingFamilies(plan).flatMap((family) =>
              family.inheritorUserId === null
                ? []
                : [{ familyId: family.familyId, inheritorUserId: family.inheritorUserId }],
            ),
          });
          job = completeStep(job, deps.now());
          break;
        }

        case 'DELETE_NOTIFICATION_PREFERENCES': {
          await deps.rateLimiter.acquire(1);
          rowsDeleted += await deps.data.deleteNotificationPreferences({ userId: job.userId });
          job = completeStep(job, deps.now());
          break;
        }

        case 'DELETE_LIVE_SESSIONS': {
          await deps.rateLimiter.acquire(1);
          rowsDeleted += await deps.data.deleteLiveSessions({ userId: job.userId });
          job = completeStep(job, deps.now());
          break;
        }

        case 'DELETE_GEOFENCE_STATE': {
          await deps.rateLimiter.acquire(1);
          rowsDeleted += await deps.data.deleteGeofenceState({ userId: job.userId });
          job = completeStep(job, deps.now());
          break;
        }

        case 'DELETE_IDENTITY': {
          // Late on purpose: until this point the user id is still the key we
          // use to find their rows. After it, they cannot sign in again.
          await deps.identity.deleteUser({ userId: job.userId });
          job = completeStep(job, deps.now());
          break;
        }

        case 'WRITE_TOMBSTONE': {
          await deps.tombstones.write(
            buildTombstone({
              userId: job.userId,
              pepper: deps.tombstonePepper,
              reason: 'ACCOUNT_DELETION_REQUESTED',
              now: deps.now(),
            }),
          );
          job = completeStep(job, deps.now());
          break;
        }

        case 'CONFIRM': {
          job = completeStep(job, deps.now());
          break;
        }

        case 'COMPLETED':
          break;
      }

      stepsExecuted.push(step);
      await deps.jobs.save(job);
    }
  } catch (error) {
    const failed = markFailed(
      job,
      error instanceof Error ? error.name : 'UnknownError',
      deps.now(),
    );
    await deps.jobs.save(failed);
    // Rescheduled rather than abandoned: deletion has a legal deadline, so the
    // job retries from its checkpoint instead of stopping at the first throttle.
    await deps.rescheduler.reschedule({
      jobId: failed.jobId,
      delaySeconds: deps.rescheduleDelaySeconds,
    });
    return { job: failed, stepsExecuted, rescheduled: true, rowsDeleted };
  }

  return { job, stepsExecuted, rescheduled: false, rowsDeleted };
}

/** Simple token bucket used to pace destructive writes. */
export function createRateLimiter(options: {
  ratePerSecond: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): DeletionRateLimiter {
  const rate = Math.max(1, options.ratePerSecond);
  const sleep =
    options.sleep ??
    ((ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;

  let allowance = rate;
  let lastCheck = now();

  return {
    async acquire(units: number): Promise<void> {
      const current = now();
      allowance = Math.min(rate, allowance + ((current - lastCheck) / 1000) * rate);
      lastCheck = current;

      if (allowance >= units) {
        allowance -= units;
        return;
      }

      const deficit = units - allowance;
      allowance = 0;
      await sleep(Math.ceil((deficit / rate) * 1000));
    },
  };
}
