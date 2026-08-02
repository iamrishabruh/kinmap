import type { QueryClient } from '@tanstack/react-query';

import { pauseNativeSharing } from '../settings/native/location-engine';

import { listPurgeTargets, type PurgeContext, type PurgeReason } from './purge-targets';

/**
 * Local cache purge, run on sign-out, membership loss, device revocation and
 * account deletion.
 *
 * THE RULE
 * --------
 * The moment a user stops being entitled to data, this device stops holding it.
 * That covers the obvious case (someone signs out on a shared phone) and the
 * one that actually matters (a user leaves a family to get away from someone in
 * it, and their phone must not keep a cached copy of that family's whereabouts,
 * nor keep quietly collecting their own position for it).
 *
 * ORDER
 * -----
 * Collection stops *first*. Deleting caches while the native engine is still
 * recording would leave a fresh row behind the moment the purge finished. Only
 * then are the caches cleared.
 *
 * FAILURE POLICY
 * --------------
 * Best-effort and non-blocking. One target failing must never prevent the
 * others from running, and must never prevent a user from signing out or
 * deleting their account. Failures are reported back by target id — with no
 * error text, because an error string from a storage layer is exactly the kind
 * of value that could carry a file path or a row's contents into a log.
 */

export type PurgeOptions = {
  reason: PurgeReason;
  queryClient?: QueryClient | null;
  /** Required for MEMBERSHIP_LOST; ignored otherwise. */
  familyId?: string | null;
  /** Injected in tests. */
  stopCollection?: () => Promise<void>;
};

export type PurgeReport = {
  reason: PurgeReason;
  /** True when location collection was confirmed stopped before purging. */
  collectionStopped: boolean;
  purgedTargetIds: string[];
  /** Ids only. Never an error message. */
  failedTargetIds: string[];
};

export async function purgeLocalCaches(options: PurgeOptions): Promise<PurgeReport> {
  const stopCollection = options.stopCollection ?? pauseNativeSharing;

  let collectionStopped: boolean;
  try {
    await stopCollection();
    collectionStopped = true;
  } catch {
    // The engine may already be stopped, or not present at all on this build.
    // Either way the purge still runs — refusing to clear caches because we
    // could not talk to the engine would be the worse failure.
    collectionStopped = false;
  }

  const context: PurgeContext = {
    reason: options.reason,
    familyId: options.familyId ?? null,
    queryClient: options.queryClient ?? null,
  };

  const purgedTargetIds: string[] = [];
  const failedTargetIds: string[] = [];

  for (const target of listPurgeTargets(options.reason)) {
    try {
      await target.purge(context);
      purgedTargetIds.push(target.id);
    } catch {
      failedTargetIds.push(target.id);
    }
  }

  return { reason: options.reason, collectionStopped, purgedTargetIds, failedTargetIds };
}

/** Sign-out on this device. Called by the auth feature before clearing tokens. */
export function purgeOnSignOut(queryClient: QueryClient | null): Promise<PurgeReport> {
  return purgeLocalCaches({ reason: 'SIGN_OUT', queryClient });
}

/**
 * The user left, or was removed from, a family. Scoped to that family so the
 * user's other families keep working.
 */
export function purgeOnMembershipLoss(
  queryClient: QueryClient | null,
  familyId: string,
): Promise<PurgeReport> {
  return purgeLocalCaches({ reason: 'MEMBERSHIP_LOST', queryClient, familyId });
}

/** The account is gone. Leave nothing behind. */
export function purgeOnAccountDeletion(queryClient: QueryClient | null): Promise<PurgeReport> {
  return purgeLocalCaches({ reason: 'ACCOUNT_DELETED', queryClient });
}

/**
 * This device was revoked from elsewhere. Treated exactly like a sign-out on a
 * device we no longer trust: stop collecting, drop everything, and let the
 * queued points on this phone die with the database rather than be uploaded.
 */
export function purgeOnDeviceRevoked(queryClient: QueryClient | null): Promise<PurgeReport> {
  return purgeLocalCaches({ reason: 'DEVICE_REVOKED', queryClient });
}
