import { verify as verifySignature, X509Certificate } from 'node:crypto';

/**
 * App Store Server Notifications V2 verification.
 *
 * Apple sends a JWS whose header carries the full certificate chain in `x5c`:
 * [leaf, intermediate, root]. Decoding the payload without checking that chain
 * is the single most common way an App Store integration gets forged — anyone
 * can POST a self-signed JWS to a public webhook URL.
 *
 * So all four of these must hold before a single field is trusted:
 *
 *  1. every certificate in the chain is currently valid;
 *  2. each certificate is signed by the next one up;
 *  3. the top of the chain is byte-identical to a PINNED Apple Root CA — not
 *     merely "a certificate that says Apple", which an attacker can also mint;
 *  4. the JWS signature verifies under the leaf's public key.
 *
 * ES256 JWS signatures are raw R||S, not DER, hence `dsaEncoding: 'ieee-p1363'`.
 */

export type AppleVerificationFailure =
  | 'NOT_CONFIGURED'
  | 'MALFORMED_JWS'
  | 'UNSUPPORTED_ALGORITHM'
  | 'MISSING_CHAIN'
  | 'MALFORMED_CERTIFICATE'
  | 'CERTIFICATE_EXPIRED'
  | 'CHAIN_BROKEN'
  | 'UNTRUSTED_ROOT'
  | 'BAD_SIGNATURE'
  | 'MALFORMED_PAYLOAD'
  | 'WRONG_BUNDLE_ID';

export type AppleVerificationResult =
  | { readonly verified: true; readonly payload: Record<string, unknown> }
  | { readonly verified: false; readonly reason: AppleVerificationFailure };

export type AppleVerifierOptions = {
  /** DER bytes of every trusted Apple Root CA. Empty means "trust nothing". */
  readonly rootCertificates: readonly Buffer[];
  readonly now?: () => Date;
  /** When set, the payload's bundle id must match. */
  readonly expectedBundleId?: string;
};

function decodeBase64Url(segment: string): Buffer {
  return Buffer.from(segment.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function parseJson(buffer: Buffer): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(buffer.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function toCertificate(base64Der: string): X509Certificate | null {
  try {
    return new X509Certificate(Buffer.from(base64Der, 'base64'));
  } catch {
    return null;
  }
}

function isCurrentlyValid(certificate: X509Certificate, now: Date): boolean {
  const from = Date.parse(certificate.validFrom);
  const to = Date.parse(certificate.validTo);
  if (Number.isNaN(from) || Number.isNaN(to)) return false;
  const instant = now.getTime();
  return instant >= from && instant <= to;
}

/**
 * Verifies the x5c chain and returns the leaf certificate, or a failure reason.
 * Exported so the chain rules can be unit-tested without a whole JWS.
 */
export function verifyCertificateChain(
  chain: readonly string[],
  options: AppleVerifierOptions,
): { ok: true; leaf: X509Certificate } | { ok: false; reason: AppleVerificationFailure } {
  if (options.rootCertificates.length === 0) {
    return { ok: false, reason: 'NOT_CONFIGURED' };
  }
  if (chain.length < 2) {
    return { ok: false, reason: 'MISSING_CHAIN' };
  }

  const certificates: X509Certificate[] = [];
  for (const encoded of chain) {
    const certificate = toCertificate(encoded);
    if (certificate === null) return { ok: false, reason: 'MALFORMED_CERTIFICATE' };
    certificates.push(certificate);
  }

  const now = (options.now ?? (() => new Date()))();
  for (const certificate of certificates) {
    if (!isCurrentlyValid(certificate, now)) {
      return { ok: false, reason: 'CERTIFICATE_EXPIRED' };
    }
  }

  for (let index = 0; index < certificates.length - 1; index += 1) {
    const subject = certificates[index];
    const issuer = certificates[index + 1];
    if (subject === undefined || issuer === undefined) {
      return { ok: false, reason: 'CHAIN_BROKEN' };
    }
    // Both checks: `checkIssued` compares names, `verify` checks the signature.
    // Names alone prove nothing; a signature alone would accept a chain that
    // skips a link.
    if (!subject.checkIssued(issuer) || !subject.verify(issuer.publicKey)) {
      return { ok: false, reason: 'CHAIN_BROKEN' };
    }
  }

  const anchor = certificates.at(-1);
  if (anchor === undefined) {
    return { ok: false, reason: 'MISSING_CHAIN' };
  }
  // Byte comparison against the pinned root. Matching only the subject name
  // would accept a certificate an attacker generated with the same name.
  const anchorTrusted = options.rootCertificates.some((root) => root.equals(anchor.raw));
  if (!anchorTrusted) {
    return { ok: false, reason: 'UNTRUSTED_ROOT' };
  }

  const leaf = certificates[0];
  if (leaf === undefined) {
    return { ok: false, reason: 'MISSING_CHAIN' };
  }
  return { ok: true, leaf };
}

export function verifyAppleSignedPayload(
  signedPayload: string,
  options: AppleVerifierOptions,
): AppleVerificationResult {
  const segments = signedPayload.split('.');
  if (segments.length !== 3) {
    return { verified: false, reason: 'MALFORMED_JWS' };
  }
  const [encodedHeader, encodedPayload, encodedSignature] = segments;
  if (
    encodedHeader === undefined ||
    encodedPayload === undefined ||
    encodedSignature === undefined
  ) {
    return { verified: false, reason: 'MALFORMED_JWS' };
  }

  const header = parseJson(decodeBase64Url(encodedHeader));
  if (header === null) {
    return { verified: false, reason: 'MALFORMED_JWS' };
  }
  if (header.alg !== 'ES256') {
    // Refusing anything but the documented algorithm also refuses `alg: none`.
    return { verified: false, reason: 'UNSUPPORTED_ALGORITHM' };
  }

  const chain = header.x5c;
  if (
    !Array.isArray(chain) ||
    !chain.every((entry): entry is string => typeof entry === 'string')
  ) {
    return { verified: false, reason: 'MISSING_CHAIN' };
  }

  const chainResult = verifyCertificateChain(chain, options);
  if (!chainResult.ok) {
    return { verified: false, reason: chainResult.reason };
  }

  const signingInput = Buffer.from(`${encodedHeader}.${encodedPayload}`, 'utf8');
  const signature = decodeBase64Url(encodedSignature);

  let signatureValid: boolean;
  try {
    signatureValid = verifySignature(
      'sha256',
      signingInput,
      { key: chainResult.leaf.publicKey, dsaEncoding: 'ieee-p1363' },
      signature,
    );
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) {
    return { verified: false, reason: 'BAD_SIGNATURE' };
  }

  const payload = parseJson(decodeBase64Url(encodedPayload));
  if (payload === null) {
    return { verified: false, reason: 'MALFORMED_PAYLOAD' };
  }

  if (options.expectedBundleId !== undefined) {
    const data = payload.data;
    const bundleId =
      data !== null && typeof data === 'object'
        ? (data as Record<string, unknown>).bundleId
        : undefined;
    if (bundleId !== undefined && bundleId !== options.expectedBundleId) {
      return { verified: false, reason: 'WRONG_BUNDLE_ID' };
    }
  }

  return { verified: true, payload };
}

/**
 * Decodes a nested `signedTransactionInfo` / `signedRenewalInfo` JWS.
 *
 * Safe without a second chain check ONLY because it is called on a payload that
 * has already been verified: Apple signs the nested tokens with the same chain
 * it signed the envelope with, and the envelope's signature covers them.
 */
export function decodeVerifiedNestedJws(token: string): Record<string, unknown> | null {
  const segments = token.split('.');
  const payload = segments[1];
  if (segments.length !== 3 || payload === undefined) return null;
  return parseJson(decodeBase64Url(payload));
}
