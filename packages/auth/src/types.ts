import { z } from 'zod';

import {
  DeviceIdSchema,
  FamilyIdSchema,
  UserIdSchema,
  type DeviceId,
  type Entitlements,
  type FamilyId,
  type FamilyRole,
  type MembershipStatus,
  type Plan,
  type PlanTier,
  type SharingStatus,
  type SubscriptionStatus,
  type UserId,
} from '@family/contracts';

/**
 * Authentication and authorization vocabulary (spec §18).
 *
 * Account and device lifecycle states are declared here rather than in
 * @family/contracts because they are server-only concepts: the client is never
 * told which of them caused a rejection.
 */

export const TokenUseSchema = z.enum(['access', 'id']);
export type TokenUse = z.infer<typeof TokenUseSchema>;

/**
 * Verified Cognito access-token claims. `looseObject` keeps unknown claims so a
 * pool-level customisation is not silently dropped, while named claims stay
 * typed.
 */
export const AccessTokenClaimsSchema = z.looseObject({
  sub: z.string().min(1),
  token_use: TokenUseSchema,
  iss: z.string().min(1),
  exp: z.number(),
  iat: z.number(),
  client_id: z.string().optional(),
  scope: z.string().optional(),
  username: z.string().optional(),
  auth_time: z.number().optional(),
  jti: z.string().optional(),
  /** Present when the pool has device tracking enabled. Not a UUID. */
  device_key: z.string().optional(),
  /** Our own device-registry id, written as a custom claim at sign-in. */
  'custom:device_id': z.string().optional(),
});
export type AccessTokenClaims = z.infer<typeof AccessTokenClaimsSchema>;

/**
 * The authenticated principal for one request. Produced only by
 * `verifyAccessToken`; handlers must never assemble one from request headers or
 * body, because every downstream check trusts `userId`.
 */
export type AuthContext = {
  userId: UserId;
  /** Null when the caller presented no device binding. */
  deviceId: DeviceId | null;
  tokenUse: TokenUse;
  claims: AccessTokenClaims;
  /** Correlation id echoed to the caller; never a secret. */
  requestId: string;
};

// ---------------------------------------------------------------------------
// Server-side records, supplied by injected repositories
// ---------------------------------------------------------------------------

export const AccountStatusSchema = z.enum(['ACTIVE', 'SUSPENDED', 'PENDING_DELETION', 'DELETED']);
export type AccountStatus = z.infer<typeof AccountStatusSchema>;

export const DeviceStatusSchema = z.enum(['ACTIVE', 'PENDING', 'REVOKED']);
export type DeviceStatus = z.infer<typeof DeviceStatusSchema>;

export type UserAccountRecord = {
  userId: UserId;
  status: AccountStatus;
};

export type DeviceRecord = {
  deviceId: DeviceId;
  userId: UserId;
  status: DeviceStatus;
};

/**
 * A member's row in a family. `sharingStatus` is the target's own consent
 * switch; `visibleToUserIds` / `hiddenFromUserIds` are their per-member
 * visibility choices. Both belong to the target, never to the requester.
 */
export type FamilyMembershipRecord = {
  familyId: FamilyId;
  userId: UserId;
  role: FamilyRole;
  status: MembershipStatus;
  sharingStatus: SharingStatus;
  /**
   * Allow-list. `null` means "every active member of this family"; an array
   * means only those users; an empty array means nobody.
   */
  visibleToUserIds: UserId[] | null;
  /** Deny-list applied after the allow-list. Wins on conflict. */
  hiddenFromUserIds?: UserId[];
};

export type SubscriptionRecord = {
  familyId: FamilyId;
  plan: Plan;
  status: SubscriptionStatus;
};

export type EntitlementSnapshot = {
  tier: PlanTier;
  entitlements: Entitlements;
};

/** Identifier schemas re-exported so callers validate against one source. */
export const IdentifierSchemas = {
  userId: UserIdSchema,
  familyId: FamilyIdSchema,
  deviceId: DeviceIdSchema,
} as const;
