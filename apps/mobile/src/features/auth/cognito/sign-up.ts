import { z } from 'zod';

import { AppError } from '@family/contracts';

import { cognitoConfig } from './config';
import { callCognito } from './idp-client';

/**
 * Creating an account against the Cognito user pool.
 *
 * The client had no sign-up path at all — a route constant pointing at a screen
 * that did not exist, and an API layer that posted to `/v1/auth/otp/start`,
 * which the deployed API has never declared. There was no way to become a user.
 *
 * TERMS ARE NOT OPTIONAL HERE. The pool's PreSignUp trigger refuses an account
 * whose acceptance is absent or stale:
 *
 *   PreSignUp failed with error The current terms of service and privacy policy
 *   must be accepted before creating an account.
 *
 * That gate is the reason this function takes the versions as a required
 * argument rather than reading them from somewhere convenient. A caller cannot
 * forget them, and a screen cannot create an account for somebody who has not
 * been shown what they are agreeing to.
 *
 * `ValidationData` rather than `ClientMetadata`, because the trigger reads
 * validation data first and it is the field Cognito documents for sign-up.
 */

const SignUpResponseSchema = z.object({
  UserSub: z.string().min(1),
  UserConfirmed: z.boolean(),
  CodeDeliveryDetails: z
    .object({
      AttributeName: z.string().optional(),
      DeliveryMedium: z.string().optional(),
      /** Already masked by Cognito, e.g. `a***@e***.com`. */
      Destination: z.string().optional(),
    })
    .optional(),
});

export type SignUpOutcome = {
  /** The pool's own id for the new account. */
  readonly userSub: string;
  /**
   * False when a verification code has been sent and must be confirmed before
   * the account can sign in.
   */
  readonly confirmed: boolean;
  /** Masked by Cognito; safe to show, and never the address the user typed. */
  readonly codeSentTo: string | null;
};

export type PolicyAcceptance = {
  readonly termsVersion: string;
  readonly privacyPolicyVersion: string;
};

export async function signUpWithPassword(input: {
  readonly email: string;
  readonly password: string;
  readonly accepted: PolicyAcceptance;
  /**
   * `YYYY-MM-DD`, as attested on the age screen.
   *
   * Sent so the PreSignUp trigger can apply the minimum age, and NOT sent as a
   * user attribute: it is compared server-side and discarded, so it never
   * becomes part of the account. The gate is enforced there rather than here
   * because `SignUp` is a public Cognito API and a client-side check is a
   * suggestion.
   */
  readonly birthDate: string;
}): Promise<SignUpOutcome> {
  const response = await callCognito(
    'SignUp',
    {
      ClientId: cognitoConfig().clientId,
      Username: input.email,
      Password: input.password,
      UserAttributes: [{ Name: 'email', Value: input.email }],
      // Read by the PreSignUp trigger. Without them the account is refused.
      ValidationData: [
        { Name: 'termsVersion', Value: input.accepted.termsVersion },
        { Name: 'privacyPolicyVersion', Value: input.accepted.privacyPolicyVersion },
        { Name: 'birthDate', Value: input.birthDate },
      ],
      ClientMetadata: {
        termsVersion: input.accepted.termsVersion,
        privacyPolicyVersion: input.accepted.privacyPolicyVersion,
        birthDate: input.birthDate,
      },
    },
    SignUpResponseSchema,
  );

  return {
    userSub: response.UserSub,
    confirmed: response.UserConfirmed,
    codeSentTo: response.CodeDeliveryDetails?.Destination ?? null,
  };
}

const ConfirmSignUpResponseSchema = z.object({});

/**
 * Confirms a new account with the code Cognito emailed.
 *
 * The failure is deliberately not distinguished from a wrong code: telling a
 * caller that an address is unknown turns this into an account-existence
 * oracle, which for a location product is a way to confirm somebody uses it.
 */
export async function confirmSignUp(input: {
  readonly email: string;
  readonly code: string;
}): Promise<void> {
  try {
    await callCognito(
      'ConfirmSignUp',
      {
        ClientId: cognitoConfig().clientId,
        Username: input.email,
        ConfirmationCode: input.code,
      },
      ConfirmSignUpResponseSchema,
    );
  } catch (error) {
    // Collapsed to one answer, on purpose, and not by reusing the shared error
    // mapper.
    //
    // That mapper is correct where it is used: for an MFA challenge, existence
    // is already proven, so a specific "that code is wrong" costs nothing. This
    // is the opposite situation. Confirmation happens BEFORE anyone is
    // authenticated, so distinguishing UserNotFoundException from
    // CodeMismatchException tells an unauthenticated caller whether an address
    // has an account here — which, for a location product, is a way to find out
    // whether somebody uses it.
    //
    // A rate limit is still surfaced separately: it is a fact about the caller,
    // not about whether the account exists.
    if (error instanceof AppError && error.code === 'RATE_LIMITED') {
      throw error;
    }
    throw new AppError(
      'VALIDATION_FAILED',
      'That confirmation code is not valid. Request a new one and try again.',
    );
  }
}
