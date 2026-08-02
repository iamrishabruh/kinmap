import { generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ASC_AUDIENCE,
  ASC_MAX_TOKEN_LIFETIME_SECONDS,
  AppStoreConnectClient,
  AscApiError,
  AscConfigurationError,
  AscSignatureFormatError,
  createAscJwt,
  createSigningKey,
  derToJoseSignature,
  expandHomePath,
  parseAscErrorEnvelope,
  readPrivateKeyFile,
  resolveAscConfig,
  type AscFetch,
  type AscHttpRequest,
  type AscHttpResponse,
} from '../asc-client.js';

// ---------------------------------------------------------------------------
// Helpers: an independent DER encoder, so the vectors below are built by
// different code from the decoder under test.
// ---------------------------------------------------------------------------

/** Encodes an unsigned big-endian magnitude as a DER INTEGER. */
function derInteger(magnitudeHex: string): Buffer {
  const raw = Buffer.from(magnitudeHex, 'hex');

  let start = 0;
  while (start < raw.length - 1 && raw[start] === 0x00) {
    start += 1;
  }
  const minimal = raw.subarray(start);

  // DER integers are signed: a leading byte >= 0x80 needs a 0x00 sign byte.
  const needsSignByte = (minimal[0] ?? 0) >= 0x80;
  const content = needsSignByte ? Buffer.concat([Buffer.from([0x00]), minimal]) : minimal;

  return Buffer.concat([Buffer.from([0x02, content.length]), content]);
}

function derSignature(rHex: string, sHex: string): Buffer {
  const body = Buffer.concat([derInteger(rHex), derInteger(sHex)]);
  const header =
    body.length < 0x80
      ? Buffer.from([0x30, body.length])
      : Buffer.concat([Buffer.from([0x30, 0x81, body.length])]);
  return Buffer.concat([header, body]);
}

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

function decodeSegment(segment: string): unknown {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

// ---------------------------------------------------------------------------

describe('derToJoseSignature', () => {
  // RFC 6979 A.2.5, P-256 / SHA-256, message "sample". Both r and s have their
  // high bit set, so DER prefixes each with a 0x00 sign byte and the encoded
  // signature is 72 bytes; naive concatenation would yield 66.
  const RFC6979_R = 'efd48b2aacb6a8fd1140dd9cd45e81d69d2c877b56aaf991c34d0ea84eaf3716';
  const RFC6979_S = 'f7cb1c942d657c41d436c7a1b6e29f65f3e900dbb9aff4064dc4ab2f843acda8';

  it('normalises a signature whose r and s both carry a DER sign byte', () => {
    const der = derSignature(RFC6979_R, RFC6979_S);
    expect(der).toHaveLength(72);

    const jose = derToJoseSignature(der);
    expect(jose).toHaveLength(64);
    expect(hex(jose)).toBe(RFC6979_R + RFC6979_S);
  });

  it('left-pads an r whose leading byte is zero — the classic 63-byte bug', () => {
    // r < 2^248, so DER drops the leading zero byte and encodes r's magnitude
    // in 31 bytes rather than 32.
    const r = '003bc9d1f2a4e60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f';
    const s = '2f1e0d9c8b7a695847362514f3e2d1c0bafe9d8c7b6a59483726150413f2e1d0';

    const der = derSignature(r, s);
    // 2 (SEQUENCE) + 2 + 31 (r) + 2 + 32 (s) = 69 bytes, not the usual 70.
    expect(der).toHaveLength(69);
    // The failure mode being guarded against: an implementation that simply
    // concatenates the two DER magnitudes emits 63 bytes here, and Apple
    // answers 401 NOT_AUTHORIZED for every request made with that token.
    expect(der.length - 6).toBe(63);

    const jose = derToJoseSignature(der);
    expect(jose).toHaveLength(64);
    expect(hex(jose)).toBe(r + s);
  });

  it('left-pads an s whose leading byte is zero', () => {
    const r = '7a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9';
    const s = '0000c0ffee1234567890abcdef1234567890abcdef1234567890abcdef123456';

    const der = derSignature(r, s);
    const jose = derToJoseSignature(der);

    expect(jose).toHaveLength(64);
    expect(hex(jose)).toBe(r + s);
  });

  it('handles the degenerate case of a single-byte r', () => {
    const r = `${'00'.repeat(31)}01`;
    const s = `${'00'.repeat(31)}02`;

    const der = derSignature(r, s);
    expect(der).toHaveLength(8);

    const jose = derToJoseSignature(der);
    expect(jose).toHaveLength(64);
    expect(hex(jose)).toBe(r + s);
  });

  it('rejects a blob that is not a SEQUENCE', () => {
    expect(() => derToJoseSignature(Buffer.from('020101', 'hex'))).toThrow(AscSignatureFormatError);
  });

  it('rejects a truncated signature', () => {
    const der = derSignature(RFC6979_R, RFC6979_S);
    expect(() => derToJoseSignature(der.subarray(0, 40))).toThrow(AscSignatureFormatError);
  });

  it('rejects trailing bytes after s', () => {
    const der = Buffer.concat([derSignature(RFC6979_R, RFC6979_S), Buffer.from([0x00])]);
    expect(() => derToJoseSignature(der)).toThrow(AscSignatureFormatError);
  });

  it('rejects an integer too large for the curve', () => {
    const oversized = Buffer.concat([
      Buffer.from([0x02, 0x21]),
      Buffer.from(`01${'ab'.repeat(32)}`, 'hex'),
    ]);
    const s = derInteger(RFC6979_S);
    const body = Buffer.concat([oversized, s]);
    const der = Buffer.concat([Buffer.from([0x30, body.length]), body]);

    expect(() => derToJoseSignature(der)).toThrow(/does not fit a 32-byte curve coordinate/);
  });

  it('rejects a non-minimal leading zero byte', () => {
    const body = Buffer.concat([
      Buffer.from([0x02, 0x02, 0x00, 0x01]), // 0x00 followed by a byte < 0x80
      derInteger(RFC6979_S),
    ]);
    const der = Buffer.concat([Buffer.from([0x30, body.length]), body]);

    expect(() => derToJoseSignature(der)).toThrow(/non-minimal leading zero byte/);
  });

  it('agrees with node for every signature the runtime actually produces', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

    for (let attempt = 0; attempt < 200; attempt += 1) {
      const message = Buffer.from(`round ${String(attempt)}`, 'utf8');
      const der = sign('sha256', message, privateKey);
      const jose = derToJoseSignature(der);

      expect(jose).toHaveLength(64);
      // The real proof: node verifies the converted signature as P-1363.
      expect(verify('sha256', message, { key: publicKey, dsaEncoding: 'ieee-p1363' }, jose)).toBe(
        true,
      );
    }
  });
});

// ---------------------------------------------------------------------------

describe('createAscJwt', () => {
  let privateKey: KeyObject;
  let publicKey: KeyObject;

  beforeAll(() => {
    const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    privateKey = pair.privateKey;
    publicKey = pair.publicKey;
  });

  const KEY_ID = 'XXXXXXXXXX';
  const ISSUER_ID = '00000000-0000-0000-0000-000000000000';

  it('produces the header Apple requires', () => {
    const token = createAscJwt({ keyId: KEY_ID, issuerId: ISSUER_ID, signingKey: privateKey });
    const [header] = token.split('.');

    expect(header).toBeDefined();
    expect(decodeSegment(header ?? '')).toEqual({ alg: 'ES256', kid: KEY_ID, typ: 'JWT' });
  });

  it('produces the claims Apple requires', () => {
    const issuedAt = 1_800_000_000;
    const token = createAscJwt({
      keyId: KEY_ID,
      issuerId: ISSUER_ID,
      signingKey: privateKey,
      issuedAt,
    });
    const [, claims] = token.split('.');

    expect(decodeSegment(claims ?? '')).toEqual({
      iss: ISSUER_ID,
      iat: issuedAt,
      exp: issuedAt + ASC_MAX_TOKEN_LIFETIME_SECONDS,
      aud: ASC_AUDIENCE,
    });
  });

  it('never mints a token that outlives Apple’s twenty-minute ceiling', () => {
    const token = createAscJwt({ keyId: KEY_ID, issuerId: ISSUER_ID, signingKey: privateKey });
    const claims = decodeSegment(token.split('.')[1] ?? '') as { iat: number; exp: number };

    expect(claims.exp - claims.iat).toBeLessThanOrEqual(20 * 60);
    expect(claims.exp).toBeGreaterThan(claims.iat);
  });

  it('refuses a lifetime longer than the ceiling', () => {
    expect(() =>
      createAscJwt({
        keyId: KEY_ID,
        issuerId: ISSUER_ID,
        signingKey: privateKey,
        lifetimeSeconds: ASC_MAX_TOKEN_LIFETIME_SECONDS + 1,
      }),
    ).toThrow(RangeError);

    expect(() =>
      createAscJwt({
        keyId: KEY_ID,
        issuerId: ISSUER_ID,
        signingKey: privateKey,
        lifetimeSeconds: 0,
      }),
    ).toThrow(RangeError);
  });

  it('signs in the P-1363 form Apple accepts, not DER', () => {
    const token = createAscJwt({ keyId: KEY_ID, issuerId: ISSUER_ID, signingKey: privateKey });
    const [header, claims, signature] = token.split('.');

    expect(signature).toBeDefined();
    const raw = Buffer.from(signature ?? '', 'base64url');
    expect(raw).toHaveLength(64);

    const signingInput = Buffer.from(`${header ?? ''}.${claims ?? ''}`, 'utf8');
    expect(verify('sha256', signingInput, { key: publicKey, dsaEncoding: 'ieee-p1363' }, raw)).toBe(
      true,
    );
    // A DER-encoded signature would be rejected in this encoding, which is
    // exactly how Apple sees a naive implementation.
    expect(verify('sha256', signingInput, { key: publicKey, dsaEncoding: 'der' }, raw)).toBe(false);
  });

  it('emits three base64url segments and no padding', () => {
    const token = createAscJwt({ keyId: KEY_ID, issuerId: ISSUER_ID, signingKey: privateKey });
    expect(token.split('.')).toHaveLength(3);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });
});

// ---------------------------------------------------------------------------

describe('credential loading', () => {
  let directory: string;
  let keyPath: string;
  let pem: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'kinmap-asc-'));
    keyPath = join(directory, 'AuthKey_TESTKEY123.p8');
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    await writeFile(keyPath, pem, { mode: 0o600 });
  });

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('reads a real key file', async () => {
    await expect(readPrivateKeyFile(keyPath)).resolves.toContain('KEY');
  });

  it('explains a missing key file instead of throwing a raw ENOENT', async () => {
    const missing = join(directory, 'AuthKey_ABSENT0000.p8');

    await expect(readPrivateKeyFile(missing)).rejects.toBeInstanceOf(AscConfigurationError);
    await expect(readPrivateKeyFile(missing)).rejects.toThrow(
      /No App Store Connect private key found at/,
    );

    const error = await readPrivateKeyFile(missing).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain(missing);
    expect(message).toContain('appstoreconnect.apple.com');
    expect(message).not.toContain('ENOENT');
    expect(message).not.toContain('at Object.');
  });

  it('rejects a file that is not a PEM key without echoing its contents', async () => {
    const decoy = join(directory, 'not-a-key.p8');
    await writeFile(decoy, 'totally-not-a-key-but-still-sensitive\n');

    const error = await readPrivateKeyFile(decoy).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(AscConfigurationError);
    expect((error as Error).message).not.toContain('totally-not-a-key');
  });

  it('accepts a P-256 key and rejects other curves', () => {
    expect(createSigningKey(pem).asymmetricKeyType).toBe('ec');

    const { privateKey: wrongCurve } = generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
    const wrongPem = wrongCurve.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(() => createSigningKey(wrongPem)).toThrow(/prime256v1/);

    const { privateKey: rsa } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const rsaPem = rsa.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(() => createSigningKey(rsaPem)).toThrow(/EC P-256/);
  });

  it('never leaks key material through an unparseable-PEM error', () => {
    const banner = ['-----BEGIN', 'PRIVATE', 'KEY-----'].join(' ');
    const corrupt = `${banner}\nc2VjcmV0LW1hdGVyaWFs\n`;

    const thrown = ((): unknown => {
      try {
        createSigningKey(corrupt);
        return undefined;
      } catch (error) {
        return error;
      }
    })();

    expect(thrown).toBeInstanceOf(AscConfigurationError);
    expect((thrown as Error).message).not.toContain('c2VjcmV0LW1hdGVyaWFs');
  });
});

// ---------------------------------------------------------------------------

describe('resolveAscConfig', () => {
  it('names every missing variable at once and echoes no values', () => {
    const error = ((): unknown => {
      try {
        resolveAscConfig({});
        return undefined;
      } catch (cause) {
        return cause;
      }
    })();

    expect(error).toBeInstanceOf(AscConfigurationError);
    const message = (error as Error).message;
    expect(message).toContain('ASC_KEY_ID');
    expect(message).toContain('ASC_ISSUER_ID');
    expect(message).toContain('ASC_KEY_PATH');
  });

  it('treats an empty or whitespace-only variable as absent', () => {
    expect(() =>
      resolveAscConfig({ ASC_KEY_ID: '  ', ASC_ISSUER_ID: 'issuer', ASC_KEY_PATH: '/tmp/k.p8' }),
    ).toThrow(/ASC_KEY_ID/);
  });

  it('expands a home-relative key path and defaults the team id', () => {
    const config = resolveAscConfig({
      ASC_KEY_ID: 'XXXXXXXXXX',
      ASC_ISSUER_ID: '00000000-0000-0000-0000-000000000000',
      ASC_KEY_PATH: '~/.private/AuthKey_XXXXXXXXXX.p8',
    });

    expect(config.keyPath.startsWith('~')).toBe(false);
    expect(config.keyPath.endsWith('/.private/AuthKey_XXXXXXXXXX.p8')).toBe(true);
    expect(config.teamId).toBe('HH7Q2DUJ9U');
  });

  it('lets the team id be overridden', () => {
    const config = resolveAscConfig({
      ASC_KEY_ID: 'k',
      ASC_ISSUER_ID: 'i',
      ASC_KEY_PATH: '/tmp/k.p8',
      ASC_TEAM_ID: 'ABCDE12345',
    });
    expect(config.teamId).toBe('ABCDE12345');
  });

  it('expands ~ against the supplied home directory', () => {
    expect(expandHomePath('~/a/b', '/home/test')).toBe('/home/test/a/b');
    expect(expandHomePath('/already/absolute', '/home/test')).toBe('/already/absolute');
  });
});

// ---------------------------------------------------------------------------

describe('parseAscErrorEnvelope', () => {
  it('reads Apple’s error envelope', () => {
    const details = parseAscErrorEnvelope(
      JSON.stringify({
        errors: [
          {
            id: 'abc',
            status: '409',
            code: 'ENTITY_ERROR.ATTRIBUTE_INVALID',
            title: 'An attribute value is invalid.',
            detail: 'An App ID with Identifier "app.kinmap" is not available.',
          },
        ],
      }),
    );

    expect(details).toEqual([
      {
        status: '409',
        code: 'ENTITY_ERROR.ATTRIBUTE_INVALID',
        title: 'An attribute value is invalid.',
        detail: 'An App ID with Identifier "app.kinmap" is not available.',
      },
    ]);
  });

  it('degrades to an empty list for a non-JSON body', () => {
    expect(parseAscErrorEnvelope('<html>502 Bad Gateway</html>')).toEqual([]);
    expect(parseAscErrorEnvelope('')).toEqual([]);
    expect(parseAscErrorEnvelope('{"data":{}}')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('AppStoreConnectClient', () => {
  function stubResponse(
    status: number,
    body: string,
    headers: Record<string, string> = {},
  ): AscHttpResponse {
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: { get: (name: string): string | null => headers[name.toLowerCase()] ?? null },
      text: (): Promise<string> => Promise.resolve(body),
    };
  }

  function client(handler: (url: string, init: AscHttpRequest) => AscHttpResponse): {
    client: AppStoreConnectClient;
    calls: Array<{ url: string; init: AscHttpRequest }>;
  } {
    const calls: Array<{ url: string; init: AscHttpRequest }> = [];
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const fetchStub: AscFetch = (url, init) => {
      calls.push({ url, init });
      return Promise.resolve(handler(url, init));
    };

    return {
      calls,
      client: new AppStoreConnectClient({
        credentials: {
          keyId: 'XXXXXXXXXX',
          issuerId: '00000000-0000-0000-0000-000000000000',
          signingKey: privateKey,
          teamId: 'HH7Q2DUJ9U',
        },
        fetch: fetchStub,
        retryDelayMs: (): number => 0,
      }),
    };
  }

  it('sends a bearer token and serialises query parameters', async () => {
    const harness = client(() => stubResponse(200, JSON.stringify({ data: [] })));
    await harness.client.get('/v1/bundleIds', { 'filter[identifier]': 'app.kinmap', limit: 200 });

    const call = harness.calls[0];
    expect(call).toBeDefined();
    expect(call?.url).toContain('filter%5Bidentifier%5D=app.kinmap');
    expect(call?.url).toContain('limit=200');

    const authorization = call?.init.headers['authorization'] ?? '';
    expect(authorization.startsWith('Bearer ')).toBe(true);
    expect(authorization.slice('Bearer '.length).split('.')).toHaveLength(3);
  });

  it('reuses one token across requests', async () => {
    const harness = client(() => stubResponse(200, JSON.stringify({ data: [] })));
    await harness.client.get('/v1/bundleIds');
    await harness.client.get('/v1/bundleIds');

    expect(harness.calls).toHaveLength(2);
    expect(harness.calls[0]?.init.headers['authorization']).toBe(
      harness.calls[1]?.init.headers['authorization'],
    );
  });

  it('surfaces Apple’s error envelope as a typed error', async () => {
    const harness = client(() =>
      stubResponse(
        409,
        JSON.stringify({
          errors: [
            {
              status: '409',
              code: 'ENTITY_ERROR.ATTRIBUTE_INVALID',
              title: 'An attribute value is invalid.',
              detail: 'An App ID with Identifier "app.kinmap" is not available.',
            },
          ],
        }),
        { 'x-request-id': 'REQ-1' },
      ),
    );

    const error = await harness.client
      .post('/v1/bundleIds', { data: {} })
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(AscApiError);
    const apiError = error as AscApiError;
    expect(apiError.status).toBe(409);
    expect(apiError.requestId).toBe('REQ-1');
    expect(apiError.hasCode('ENTITY_ERROR.ATTRIBUTE_INVALID')).toBe(true);
    expect(apiError.message).toContain('An attribute value is invalid.');
    expect(apiError.message).toContain('/v1/bundleIds');
    // A bearer token must never travel in an error message.
    expect(apiError.message).not.toContain('Bearer');
  });

  it('retries a throttled request and then succeeds', async () => {
    let attempts = 0;
    const harness = client(() => {
      attempts += 1;
      return attempts === 1
        ? stubResponse(429, JSON.stringify({ errors: [] }), { 'retry-after': '0' })
        : stubResponse(200, JSON.stringify({ data: [{ id: 'X' }] }));
    });

    const response = await harness.client.get<{ data: Array<{ id: string }> }>('/v1/bundleIds');
    expect(attempts).toBe(2);
    expect(response.data[0]?.id).toBe('X');
  });

  it('does not retry a client error', async () => {
    let attempts = 0;
    const harness = client(() => {
      attempts += 1;
      return stubResponse(403, JSON.stringify({ errors: [{ status: '403', code: 'FORBIDDEN' }] }));
    });

    await expect(harness.client.get('/v1/bundleIds')).rejects.toBeInstanceOf(AscApiError);
    expect(attempts).toBe(1);
  });

  it('follows pagination links', async () => {
    const harness = client((url) =>
      url.includes('cursor=second')
        ? stubResponse(200, JSON.stringify({ data: [{ id: 'B' }] }))
        : stubResponse(
            200,
            JSON.stringify({
              data: [{ id: 'A' }],
              links: { next: 'https://api.appstoreconnect.apple.com/v1/bundleIds?cursor=second' },
            }),
          ),
    );

    const all = await harness.client.getAll<{ id: string }>('/v1/bundleIds');
    expect(all.map((entry) => entry.id)).toEqual(['A', 'B']);
  });
});
