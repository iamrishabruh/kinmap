import { createSign } from 'node:crypto';

import type { PushPayload } from '@family/schemas';

import type { PushSendOutcome, PushSender, PushTarget } from '../ports.js';

/**
 * Direct delivery through the FCM HTTP v1 API, for deployments that address
 * Android devices without an SNS platform application in front.
 *
 * The service-account private key never leaves this module and is never logged.
 * The bearer token is cached in memory for slightly less than its lifetime, so
 * a warm container does not re-sign on every notification.
 */

export type FcmServiceAccount = {
  readonly projectId: string;
  readonly clientEmail: string;
  /** PEM-encoded RSA private key. Credential-grade; never logged. */
  readonly privateKey: string;
  readonly tokenUri?: string;
};

export interface AccessTokenProvider {
  getAccessToken(): Promise<string>;
}

const GOOGLE_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const TOKEN_LIFETIME_SECONDS = 3600;
const TOKEN_REFRESH_MARGIN_SECONDS = 120;

function base64Url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** Signs the standard JWT-bearer assertion and exchanges it for an access token. */
export class ServiceAccountTokenProvider implements AccessTokenProvider {
  private cachedToken: string | null = null;
  private cachedUntilMs = 0;

  constructor(
    private readonly account: FcmServiceAccount,
    private readonly now: () => number = Date.now,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async getAccessToken(): Promise<string> {
    if (this.cachedToken !== null && this.now() < this.cachedUntilMs) {
      return this.cachedToken;
    }

    const tokenUri = this.account.tokenUri ?? GOOGLE_TOKEN_URI;
    const issuedAt = Math.floor(this.now() / 1000);
    const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = base64Url(
      JSON.stringify({
        iss: this.account.clientEmail,
        scope: FCM_SCOPE,
        aud: tokenUri,
        iat: issuedAt,
        exp: issuedAt + TOKEN_LIFETIME_SECONDS,
      }),
    );

    const signer = createSign('RSA-SHA256');
    signer.update(`${header}.${claims}`);
    const signature = base64Url(signer.sign(this.account.privateKey));
    const assertion = `${header}.${claims}.${signature}`;

    const response = await this.fetchImpl(tokenUri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString(),
    });

    if (!response.ok) {
      // The body may echo the assertion; only the status is surfaced.
      throw new Error(`FCM token exchange failed with status ${String(response.status)}.`);
    }

    const parsed = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof parsed.access_token !== 'string' || parsed.access_token.length === 0) {
      throw new Error('FCM token exchange returned no access token.');
    }

    const lifetime =
      typeof parsed.expires_in === 'number' && Number.isFinite(parsed.expires_in)
        ? parsed.expires_in
        : TOKEN_LIFETIME_SECONDS;
    this.cachedToken = parsed.access_token;
    this.cachedUntilMs = this.now() + Math.max(0, lifetime - TOKEN_REFRESH_MARGIN_SECONDS) * 1000;
    return this.cachedToken;
  }
}

/** FCM error statuses that mean the registration token is permanently dead. */
const DEAD_TOKEN_STATUSES = new Set(['UNREGISTERED', 'NOT_FOUND', 'INVALID_ARGUMENT']);

export class FcmPushSender implements PushSender {
  constructor(
    private readonly projectId: string,
    private readonly tokens: AccessTokenProvider,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(input: {
    target: PushTarget;
    payload: PushPayload;
    title: string;
    body: string;
  }): Promise<PushSendOutcome> {
    const registrationToken = input.target.pushToken;
    if (registrationToken === null) {
      return { status: 'INVALID_ENDPOINT', reason: 'NoToken' };
    }

    let accessToken: string;
    try {
      accessToken = await this.tokens.getAccessToken();
    } catch {
      return { status: 'RETRYABLE', reason: 'TokenExchangeFailed' };
    }

    let response: Response;
    try {
      response = await this.fetchImpl(
        `https://fcm.googleapis.com/v1/projects/${this.projectId}/messages:send`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${accessToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            message: {
              token: registrationToken,
              notification: { title: input.title, body: input.body },
              data: { payload: JSON.stringify(input.payload) },
              android: { priority: 'HIGH' },
            },
          }),
        },
      );
    } catch {
      return { status: 'RETRYABLE', reason: 'NetworkError' };
    }

    if (response.ok) {
      const parsed = (await response.json().catch(() => ({}))) as { name?: unknown };
      return {
        status: 'DELIVERED',
        providerMessageId: typeof parsed.name === 'string' ? parsed.name : null,
      };
    }

    const reason = await readErrorStatus(response);
    if (response.status === 404 || DEAD_TOKEN_STATUSES.has(reason)) {
      return { status: 'INVALID_ENDPOINT', reason };
    }
    return { status: 'RETRYABLE', reason };
  }
}

/** Extracts only the machine-readable status; the message may echo the token. */
async function readErrorStatus(response: Response): Promise<string> {
  try {
    const parsed = (await response.json()) as { error?: { status?: unknown } };
    const status = parsed.error?.status;
    return typeof status === 'string' ? status : `HTTP_${String(response.status)}`;
  } catch {
    return `HTTP_${String(response.status)}`;
  }
}
