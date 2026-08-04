import type { PendingChallenge, SessionStatus } from './types';

/**
 * The routing guard, expressed as one pure function.
 *
 * The guard is the thing standing between an unauthenticated device and a
 * family's location data, and between a user and a policy they have not agreed
 * to. Keeping it free of React, navigation and network lets it be tested
 * exhaustively — see `__tests__/routing.test.ts`.
 *
 * ORDER MATTERS. The precedence below is the security property:
 *
 *   1. restoring        -> do nothing (splash is up; a redirect would race)
 *   2. no session       -> only the (auth) group, minus session-only screens
 *   3. pending challenge-> pinned to that challenge's screen
 *   4. consent required -> pinned to terms acceptance
 *   5. onboarding       -> pinned to the (onboarding) group
 *   6. otherwise        -> (auth)/(onboarding) are dead ends; go home
 *
 * A user pinned by rules 3 or 4 cannot navigate away, which is intended: those
 * are the two states where continuing would mean acting without a completed
 * authentication or without a current agreement. The escape hatch is to abandon
 * the attempt — the challenge screens call `clearChallenge()` (dropping to
 * rule 2) and the acceptance screen offers sign-out and account deletion. There
 * is deliberately no way to skip either one.
 */

export const AUTH_GROUP = '(auth)';
export const ONBOARDING_GROUP = '(onboarding)';

export const ROUTES = {
  signIn: '/(auth)/sign-in',
  signUp: '/(auth)/sign-up',
  verifyEmail: '/(auth)/verify-email',
  forgotPassword: '/(auth)/forgot-password',
  resetPassword: '/(auth)/reset-password',
  mfaChallenge: '/(auth)/mfa-challenge',
  termsAcceptance: '/(auth)/terms-acceptance',
  welcome: '/(onboarding)/welcome',
  createOrJoin: '/(onboarding)/create-or-join',
  createFamily: '/(onboarding)/create-family',
  joinFamily: '/(onboarding)/join-family',
  locationPrimer: '/(onboarding)/location-primer',
  permissions: '/(onboarding)/permissions',
  notificationsPrimer: '/(onboarding)/notifications-primer',
  home: '/',
} as const;

export type AppRoute = (typeof ROUTES)[keyof typeof ROUTES];

/** Screens inside (auth) that require an established session. */
const SESSION_ONLY_AUTH_SCREENS = new Set<string>(['terms-acceptance']);

export type RedirectReason =
  | 'NO_SESSION'
  | 'SESSION_REQUIRED_FOR_SCREEN'
  | 'CHALLENGE_PENDING'
  | 'CONSENT_REQUIRED'
  | 'ONBOARDING_INCOMPLETE'
  | 'ALREADY_ONBOARDED';

export type RouteDecision =
  { type: 'stay' } | { type: 'redirect'; href: AppRoute; reason: RedirectReason };

export type RouteGuardInput = {
  status: SessionStatus;
  challenge: PendingChallenge | null;
  /** Result of `evaluateConsent(...).acceptanceRequired`. */
  consentRequired: boolean;
  /** The signed-in user belongs to at least one family. */
  hasFamily: boolean;
  /**
   * The user has been all the way through the onboarding flow on this device,
   * including the location primer. Reaching the end WITHOUT enabling sharing
   * still completes onboarding — declining is a valid outcome, not a loop.
   */
  onboardingCompleted: boolean;
  /** `useSegments()` output, e.g. `['(auth)', 'sign-in']`. */
  segments: readonly string[];
};

const STAY: RouteDecision = { type: 'stay' };

function redirect(href: AppRoute, reason: RedirectReason): RouteDecision {
  return { type: 'redirect', href, reason };
}

/** Trailing path segment of a route literal: '/(auth)/sign-in' -> 'sign-in'. */
export function screenOf(route: AppRoute): string {
  const parts = route.split('/').filter((part) => part.length > 0 && !part.startsWith('('));
  return parts.length > 0 ? (parts[parts.length - 1] ?? '') : '';
}

function groupOf(segments: readonly string[]): string | null {
  return segments.length > 0 ? (segments[0] ?? null) : null;
}

function screenSegmentOf(segments: readonly string[]): string | null {
  return segments.length > 0 ? (segments[segments.length - 1] ?? null) : null;
}

/**
 * Cognito's only interactive second step is a TOTP code, so `ChallengeKind` has
 * one member and this maps to one screen. The switch is kept rather than
 * collapsed to a ternary because adding a challenge kind must fail here, at the
 * routing decision, rather than silently fall through to sign-in.
 */
export function challengeRoute(challenge: PendingChallenge | null): AppRoute {
  switch (challenge?.kind) {
    case 'MFA':
      return ROUTES.mfaChallenge;
    default:
      // A 'challenge' status with no challenge is unrecoverable state; send the
      // user back to the start rather than stranding them on a blank screen.
      return ROUTES.signIn;
  }
}

/** Where an interrupted onboarding run resumes. */
export function onboardingEntryRoute(hasFamily: boolean): AppRoute {
  return hasFamily ? ROUTES.locationPrimer : ROUTES.welcome;
}

export function resolveRouteDecision(input: RouteGuardInput): RouteDecision {
  const { status, challenge, consentRequired, hasFamily, onboardingCompleted, segments } = input;
  const group = groupOf(segments);
  const screen = screenSegmentOf(segments);

  // 1. Still reading the keychain. Navigating now would fight the restore and
  //    can flash the sign-in screen at a user who is already signed in.
  if (status === 'restoring') {
    return STAY;
  }

  // 2. No session: the (auth) group is the only reachable surface, and the
  //    screens inside it that assume a session are not reachable either.
  if (status === 'unauthenticated') {
    if (group !== AUTH_GROUP) {
      return redirect(ROUTES.signIn, 'NO_SESSION');
    }
    if (screen !== null && SESSION_ONLY_AUTH_SCREENS.has(screen)) {
      return redirect(ROUTES.signIn, 'SESSION_REQUIRED_FOR_SCREEN');
    }
    return STAY;
  }

  // 3. A challenge is an incomplete sign-in, not a session. Pin to its screen.
  if (status === 'challenge') {
    const target = challengeRoute(challenge);
    return screen === screenOf(target) ? STAY : redirect(target, 'CHALLENGE_PENDING');
  }

  // 4. Authenticated but out of date on the documents that govern collecting
  //    their location. Nothing else is reachable until that is resolved.
  if (consentRequired) {
    return screen === screenOf(ROUTES.termsAcceptance)
      ? STAY
      : redirect(ROUTES.termsAcceptance, 'CONSENT_REQUIRED');
  }

  // 5. Onboarding. Note this also catches the just-accepted case: consent is
  //    now satisfied, so terms-acceptance falls through to here and the user is
  //    moved forward rather than left on a screen that no longer applies.
  if (!hasFamily || !onboardingCompleted) {
    return group === ONBOARDING_GROUP
      ? STAY
      : redirect(onboardingEntryRoute(hasFamily), 'ONBOARDING_INCOMPLETE');
  }

  // 6. Fully set up. Both gate groups are dead ends.
  if (group === AUTH_GROUP || group === ONBOARDING_GROUP) {
    return redirect(ROUTES.home, 'ALREADY_ONBOARDED');
  }

  return STAY;
}
