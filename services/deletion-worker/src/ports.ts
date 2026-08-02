import type { DeviceId, FamilyId, UserId } from '@family/contracts';

import type { DeletionJob, Tombstone } from './job.js';
import type { MembershipRow } from './membership-plan.js';

/**
 * Every side effect a deletion job performs, behind an interface, so the whole
 * ordered pipeline can be run in a unit test and asserted on.
 */

export interface SharingRevoker {
  /** Sets every membership of the subject to non-sharing. Returns rows touched. */
  revokeAllSharing(input: { userId: UserId }): Promise<number>;
}

export interface MembershipRepository {
  listMemberships(input: { userId: UserId }): Promise<MembershipRow[]>;
  listFamilyMembers(input: { familyId: FamilyId }): Promise<MembershipRow[]>;
  transferOwnership(input: {
    familyId: FamilyId;
    fromUserId: UserId;
    toUserId: UserId;
  }): Promise<void>;
  removeMembership(input: { familyId: FamilyId; userId: UserId }): Promise<void>;
  dissolveFamily(input: { familyId: FamilyId }): Promise<void>;
}

export type DeviceSummary = {
  readonly deviceId: DeviceId;
  readonly pushEndpointArn: string | null;
};

export interface DeviceRepository {
  listDevices(input: { userId: UserId }): Promise<DeviceSummary[]>;
  revokeDevice(input: { userId: UserId; deviceId: DeviceId }): Promise<void>;
}

export interface PushEndpointRegistry {
  deleteEndpoint(input: { endpointArn: string }): Promise<void>;
}

export interface UserDataDeleter {
  deleteCurrentLocations(input: { userId: UserId }): Promise<number>;
  /** One LocationHistory day partition. Returns the number of rows removed. */
  deleteHistoryDay(input: { userId: UserId; day: string }): Promise<number>;
  /**
   * Saved places are family data. Places in a dissolved family are deleted;
   * places in a surviving family are reassigned to the inheritor so the rest of
   * the family does not lose their home and school.
   */
  purgeSavedPlaces(input: {
    userId: UserId;
    dissolvedFamilyIds: readonly FamilyId[];
    reassignments: ReadonlyArray<{ familyId: FamilyId; inheritorUserId: UserId }>;
  }): Promise<number>;
  deleteNotificationPreferences(input: { userId: UserId }): Promise<number>;
  deleteLiveSessions(input: { userId: UserId }): Promise<number>;
  deleteGeofenceState(input: { userId: UserId }): Promise<number>;
}

export interface IdentityDeleter {
  /** Must succeed or throw; a silently skipped identity is not a deletion. */
  deleteUser(input: { userId: UserId }): Promise<void>;
}

export interface TombstoneWriter {
  write(tombstone: Tombstone): Promise<void>;
}

export interface DeletionJobStore {
  load(input: { jobId: string }): Promise<DeletionJob | null>;
  save(job: DeletionJob): Promise<void>;
}

export interface JobRescheduler {
  /** Puts the job back on the queue so it resumes from its checkpoint. */
  reschedule(input: { jobId: string; delaySeconds: number }): Promise<void>;
}

/**
 * Paces destructive writes so a large account cannot consume the table's whole
 * write capacity and take live traffic down with it.
 */
export interface DeletionRateLimiter {
  acquire(units: number): Promise<void>;
}

export interface DeletionMetricsSink {
  recordJobAgeHours(hours: number): void;
  recordRowsDeleted(step: string, rows: number): void;
}
