import type { FamilyId, PlaceId, UserId } from '@family/contracts';

/**
 * React Query key factory.
 *
 * Every key is rooted at `ROOT`, which is what makes a single
 * `removeQueries({ queryKey: ROOT })` a complete purge of family data on
 * authorization loss (see `authorization.ts`). Nothing in this app may create a
 * cache entry outside this root.
 *
 * Keys are structured data held in memory only. They must never be serialised
 * into a log line or a crash report, and no key ever contains a coordinate.
 */

export const ROOT = ['family-location'] as const;

export const queryKeys = {
  root: () => ROOT,

  session: () => [...ROOT, 'session'] as const,
  entitlements: () => [...ROOT, 'entitlements'] as const,

  /** The signed-in user's own sharing state. */
  sharingState: () => [...ROOT, 'sharing-state'] as const,

  families: () => [...ROOT, 'families'] as const,
  family: (familyId: FamilyId) => [...ROOT, 'families', familyId] as const,
  members: (familyId: FamilyId) => [...ROOT, 'families', familyId, 'members'] as const,
  member: (familyId: FamilyId, userId: UserId) =>
    [...ROOT, 'families', familyId, 'members', userId] as const,

  /** Everything positional lives under this prefix so it can be dropped alone. */
  locations: (familyId: FamilyId) => [...ROOT, 'families', familyId, 'locations'] as const,
  memberLocation: (familyId: FamilyId, userId: UserId) =>
    [...ROOT, 'families', familyId, 'locations', userId] as const,
  timeline: (familyId: FamilyId, userId: UserId) =>
    [...ROOT, 'families', familyId, 'timeline', userId] as const,
  /** Prefix covering every stored day for one member — removable in one call. */
  historyRoot: (familyId: FamilyId, userId: UserId) =>
    [...ROOT, 'families', familyId, 'history', userId] as const,
  history: (familyId: FamilyId, userId: UserId, day: string) =>
    [...ROOT, 'families', familyId, 'history', userId, day] as const,

  places: (familyId: FamilyId) => [...ROOT, 'families', familyId, 'places'] as const,
  place: (familyId: FamilyId, placeId: PlaceId) =>
    [...ROOT, 'families', familyId, 'places', placeId] as const,

  invitations: (familyId: FamilyId) => [...ROOT, 'families', familyId, 'invitations'] as const,
  /**
   * Keyed by the invitation token because that is the only handle the recipient
   * has. The query is configured with `gcTime: 0` in `policies.ts` so the token
   * never lingers in memory after the screen unmounts, and the cache is never
   * written to disk.
   */
  invitationPreview: (token: string) => [...ROOT, 'invitation-preview', token] as const,

  liveSessions: (familyId: FamilyId) => [...ROOT, 'families', familyId, 'live-sessions'] as const,
  liveSession: (sessionId: string) => [...ROOT, 'live-sessions', sessionId] as const,
} as const;

/** Prefixes that hold positional or family-scoped data. */
export const PURGEABLE_PREFIXES = {
  everything: ROOT,
  familyScoped: (familyId: FamilyId) => [...ROOT, 'families', familyId] as const,
  locationScoped: (familyId: FamilyId) => [...ROOT, 'families', familyId, 'locations'] as const,
} as const;
