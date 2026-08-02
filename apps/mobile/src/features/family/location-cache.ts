import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

import type { FamilyId, UserId } from '@family/contracts';

import { type MemberLocation } from '@/features/query/types';

/**
 * The device-local cache of member positions.
 *
 * This exists alongside the React Query cache because purging has to be
 * *unconditional and synchronous*. When a member is removed from a family, spec
 * §35 requires their cached location to be gone from this device immediately —
 * not on the next refetch, not when a `gcTime` elapses, not "eventually".
 * `purgeMember` is that guarantee, and the removal mutation calls it in the same
 * tick it learns the removal succeeded.
 *
 * Everything held here is memory-only. There is no persist middleware and there
 * must never be one: a position that survives an app restart is a position that
 * survives a revoked consent.
 */

export type LocationCacheState = {
  /** familyId -> userId -> last known location (visible OR hidden). */
  byFamily: Record<FamilyId, Record<UserId, MemberLocation>>;
  /** Monotonic counter, bumped on every purge. Used by tests and diagnostics. */
  purgeCount: number;

  /**
   * Authoritative replacement for one family. Members absent from `locations`
   * are dropped, so a member who disappeared from the roster cannot leave a
   * position behind.
   */
  replaceFamily: (familyId: FamilyId, locations: MemberLocation[]) => void;
  upsert: (location: MemberLocation) => void;

  /** Spec §35: called the instant a removal succeeds. */
  purgeMember: (familyId: FamilyId, userId: UserId) => void;
  /** Blocking someone removes them from every family cached on this device. */
  purgeMemberEverywhere: (userId: UserId) => void;
  purgeFamily: (familyId: FamilyId) => void;
  /** Sign-out, authorization loss, account deletion. */
  purgeAll: () => void;

  get: (familyId: FamilyId, userId: UserId) => MemberLocation | undefined;
  listFamily: (familyId: FamilyId) => MemberLocation[];
  size: () => number;
};

export const locationCacheStore = createStore<LocationCacheState>()((set, get) => ({
  byFamily: {},
  purgeCount: 0,

  replaceFamily: (familyId, locations) => {
    const next: Record<UserId, MemberLocation> = {};
    for (const location of locations) {
      next[location.userId] = location;
    }
    set((state) => ({ byFamily: { ...state.byFamily, [familyId]: next } }));
  },

  upsert: (location) => {
    set((state) => {
      const family = state.byFamily[location.familyId] ?? {};
      return {
        byFamily: {
          ...state.byFamily,
          [location.familyId]: { ...family, [location.userId]: location },
        },
      };
    });
  },

  purgeMember: (familyId, userId) => {
    set((state) => {
      const family = state.byFamily[familyId];
      if (family === undefined) return { purgeCount: state.purgeCount + 1 };
      const nextFamily: Record<UserId, MemberLocation> = {};
      for (const [key, value] of Object.entries(family)) {
        if (key !== userId) nextFamily[key] = value;
      }
      return {
        byFamily: { ...state.byFamily, [familyId]: nextFamily },
        purgeCount: state.purgeCount + 1,
      };
    });
  },

  purgeMemberEverywhere: (userId) => {
    set((state) => {
      const nextByFamily: Record<FamilyId, Record<UserId, MemberLocation>> = {};
      for (const [familyId, family] of Object.entries(state.byFamily)) {
        const nextFamily: Record<UserId, MemberLocation> = {};
        for (const [key, value] of Object.entries(family)) {
          if (key !== userId) nextFamily[key] = value;
        }
        nextByFamily[familyId] = nextFamily;
      }
      return { byFamily: nextByFamily, purgeCount: state.purgeCount + 1 };
    });
  },

  purgeFamily: (familyId) => {
    set((state) => {
      const nextByFamily: Record<FamilyId, Record<UserId, MemberLocation>> = {};
      for (const [key, value] of Object.entries(state.byFamily)) {
        if (key !== familyId) nextByFamily[key] = value;
      }
      return { byFamily: nextByFamily, purgeCount: state.purgeCount + 1 };
    });
  },

  purgeAll: () => {
    set((state) => ({ byFamily: {}, purgeCount: state.purgeCount + 1 }));
  },

  get: (familyId, userId) => get().byFamily[familyId]?.[userId],

  listFamily: (familyId) => Object.values(get().byFamily[familyId] ?? {}),

  size: () =>
    Object.values(get().byFamily).reduce((total, family) => total + Object.keys(family).length, 0),
}));

export function useLocationCache<T>(selector: (state: LocationCacheState) => T): T {
  return useStore(locationCacheStore, selector);
}

/** Convenience for call sites outside React (mutation callbacks, handlers). */
export function locationCache(): LocationCacheState {
  return locationCacheStore.getState();
}
