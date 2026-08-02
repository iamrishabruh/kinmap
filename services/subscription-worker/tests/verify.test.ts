import { describe, expect, it } from 'vitest';

import {
  verifyAppleSignedPayload,
  verifyCertificateChain,
  decodeVerifiedNestedJws,
} from '../src/verify/apple.js';
import {
  decodeRtdnMessage,
  extractBearerToken,
  verifyGoogleRtdn,
  type OidcTokenVerifier,
} from '../src/verify/google.js';
import {
  extractBearerSecret,
  timingSafeStringEqual,
  verifyRevenueCatWebhook,
} from '../src/verify/revenuecat.js';

const SECRET = 'a-very-long-shared-secret-value';

describe('RevenueCat shared-secret verification', () => {
  it('accepts the configured secret in any of the header spellings', () => {
    for (const header of [SECRET, `Bearer ${SECRET}`, `token ${SECRET}`]) {
      expect(
        verifyRevenueCatWebhook({ authorizationHeader: header, expectedSecret: SECRET }).verified,
      ).toBe(true);
    }
  });

  it('rejects a wrong secret', () => {
    const result = verifyRevenueCatWebhook({
      authorizationHeader: `Bearer ${SECRET}x`,
      expectedSecret: SECRET,
    });
    expect(result).toEqual({ verified: false, reason: 'MISMATCH' });
  });

  it('rejects a missing header', () => {
    expect(
      verifyRevenueCatWebhook({ authorizationHeader: undefined, expectedSecret: SECRET }),
    ).toEqual({ verified: false, reason: 'MISSING' });
  });

  it('fails closed when the provider is not configured', () => {
    expect(
      verifyRevenueCatWebhook({
        authorizationHeader: `Bearer ${SECRET}`,
        expectedSecret: undefined,
      }),
    ).toEqual({ verified: false, reason: 'NOT_CONFIGURED' });
    expect(
      verifyRevenueCatWebhook({ authorizationHeader: `Bearer ${SECRET}`, expectedSecret: '' }),
    ).toEqual({ verified: false, reason: 'NOT_CONFIGURED' });
  });

  it('compares without leaking length through an exception', () => {
    // timingSafeEqual throws on unequal lengths; hashing both sides first is
    // what stops a length oracle. A one-character secret must simply be false.
    expect(timingSafeStringEqual('a', SECRET)).toBe(false);
    expect(timingSafeStringEqual(SECRET, SECRET)).toBe(true);
    expect(timingSafeStringEqual('', '')).toBe(true);
  });

  it('extracts the secret from the header, not the scheme', () => {
    expect(extractBearerSecret('Bearer abc')).toBe('abc');
    expect(extractBearerSecret('  abc  ')).toBe('abc');
    expect(extractBearerSecret('')).toBeNull();
    expect(extractBearerSecret(undefined)).toBeNull();
  });
});

describe('Apple signed-payload verification', () => {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');

  it('refuses a payload that is not a three-part JWS', () => {
    expect(verifyAppleSignedPayload('not.a.jws.token', { rootCertificates: [] })).toEqual({
      verified: false,
      reason: 'MALFORMED_JWS',
    });
    expect(verifyAppleSignedPayload('single-segment', { rootCertificates: [] })).toEqual({
      verified: false,
      reason: 'MALFORMED_JWS',
    });
  });

  it('refuses any algorithm other than ES256, including "none"', () => {
    const token = `${encode({ alg: 'none' })}.${encode({ notificationType: 'TEST' })}.`;
    expect(verifyAppleSignedPayload(token, { rootCertificates: [] })).toEqual({
      verified: false,
      reason: 'UNSUPPORTED_ALGORITHM',
    });

    const hs256 = `${encode({ alg: 'HS256', x5c: [] })}.${encode({})}.sig`;
    expect(verifyAppleSignedPayload(hs256, { rootCertificates: [] })).toEqual({
      verified: false,
      reason: 'UNSUPPORTED_ALGORITHM',
    });
  });

  it('refuses an ES256 header carrying no certificate chain', () => {
    const token = `${encode({ alg: 'ES256' })}.${encode({})}.sig`;
    expect(verifyAppleSignedPayload(token, { rootCertificates: [] })).toEqual({
      verified: false,
      reason: 'MISSING_CHAIN',
    });
  });

  it('refuses a self-signed single-certificate chain', () => {
    const result = verifyCertificateChain(['aGVsbG8='], {
      rootCertificates: [Buffer.from('anything')],
    });
    expect(result).toEqual({ ok: false, reason: 'MISSING_CHAIN' });
  });

  it('fails closed when no Apple Root CA is configured', () => {
    const result = verifyCertificateChain(['aGVsbG8=', 'd29ybGQ='], { rootCertificates: [] });
    expect(result).toEqual({ ok: false, reason: 'NOT_CONFIGURED' });
  });

  it('refuses a chain whose certificates do not parse', () => {
    const result = verifyCertificateChain(['not-a-certificate', 'also-not'], {
      rootCertificates: [Buffer.from('anything')],
    });
    expect(result).toEqual({ ok: false, reason: 'MALFORMED_CERTIFICATE' });
  });

  it('decodes a nested JWS payload segment', () => {
    const nested = `${encode({ alg: 'ES256' })}.${encode({ productId: 'p1' })}.sig`;
    expect(decodeVerifiedNestedJws(nested)).toEqual({ productId: 'p1' });
    expect(decodeVerifiedNestedJws('bad')).toBeNull();
  });
});

describe('Google Pub/Sub OIDC verification', () => {
  const PUSHER = 'play-rtdn@kinmap.iam.gserviceaccount.com';

  function verifier(claims: Record<string, unknown>): OidcTokenVerifier {
    return { verify: () => Promise.resolve(claims) };
  }

  const rejecting: OidcTokenVerifier = {
    verify: () => Promise.reject(new Error('bad signature')),
  };

  it('accepts a token from the authorised service account', async () => {
    const result = await verifyGoogleRtdn({
      authorizationHeader: 'Bearer token',
      verifier: verifier({ email: PUSHER, email_verified: true }),
      expectedServiceAccountEmail: PUSHER,
    });

    expect(result.verified).toBe(true);
  });

  it('refuses a valid Google token issued to a different service account', async () => {
    const result = await verifyGoogleRtdn({
      authorizationHeader: 'Bearer token',
      verifier: verifier({ email: 'someone-else@example.com', email_verified: true }),
      expectedServiceAccountEmail: PUSHER,
    });

    expect(result).toEqual({ verified: false, reason: 'WRONG_SERVICE_ACCOUNT' });
  });

  it('refuses an unverified email claim', async () => {
    const result = await verifyGoogleRtdn({
      authorizationHeader: 'Bearer token',
      verifier: verifier({ email: PUSHER, email_verified: false }),
      expectedServiceAccountEmail: PUSHER,
    });

    expect(result).toEqual({ verified: false, reason: 'UNVERIFIED_EMAIL' });
  });

  it('refuses a token that does not verify', async () => {
    const result = await verifyGoogleRtdn({
      authorizationHeader: 'Bearer token',
      verifier: rejecting,
      expectedServiceAccountEmail: PUSHER,
    });

    expect(result).toEqual({ verified: false, reason: 'BAD_TOKEN' });
  });

  it('refuses a request with no bearer token at all', async () => {
    const result = await verifyGoogleRtdn({
      authorizationHeader: undefined,
      verifier: verifier({ email: PUSHER, email_verified: true }),
      expectedServiceAccountEmail: PUSHER,
    });

    expect(result).toEqual({ verified: false, reason: 'MISSING_TOKEN' });
  });

  it('fails closed when the provider is not configured', async () => {
    const result = await verifyGoogleRtdn({
      authorizationHeader: 'Bearer token',
      verifier: undefined,
      expectedServiceAccountEmail: PUSHER,
    });

    expect(result).toEqual({ verified: false, reason: 'NOT_CONFIGURED' });
  });

  it('extracts only a bearer token', () => {
    expect(extractBearerToken('Bearer abc')).toBe('abc');
    expect(extractBearerToken('Basic abc')).toBeNull();
    expect(extractBearerToken(undefined)).toBeNull();
  });

  it('decodes the base64 RTDN payload', () => {
    const encoded = Buffer.from(JSON.stringify({ packageName: 'com.kinmap.app' })).toString(
      'base64',
    );
    expect(decodeRtdnMessage(encoded)).toEqual({ packageName: 'com.kinmap.app' });
    expect(decodeRtdnMessage('not-base64-json')).toBeNull();
  });
});
