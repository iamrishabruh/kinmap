import {
  AdminConfirmSignUpCommand,
  AdminDeleteUserCommand,
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  RespondToAuthChallengeCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { afterAll, describe, expect, it } from 'vitest';

import { signUpWithPassword } from '../cognito/sign-up';
import { createSrpClient } from '../cognito/srp';

/**
 * The first end-to-end journey against the deployed development environment.
 *
 * Skipped unless KINMAP_LIVE_JOURNEY=1, because it creates a real Cognito user
 * and calls the real API. It is a test rather than a script so that it drives
 * the SAME SRP implementation the app ships — a hand-rolled copy in a scratch
 * file would only prove the copy works.
 *
 *   KINMAP_LIVE_JOURNEY=1 AWS_PROFILE=kinmap-development AWS_REGION=us-east-1 \
 *     pnpm exec vitest run --config src/features/auth/vitest.config.mts journey.live
 */
const LIVE = process.env['KINMAP_LIVE_JOURNEY'] === '1';

const REGION = 'us-east-1';
const USER_POOL_ID = 'us-east-1_XXXXXXXXX';
const POOL_NAME = USER_POOL_ID.split('_')[1] ?? '';
const CLIENT_ID = 'xxxxxxxxxxxxxxxxxxxxxxxxxx';
const API = 'https://api.dev.kinmap.app';

/** Registered on the Apple account; the authorization checker re-verifies it. */
const DEVICE_ID = '018f3a2b-4c5d-7e8f-9a0b-1c2d3e4f5a6b';

const stamp = Date.now();
const email = `journey+${stamp}@dev.kinmap.app`;
const password = `Journey!${stamp}aA1`;
const idp = new CognitoIdentityProviderClient({ region: REGION });

let accessToken = '';

async function signIn(): Promise<string> {
  const client = createSrpClient({ userPoolName: POOL_NAME });

  const started = await idp.send(
    new InitiateAuthCommand({
      AuthFlow: 'USER_SRP_AUTH',
      ClientId: CLIENT_ID,
      AuthParameters: { USERNAME: email, SRP_A: client.srpA },
    }),
  );

  const parameters = started.ChallengeParameters ?? {};
  const claim = await client.derivePasswordClaim({
    userIdForSrp: parameters['USER_ID_FOR_SRP'] ?? '',
    password,
    saltHex: parameters['SALT'] ?? '',
    serverBHex: parameters['SRP_B'] ?? '',
    secretBlock: parameters['SECRET_BLOCK'] ?? '',
  });

  const finished = await idp.send(
    new RespondToAuthChallengeCommand({
      ClientId: CLIENT_ID,
      ChallengeName: 'PASSWORD_VERIFIER',
      ChallengeResponses: {
        USERNAME: parameters['USER_ID_FOR_SRP'] ?? '',
        PASSWORD_CLAIM_SECRET_BLOCK: parameters['SECRET_BLOCK'] ?? '',
        PASSWORD_CLAIM_SIGNATURE: claim.signature,
        TIMESTAMP: claim.timestamp,
      },
    }),
  );

  return finished.AuthenticationResult?.AccessToken ?? '';
}

async function call(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; text: string }> {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      'x-device-id': DEVICE_ID,
      ...(body === undefined ? {} : { 'idempotency-key': `journey-${stamp}-${method}-${path}` }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, text: (await response.text()).slice(0, 400) };
}

describe.skipIf(!LIVE)('live journey', () => {
  afterAll(async () => {
    if (process.env['KINMAP_KEEP_USER'] === '1') return;
    await idp
      .send(new AdminDeleteUserCommand({ UserPoolId: USER_POOL_ID, Username: email }))
      .catch(() => undefined);
  });

  it('creates an account the way the app does, through the client sign-up', async () => {
    // Deliberately NOT AdminCreateUser. That path does not fire
    // PostConfirmation, which is what writes the Users row, so every
    // profile-backed endpoint would answer 404 for a reason that has nothing to
    // do with the product. Signing up the way a person does exercises the
    // consent gate, the trigger, and the profile write together.
    const outcome = await signUpWithPassword({
      email,
      password,
      accepted: { termsVersion: '2026-01-01', privacyPolicyVersion: '2026-01-01' },
    });
    expect(outcome.userSub.length).toBeGreaterThan(0);

    // Confirming by hand stands in for the emailed code; the trigger fires
    // either way, which is the part being exercised.
    await idp.send(new AdminConfirmSignUpCommand({ UserPoolId: USER_POOL_ID, Username: email }));
  }, 60_000);

  it('signs in over SRP with the implementation the app ships', async () => {
    accessToken = await signIn();
    expect(accessToken.length).toBeGreaterThan(0);
  }, 60_000);

  it('walks the product', async () => {
    const steps: Array<[string, { status: number; text: string }]> = [];

    steps.push(['GET  /v1/account', await call('GET', '/v1/account')]);
    steps.push([
      'GET  /v1/subscriptions/entitlements',
      await call('GET', '/v1/subscriptions/entitlements'),
    ]);
    steps.push(['GET  /v1/privacy/sharing', await call('GET', '/v1/privacy/sharing')]);
    steps.push(['GET  /v1/privacy/retention', await call('GET', '/v1/privacy/retention')]);
    steps.push([
      'GET  /v1/account/deletion/preview',
      await call('GET', '/v1/account/deletion/preview'),
    ]);
    steps.push([
      'POST /v1/families',
      await call('POST', '/v1/families', { name: 'Journey Family', timeZone: 'Europe/London' }),
    ]);
    steps.push(['GET  /v1/families', await call('GET', '/v1/families')]);
    steps.push(['GET  /v1/devices', await call('GET', '/v1/devices')]);

    for (const [label, result] of steps) {
      console.log(`  ${label.padEnd(38)} ${result.status}  ${result.text.slice(0, 150)}`);
    }

    // The account must be readable; everything else is reported for inspection.
    expect(steps[0]?.[1].status).toBe(200);
  }, 120_000);
});
