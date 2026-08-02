import type { QueryClient } from '@tanstack/react-query';
import * as SecureStore from 'expo-secure-store';
import * as SQLite from 'expo-sqlite';

/**
 * The registry of things that must be erased from this device when the user
 * stops being entitled to them.
 *
 * WHY A REGISTRY
 * --------------
 * Local caches are added by whichever feature needs one, and a cache that
 * nobody remembered to clear on sign-out is how the next person to hold the
 * phone ends up seeing where the previous person was. Making every cache
 * *register itself* means the purge list grows with the app instead of drifting
 * behind it, and `listPurgeTargets()` gives a reviewer one place to read.
 */

export type PurgeReason =
  /** The user signed out on this device. Their data may return on sign-in. */
  | 'SIGN_OUT'
  /** The user left, or was removed from, a family. That family's data must go. */
  | 'MEMBERSHIP_LOST'
  /** The account is being deleted. Nothing survives. */
  | 'ACCOUNT_DELETED'
  /** This device was revoked from another device. Treat it as hostile. */
  | 'DEVICE_REVOKED';

export const ALL_PURGE_REASONS: readonly PurgeReason[] = [
  'SIGN_OUT',
  'MEMBERSHIP_LOST',
  'ACCOUNT_DELETED',
  'DEVICE_REVOKED',
];

export type PurgeContext = {
  reason: PurgeReason;
  /** Set only for MEMBERSHIP_LOST; null means "everything". */
  familyId: string | null;
  queryClient: QueryClient | null;
};

export type PurgeTarget = {
  id: string;
  /** Shown verbatim in the data-and-privacy screen, so write it for a user. */
  description: string;
  appliesTo: readonly PurgeReason[];
  purge: (context: PurgeContext) => Promise<void>;
};

/**
 * SQLite databases holding location-derived data on this device.
 *
 * Owned here rather than by each feature so that the file names are auditable
 * in one place. A feature that adds a database registers it with
 * `registerLocalDatabase` at module load and it is picked up automatically.
 */
const localDatabases = new Set<string>([
  // The outbound location queue written by the native engine.
  'family-location-queue.db',
  // Cached member cards, freshness and saved places.
  'family-location-cache.db',
]);

export function registerLocalDatabase(name: string): void {
  localDatabases.add(name);
}

export function listLocalDatabases(): readonly string[] {
  return [...localDatabases];
}

/**
 * SecureStore keys. Credentials and anything that identifies the signed-in
 * person. Never location data — coordinates are not stored in SecureStore.
 */
const secureStoreKeys = new Set<string>([
  'family.auth.accessToken',
  'family.auth.refreshToken',
  'family.auth.userId',
  'family.device.id',
  'family.device.pushToken',
]);

export function registerSecureStoreKey(key: string): void {
  secureStoreKeys.add(key);
}

export function listSecureStoreKeys(): readonly string[] {
  return [...secureStoreKeys];
}

// ---------------------------------------------------------------------------
// Built-in targets
// ---------------------------------------------------------------------------

const queryCacheTarget: PurgeTarget = {
  id: 'react-query-cache',
  description: 'Everything the app is holding in memory about your family and your location',
  appliesTo: ALL_PURGE_REASONS,
  async purge(context) {
    const client = context.queryClient;
    if (!client) return;

    if (context.reason === 'MEMBERSHIP_LOST' && context.familyId) {
      // Losing one family must not sign the user out of the others. Anything
      // whose key mentions that family id goes; the rest is refetched.
      const familyId = context.familyId;
      client.removeQueries({
        predicate: (query) =>
          query.queryKey.some((part) => typeof part === 'string' && part === familyId),
      });
      await client.invalidateQueries();
      return;
    }

    // Cancel first so an in-flight response cannot repopulate the cache after
    // it has been cleared — that race is precisely how stale data survives a
    // sign-out.
    await client.cancelQueries();
    client.clear();
  },
};

const sqliteTarget: PurgeTarget = {
  id: 'local-databases',
  description: 'Location updates and cached family data stored on this phone',
  // A membership change does not justify destroying the whole local database;
  // the server-side removal plus a cache invalidation is the correct scope.
  appliesTo: ['SIGN_OUT', 'ACCOUNT_DELETED', 'DEVICE_REVOKED'],
  async purge() {
    for (const name of listLocalDatabases()) {
      try {
        await SQLite.deleteDatabaseAsync(name);
      } catch {
        // A database that was never created throws. That is a success here.
      }
    }
  },
};

const secureStoreTarget: PurgeTarget = {
  id: 'secure-store',
  description: 'Your saved sign-in for this phone',
  appliesTo: ['SIGN_OUT', 'ACCOUNT_DELETED', 'DEVICE_REVOKED'],
  async purge() {
    for (const key of listSecureStoreKeys()) {
      try {
        await SecureStore.deleteItemAsync(key);
      } catch {
        // Missing key: nothing to remove.
      }
    }
  },
};

const BUILT_IN_TARGETS: readonly PurgeTarget[] = [
  queryCacheTarget,
  sqliteTarget,
  secureStoreTarget,
];

const registry = new Map<string, PurgeTarget>(
  BUILT_IN_TARGETS.map((target) => [target.id, target]),
);

export function registerPurgeTarget(target: PurgeTarget): void {
  registry.set(target.id, target);
}

export function unregisterPurgeTarget(id: string): void {
  registry.delete(id);
}

export function listPurgeTargets(reason?: PurgeReason): readonly PurgeTarget[] {
  const all = [...registry.values()];
  return reason ? all.filter((target) => target.appliesTo.includes(reason)) : all;
}

/** Test helper: restore the registry to the built-in targets only. */
export function resetPurgeTargets(): void {
  registry.clear();
  for (const target of BUILT_IN_TARGETS) registry.set(target.id, target);
}
