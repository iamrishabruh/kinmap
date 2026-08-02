import type { QueryClient } from '@tanstack/react-query';

import type { ErrorCode } from '@family/contracts';

import { locationCacheStore } from '@/features/family/location-cache';
import { ROOT } from '@/features/query/keys';

/**
 * Authorization loss.
 *
 * When the server stops vouching for this device — the session expired, the
 * refresh token was revoked, the device was unregistered, the membership was
 * removed, or the account is being deleted — the correct behaviour is not to
 * show a login sheet over a still-populated map. It is to destroy the data
 * first and ask questions afterwards.
 *
 * `onAuthorizationLost` is that destruction. It is synchronous with respect to
 * the caches (nothing is left for a later tick to clean up), it removes every
 * key under `ROOT`, it clears the mutation cache so a queued retry cannot
 * replay against a revoked session, and it drains every registered store —
 * including the device-local position cache.
 */

/** Error codes that mean "this client is no longer authorised". */
export const AUTHORIZATION_LOST_CODES: readonly ErrorCode[] = [
  'UNAUTHENTICATED',
  'SESSION_EXPIRED',
  'DEVICE_REVOKED',
  'DEVICE_NOT_REGISTERED',
  'NOT_A_FAMILY_MEMBER',
  'ACCOUNT_PENDING_DELETION',
];

export type AuthorizationLossReason =
  | 'SESSION_EXPIRED'
  | 'UNAUTHENTICATED'
  | 'DEVICE_REVOKED'
  | 'MEMBERSHIP_REVOKED'
  | 'ACCOUNT_PENDING_DELETION'
  | 'SIGN_OUT';

export function reasonForErrorCode(code: ErrorCode): AuthorizationLossReason | null {
  switch (code) {
    case 'UNAUTHENTICATED':
      return 'UNAUTHENTICATED';
    case 'SESSION_EXPIRED':
      return 'SESSION_EXPIRED';
    case 'DEVICE_REVOKED':
    case 'DEVICE_NOT_REGISTERED':
      return 'DEVICE_REVOKED';
    case 'NOT_A_FAMILY_MEMBER':
      return 'MEMBERSHIP_REVOKED';
    case 'ACCOUNT_PENDING_DELETION':
      return 'ACCOUNT_PENDING_DELETION';
    default:
      return null;
  }
}

/** Any device-local store that holds family data and can be emptied. */
export type PurgeableCache = {
  readonly name: string;
  purgeAll: () => void;
};

const purgeableCaches = new Set<PurgeableCache>();

export function registerPurgeableCache(cache: PurgeableCache): () => void {
  purgeableCaches.add(cache);
  return () => {
    purgeableCaches.delete(cache);
  };
}

/**
 * The position cache is registered at module load rather than at mount, because
 * authorization can be lost before any screen has rendered.
 */
registerPurgeableCache({
  name: 'location-cache',
  purgeAll: () => {
    locationCacheStore.getState().purgeAll();
  },
});

export type PurgeSummary = {
  reason: AuthorizationLossReason;
  /** Number of cached queries removed. Counts only, never contents. */
  removedQueryCount: number;
  purgedCaches: string[];
  purgedAt: string;
};

export type AuthorizationLostOptions = {
  queryClient: QueryClient;
  reason: AuthorizationLossReason;
  /** Invoked after the purge so the auth layer can tear down credentials. */
  onPurged?: (summary: PurgeSummary) => void | Promise<void>;
  now?: () => number;
};

/**
 * PURGES ALL CACHED FAMILY DATA. Safe to call more than once and safe to call
 * with in-flight requests outstanding.
 */
export async function onAuthorizationLost(
  options: AuthorizationLostOptions,
): Promise<PurgeSummary> {
  const { queryClient, reason, onPurged, now = Date.now } = options;

  // 1. Stop anything in flight so a late response cannot repopulate the cache
  //    after we have emptied it.
  await queryClient.cancelQueries({ queryKey: ROOT });

  const cache = queryClient.getQueryCache();
  const removedQueryCount = cache.getAll().length;

  // 2. Drop every family-scoped key, then everything else this client owns.
  queryClient.removeQueries({ queryKey: ROOT });
  cache.clear();

  // 3. A queued mutation would otherwise replay against a revoked session.
  queryClient.getMutationCache().clear();

  // 4. Empty every device-local store, positions first.
  const purgedCaches: string[] = [];
  for (const purgeable of purgeableCaches) {
    purgeable.purgeAll();
    purgedCaches.push(purgeable.name);
  }

  const summary: PurgeSummary = {
    reason,
    removedQueryCount,
    purgedCaches,
    purgedAt: new Date(now()).toISOString(),
  };

  if (onPurged !== undefined) {
    await onPurged(summary);
  }

  return summary;
}

/**
 * Binds a QueryClient once so feature code can call a zero-argument handler.
 * The auth layer installs the result as its `onUnauthorized` hook.
 */
export function createAuthorizationLostHandler(
  queryClient: QueryClient,
  onPurged?: (summary: PurgeSummary) => void | Promise<void>,
): (reason: AuthorizationLossReason) => Promise<PurgeSummary> {
  return (reason) => {
    const options: AuthorizationLostOptions = { queryClient, reason };
    if (onPurged !== undefined) options.onPurged = onPurged;
    return onAuthorizationLost(options);
  };
}
