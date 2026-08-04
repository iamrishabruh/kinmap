import { AppError } from '@family/contracts';
import type { AuthSession } from '@family/schemas';

import { cognitoConfig } from './config';
import { COGNITO_ERROR_MESSAGES } from './errors';
import { initiateAuth, respondToAuthChallenge, type AuthResponse } from './idp-client';
import { toAuthSession, type RefreshCarryForward } from './session';
import { createSrpClient } from './srp';

/**
 * The sign-in flows the deployed app client actually permits.
 *
 * `ExplicitAuthFlows` on `kinmap-development-mobile` is exactly
 * `['ALLOW_USER_SRP_AUTH']`, and that is not an oversight to work around:
 * `identity-stack.ts` sets it explicitly because Cognito refuses
 * `ALLOW_REFRESH_TOKEN_AUTH` on a client with refresh-token rotation enabled,
 * while still servicing refreshes through the rotation feature. So there are
 * two flows here and no third: SRP for a password, `REFRESH_TOKEN_AUTH` for
 * everything after.
 *
 * DEVICES ARE NEVER REMEMBERED. Device tracking is on for the pool, so a
 * successful sign-in carries `NewDeviceMetadata`, and confirming it would let
 * subsequent sign-ins skip a factor. This client deliberately never calls
 * `ConfirmDevice`: remembering a handset is a consented, user-visible decision,
 * and device identity in this product comes from the separate device
 * registration step — not from silently profiling the phone during sign-in. A
 * side effect worth stating, because it is what makes the challenge handling
 * below exhaustive: an unremembered device is never issued a `DEVICE_SRP_AUTH`
 * challenge.
 */

const PASSWORD_VERIFIER = 'PASSWORD_VERIFIER';
const SOFTWARE_TOKEN_MFA = 'SOFTWARE_TOKEN_MFA';

/**
 * An MFA challenge in flight.
 *
 * `session` is Cognito's opaque challenge state. It is not a token and grants
 * nothing on its own, but it is short-lived credential-adjacent state: it lives
 * in memory for the length of the challenge, is never written to the keychain,
 * never becomes a route parameter, and is never logged.
 */
export type CognitoMfaChallenge = {
  readonly session: string;
  /** Echoed back as `USERNAME`; the pool's own id for the account. */
  readonly userIdForSrp: string;
};

export type CognitoSignInOutcome =
  | { readonly kind: 'session'; readonly session: AuthSession }
  | { readonly kind: 'mfa'; readonly challenge: CognitoMfaChallenge };

function unusableResponse(): AppError {
  return new AppError('INTERNAL_ERROR', COGNITO_ERROR_MESSAGES.INTERNAL);
}

/**
 * Turns a Cognito auth response into an outcome.
 *
 * Any challenge other than software-token MFA is treated as unusable rather
 * than half-handled. `MFA_SETUP`, `NEW_PASSWORD_REQUIRED`, `SELECT_MFA_TYPE`
 * and `DEVICE_SRP_AUTH` cannot arise from this pool's configuration, and
 * pretending to handle one would produce a screen that silently does nothing.
 */
function interpret(response: AuthResponse, userIdForSrp: string): CognitoSignInOutcome {
  if (response.AuthenticationResult !== undefined) {
    return { kind: 'session', session: toAuthSession(response.AuthenticationResult) };
  }

  if (response.ChallengeName === SOFTWARE_TOKEN_MFA) {
    const session = response.Session;
    if (session === undefined) throw unusableResponse();
    return {
      kind: 'mfa',
      challenge: {
        session,
        userIdForSrp: response.ChallengeParameters?.USER_ID_FOR_SRP ?? userIdForSrp,
      },
    };
  }

  throw unusableResponse();
}

/**
 * Signs in with an email address and a password.
 *
 * The password is passed straight into the SRP transcript and never leaves this
 * process: what goes on the wire is a public value and a signature. The address
 * is sent, because the pool has to be told which account is being attempted,
 * and the pool's `PreventUserExistenceErrors` is what keeps that from being an
 * oracle — an unknown address is answered with a decoy salt and `SRP_B` so the
 * handshake proceeds identically and fails identically.
 */
export async function signInWithPassword(
  email: string,
  password: string,
): Promise<CognitoSignInOutcome> {
  const config = cognitoConfig();
  const srp = createSrpClient({ userPoolName: config.userPoolName });

  const started = await initiateAuth({
    AuthFlow: 'USER_SRP_AUTH',
    ClientId: config.clientId,
    AuthParameters: { USERNAME: email.trim(), SRP_A: srp.srpA },
  });

  if (started.ChallengeName !== PASSWORD_VERIFIER) {
    throw unusableResponse();
  }

  const parameters = started.ChallengeParameters;
  const userIdForSrp = parameters?.USER_ID_FOR_SRP;
  const saltHex = parameters?.SALT;
  const serverBHex = parameters?.SRP_B;
  const secretBlock = parameters?.SECRET_BLOCK;
  if (
    userIdForSrp === undefined ||
    saltHex === undefined ||
    serverBHex === undefined ||
    secretBlock === undefined
  ) {
    throw unusableResponse();
  }

  const claim = await srp.derivePasswordClaim({
    userIdForSrp,
    password,
    saltHex,
    serverBHex,
    secretBlock,
  });

  const answered = await respondToAuthChallenge({
    ChallengeName: PASSWORD_VERIFIER,
    ClientId: config.clientId,
    ...(started.Session === undefined ? {} : { Session: started.Session }),
    ChallengeResponses: {
      USERNAME: userIdForSrp,
      PASSWORD_CLAIM_SECRET_BLOCK: secretBlock,
      PASSWORD_CLAIM_SIGNATURE: claim.signature,
      TIMESTAMP: claim.timestamp,
    },
  });

  return interpret(answered, userIdForSrp);
}

/**
 * Answers a software-token MFA challenge.
 *
 * Failures here are allowed to be specific — a wrong code says so — because by
 * this point the caller has already proved the password. Nothing is disclosed
 * that they did not already know.
 */
export async function answerMfaChallenge(
  challenge: CognitoMfaChallenge,
  code: string,
): Promise<CognitoSignInOutcome> {
  const config = cognitoConfig();
  const answered = await respondToAuthChallenge({
    ChallengeName: SOFTWARE_TOKEN_MFA,
    ClientId: config.clientId,
    Session: challenge.session,
    ChallengeResponses: {
      USERNAME: challenge.userIdForSrp,
      SOFTWARE_TOKEN_MFA_CODE: code,
    },
  });
  return interpret(answered, challenge.userIdForSrp);
}

/**
 * Exchanges a refresh token for a fresh access token.
 *
 * With rotation enabled the response normally carries a new refresh token and
 * retires the one that was used, which is why the previous credential is passed
 * in: if this particular response omits one, the caller keeps what it had
 * rather than losing the session to a field that was merely absent.
 */
export async function refreshTokens(carryForward: RefreshCarryForward): Promise<AuthSession> {
  const config = cognitoConfig();
  const response = await initiateAuth({
    AuthFlow: 'REFRESH_TOKEN_AUTH',
    ClientId: config.clientId,
    AuthParameters: { REFRESH_TOKEN: carryForward.refreshToken },
  });

  if (response.AuthenticationResult === undefined) {
    throw unusableResponse();
  }
  return toAuthSession(response.AuthenticationResult, carryForward);
}
