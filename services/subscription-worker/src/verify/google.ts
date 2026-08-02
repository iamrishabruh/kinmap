import { JwtVerifier } from 'aws-jwt-verify';

/**
 * Google Play Real-Time Developer Notifications verification.
 *
 * RTDN arrives as a Google Cloud Pub/Sub push. The message body itself is
 * unauthenticated — anyone can POST a base64 blob — so the trust anchor is the
 * OIDC token Pub/Sub puts in the `Authorization` header. It must:
 *
 *  1. be signed by Google (verified against Google's published JWKS);
 *  2. carry the audience we configured on the push subscription, so a token
 *     minted for a *different* service cannot be replayed at us;
 *  3. carry the verified email of the service account we authorised to push.
 *
 * The last check is the one that is easy to forget and the one that matters:
 * without it any Google-issued OIDC token for our audience would be accepted.
 */

export const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'] as const;
export const GOOGLE_JWKS_URI = 'https://www.googleapis.com/oauth2/v3/certs';

export type GoogleVerificationFailure =
  'NOT_CONFIGURED' | 'MISSING_TOKEN' | 'BAD_TOKEN' | 'WRONG_SERVICE_ACCOUNT' | 'UNVERIFIED_EMAIL';

export type GoogleVerificationResult =
  | { readonly verified: true; readonly claims: Record<string, unknown> }
  | { readonly verified: false; readonly reason: GoogleVerificationFailure };

/** Seam so the pipeline is testable without reaching Google's JWKS endpoint. */
export interface OidcTokenVerifier {
  verify(token: string): Promise<Record<string, unknown>>;
}

export function createGooglePubSubVerifier(audience: string): OidcTokenVerifier {
  const verifier = JwtVerifier.create({
    issuer: GOOGLE_ISSUERS[0],
    audience,
    jwksUri: GOOGLE_JWKS_URI,
  });
  return {
    async verify(token: string): Promise<Record<string, unknown>> {
      return (await verifier.verify(token)) as unknown as Record<string, unknown>;
    },
  };
}

export function extractBearerToken(headerValue: string | undefined): string | null {
  if (headerValue === undefined) return null;
  const match = /^bearer\s+(.+)$/i.exec(headerValue.trim());
  return match?.[1]?.trim() ?? null;
}

export async function verifyGoogleRtdn(input: {
  authorizationHeader: string | undefined;
  verifier: OidcTokenVerifier | undefined;
  expectedServiceAccountEmail: string | undefined;
}): Promise<GoogleVerificationResult> {
  if (input.verifier === undefined || input.expectedServiceAccountEmail === undefined) {
    return { verified: false, reason: 'NOT_CONFIGURED' };
  }

  const token = extractBearerToken(input.authorizationHeader);
  if (token === null) {
    return { verified: false, reason: 'MISSING_TOKEN' };
  }

  let claims: Record<string, unknown>;
  try {
    claims = await input.verifier.verify(token);
  } catch {
    // Expired, wrong audience, wrong issuer and bad signature are one answer.
    return { verified: false, reason: 'BAD_TOKEN' };
  }

  if (claims.email_verified !== true) {
    return { verified: false, reason: 'UNVERIFIED_EMAIL' };
  }
  if (claims.email !== input.expectedServiceAccountEmail) {
    return { verified: false, reason: 'WRONG_SERVICE_ACCOUNT' };
  }

  return { verified: true, claims };
}

/** Decodes the base64 `message.data` blob into the RTDN JSON object. */
export function decodeRtdnMessage(data: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(data, 'base64').toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}
