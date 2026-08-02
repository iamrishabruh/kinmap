import {
  type LocationAuthorization,
  type LocationPermissionState,
  type SharingStatus,
  type TrackingState,
} from '@family/contracts';

/**
 * The consent gate.
 *
 * This module is the single place in the app that answers "may this device
 * produce a location right now?". It is deliberately pure — no I/O, no store,
 * no config — so that the answer is a function of the user's own choices and
 * the OS permission state, and of nothing else.
 *
 * Remote configuration is not an input. Neither is the server. Neither is a
 * feature flag. If tracking is ever to start for a reason not listed in
 * `ConsentSnapshot`, that reason has to be added here, in a diff a reviewer
 * will see (spec §10, §25).
 */

export type ConsentSnapshot = {
  /** The user completed sign-in on this device. */
  isAuthenticated: boolean;
  /** The user belongs to at least one family with ACTIVE membership. */
  hasActiveFamilyMembership: boolean;
  /** The user turned sharing on themselves. Never defaulted to true. */
  sharingEnabledByUser: boolean;
  /** The user pressed pause. Honoured ahead of everything except sign-out. */
  sharingPausedByUser: boolean;
  acceptedTermsVersion: string | null;
  acceptedPrivacyVersion: string | null;
  requiredTermsVersion: string;
  requiredPrivacyVersion: string;
  /** A deletion request stops collection immediately, before the purge runs. */
  accountPendingDeletion: boolean;
  /** The server revoked this device (lost/stolen, or removed by the owner). */
  deviceRevoked: boolean;
};

export const CONSENT_BLOCK_REASONS = [
  'NOT_AUTHENTICATED',
  'NO_ACTIVE_FAMILY',
  'SHARING_NOT_ENABLED',
  'SHARING_PAUSED',
  'TERMS_NOT_ACCEPTED',
  'ACCOUNT_PENDING_DELETION',
  'DEVICE_REVOKED',
  'LOCATION_SERVICES_OFF',
  'PERMISSION_NOT_GRANTED',
] as const;

export type ConsentBlockReason = (typeof CONSENT_BLOCK_REASONS)[number];

export type ConsentDecision = {
  /** True only when every condition below is satisfied. */
  mayTrack: boolean;
  /** First unsatisfied condition, in the order a user would fix them. */
  blockedBy: ConsentBlockReason | null;
  sharingStatus: SharingStatus;
  /** Non-producing state to report while blocked. */
  trackingState: TrackingState;
  /** True when background collection is possible; WHEN_IN_USE means foreground only. */
  backgroundCapable: boolean;
};

const GRANTED_AUTHORIZATIONS: readonly LocationAuthorization[] = ['WHEN_IN_USE', 'ALWAYS'];

export function isAuthorizationGranted(authorization: LocationAuthorization): boolean {
  return GRANTED_AUTHORIZATIONS.includes(authorization);
}

export function hasAcceptedCurrentPolicies(consent: ConsentSnapshot): boolean {
  return (
    consent.acceptedTermsVersion === consent.requiredTermsVersion &&
    consent.acceptedPrivacyVersion === consent.requiredPrivacyVersion
  );
}

/**
 * Evaluates the gate.
 *
 * Order matters: the first failing condition is reported, and the ordering is
 * "what the user must fix first", so the UI can show one actionable message
 * instead of a list.
 */
export function evaluateConsent(
  consent: ConsentSnapshot,
  permission: LocationPermissionState | null,
): ConsentDecision {
  const blocked = (
    blockedBy: ConsentBlockReason,
    sharingStatus: SharingStatus,
    trackingState: TrackingState,
  ): ConsentDecision => ({
    mayTrack: false,
    blockedBy,
    sharingStatus,
    trackingState,
    backgroundCapable: false,
  });

  if (!consent.isAuthenticated) {
    return blocked('NOT_AUTHENTICATED', 'NEVER_ENABLED', 'DISABLED');
  }
  if (consent.accountPendingDeletion) {
    return blocked('ACCOUNT_PENDING_DELETION', 'DISABLED', 'DISABLED');
  }
  if (consent.deviceRevoked) {
    return blocked('DEVICE_REVOKED', 'DISABLED', 'DISABLED');
  }
  if (!hasAcceptedCurrentPolicies(consent)) {
    return blocked('TERMS_NOT_ACCEPTED', 'NEVER_ENABLED', 'DISABLED');
  }
  if (!consent.hasActiveFamilyMembership) {
    // Nobody to share with. Collecting anyway would be collection without a
    // purpose, which is exactly what this product must not do.
    return blocked('NO_ACTIVE_FAMILY', 'NEVER_ENABLED', 'DISABLED');
  }
  if (!consent.sharingEnabledByUser) {
    return blocked('SHARING_NOT_ENABLED', 'NEVER_ENABLED', 'DISABLED');
  }
  if (consent.sharingPausedByUser) {
    return blocked('SHARING_PAUSED', 'PAUSED', 'DISABLED');
  }
  if (!permission) {
    return blocked('PERMISSION_NOT_GRANTED', 'PERMISSION_BLOCKED', 'PERMISSION_REQUIRED');
  }
  if (!permission.locationServicesEnabled) {
    return blocked('LOCATION_SERVICES_OFF', 'PERMISSION_BLOCKED', 'PERMISSION_REQUIRED');
  }
  if (!isAuthorizationGranted(permission.authorization)) {
    return blocked('PERMISSION_NOT_GRANTED', 'PERMISSION_BLOCKED', 'PERMISSION_REQUIRED');
  }

  return {
    mayTrack: true,
    blockedBy: null,
    sharingStatus: 'SHARING',
    trackingState: 'PASSIVE',
    backgroundCapable: permission.authorization === 'ALWAYS' && permission.backgroundRefreshEnabled,
  };
}

/**
 * True when the user has revoked consent outright, as opposed to merely
 * pausing. Sign-out, deletion and revocation additionally purge local data;
 * a pause does not, because the user expects to resume.
 */
export function requiresLocalPurge(consent: ConsentSnapshot): boolean {
  return !consent.isAuthenticated || consent.accountPendingDeletion || consent.deviceRevoked;
}

export const SIGNED_OUT_CONSENT: ConsentSnapshot = {
  isAuthenticated: false,
  hasActiveFamilyMembership: false,
  sharingEnabledByUser: false,
  sharingPausedByUser: false,
  acceptedTermsVersion: null,
  acceptedPrivacyVersion: null,
  requiredTermsVersion: '',
  requiredPrivacyVersion: '',
  accountPendingDeletion: false,
  deviceRevoked: false,
};
