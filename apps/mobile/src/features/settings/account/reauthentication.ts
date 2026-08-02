/**
 * Reauthentication, required before any irreversible account action (spec §16).
 *
 * The rule this enforces: possession of an unlocked phone is not consent to
 * destroy an account. A phone left on a table, handed to someone, or taken
 * during an argument must not be enough to erase the owner's location history
 * and dissolve their family — which, in a product where families sometimes stop
 * being friendly, is a realistic threat and not a theoretical one.
 *
 * The concrete mechanism (passkey, biometric, OTP, OAuth re-consent) belongs to
 * the auth feature. This module owns the *contract* and, more importantly, the
 * freshness rule that the deletion flow refuses to proceed without.
 */

export type ReauthenticationMethod = 'PASSKEY' | 'BIOMETRIC' | 'OTP' | 'OAUTH';

export type ReauthenticationReason =
  'DELETE_ACCOUNT' | 'DELETE_HISTORY' | 'REVOKE_DEVICE' | 'TRANSFER_OWNERSHIP';

/** Evidence that the account holder proved who they were, and when. */
export type ReauthenticationProof = {
  method: ReauthenticationMethod;
  /** ISO-8601 instant at which the challenge was satisfied. */
  completedAt: string;
  /**
   * Server-issued, single-use token bound to the reauthentication. Sent with
   * the destructive request so the server can independently verify the step
   * happened — a client-side boolean is not a security control.
   */
  proofToken: string;
};

export type ReauthenticationResult =
  | { ok: true; proof: ReauthenticationProof }
  | { ok: false; failure: 'CANCELLED' | 'FAILED' | 'UNAVAILABLE' };

export interface ReauthenticationProvider {
  reauthenticate(reason: ReauthenticationReason): Promise<ReauthenticationResult>;
}

/**
 * How long a reauthentication counts for. Short enough that walking away from
 * an unlocked phone mid-flow does not leave a loaded gun on the table; long
 * enough to read the consequences screen properly.
 */
export const REAUTHENTICATION_FRESHNESS_SECONDS = 300;

let provider: ReauthenticationProvider | null = null;

export function registerReauthenticationProvider(next: ReauthenticationProvider | null): void {
  provider = next;
}

export function getReauthenticationProvider(): ReauthenticationProvider | null {
  return provider;
}

/**
 * True when the proof is recent enough to authorise a destructive action.
 *
 * A proof timestamped in the future is rejected rather than accepted: a clock
 * that disagrees with the server is exactly the situation in which we should
 * ask again, not the situation in which we should trust harder.
 */
export function isReauthenticationFresh(
  proof: ReauthenticationProof | null,
  now: Date = new Date(),
): boolean {
  if (!proof) return false;
  if (!proof.proofToken) return false;

  const completedAt = Date.parse(proof.completedAt);
  if (Number.isNaN(completedAt)) return false;

  const ageSeconds = (now.getTime() - completedAt) / 1000;
  if (ageSeconds < 0) return false;

  return ageSeconds <= REAUTHENTICATION_FRESHNESS_SECONDS;
}

/**
 * Runs the registered provider. When none is registered the answer is
 * UNAVAILABLE — never "assume it passed". A missing provider must fail closed.
 */
export async function reauthenticate(
  reason: ReauthenticationReason,
): Promise<ReauthenticationResult> {
  if (!provider) return { ok: false, failure: 'UNAVAILABLE' };
  return provider.reauthenticate(reason);
}
