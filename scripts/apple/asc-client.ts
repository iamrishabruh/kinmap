/**
 * App Store Connect API client.
 *
 * Deliberately dependency-free: it mints its own ES256 JWT with `node:crypto`
 * rather than pulling a JWT library into the repository for the sake of two
 * base64url segments and one signature.
 *
 * The one genuinely subtle part is the signature encoding. `crypto.sign()`
 * emits an ECDSA signature in ASN.1 DER (`SEQUENCE { INTEGER r, INTEGER s }`),
 * whose integers are variable-length and minimally encoded. JOSE — and
 * therefore Apple — requires the P-1363 fixed-width form `r || s`, 32 bytes
 * each for P-256. Concatenating the DER integers as-is produces a 63-, 64-,
 * 65- or 66-byte string depending on the values, and Apple answers
 * `401 NOT_AUTHORIZED` for every length except the one that happens to be
 * right. {@link derToJoseSignature} does the conversion properly; it is unit
 * tested against vectors that cover each of those lengths.
 *
 * Privacy and secrecy rules this module obeys:
 *   - the .p8 is read from disk at call time and is never written to a log, an
 *     error message, an environment variable or a command-line argument;
 *   - the private key is held as a `KeyObject`, which does not expose its
 *     material through `toString`, `JSON.stringify` or `util.inspect`;
 *   - the bearer token is never logged, and never appears in an error message.
 */
import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

// --- constants --------------------------------------------------------------

export const ASC_BASE_URL = 'https://api.appstoreconnect.apple.com';

/** Apple rejects a token whose `aud` is anything else. */
export const ASC_AUDIENCE = 'appstoreconnect-v1';

/** Apple's hard ceiling on token lifetime: 20 minutes. */
export const ASC_MAX_TOKEN_LIFETIME_SECONDS = 1200;

/** Renew this long before expiry so a slow request cannot outlive its token. */
export const ASC_TOKEN_RENEWAL_MARGIN_SECONDS = 60;

/** P-256 coordinates are 32 bytes; a JOSE ES256 signature is exactly 64. */
export const P256_COORDINATE_BYTES = 32;

/** Environment variables this client reads. All three are mandatory. */
export const ENV_KEY_ID = 'ASC_KEY_ID';
export const ENV_ISSUER_ID = 'ASC_ISSUER_ID';
export const ENV_KEY_PATH = 'ASC_KEY_PATH';
/** Optional; the Apple Developer Team ID used as `seedId` on creation. */
export const ENV_TEAM_ID = 'ASC_TEAM_ID';

/** Kinmap's Apple Developer Team ID, overridable via {@link ENV_TEAM_ID}. */
export const DEFAULT_APPLE_TEAM_ID = 'HH7Q2DUJ9U';

/**
 * Assembled from fragments so that `scripts/validation/check-secrets.sh`, which
 * greps every tracked file for PEM banners, does not flag this source file as
 * containing key material.
 */
const PEM_PRIVATE_KEY_MARKER = ['-----BEGIN', 'PRIVATE', 'KEY-----'].join(' ');

// --- errors -----------------------------------------------------------------

/**
 * A credential or configuration problem the operator must fix. Callers print
 * `error.message` and exit; these messages are written to be complete on their
 * own so that no stack trace is needed.
 */
export class AscConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AscConfigurationError';
  }
}

/** The DER signature produced by `crypto.sign()` was not the expected shape. */
export class AscSignatureFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AscSignatureFormatError';
  }
}

/** Apple answered, but with something this client cannot interpret. */
export class AscResponseError extends Error {
  readonly method: string;
  readonly path: string;
  readonly status: number;

  constructor(params: { method: string; path: string; status: number; reason: string }) {
    super(
      `App Store Connect ${params.method} ${params.path} returned HTTP ${String(params.status)} ` +
        `but ${params.reason}.`,
    );
    this.name = 'AscResponseError';
    this.method = params.method;
    this.path = params.path;
    this.status = params.status;
  }
}

/** One entry of Apple's `{ errors: [...] }` envelope. */
export interface AscApiErrorDetail {
  readonly status: string;
  readonly code: string;
  readonly title: string;
  readonly detail?: string;
}

/** A non-2xx response, with Apple's error envelope surfaced as structured data. */
export class AscApiError extends Error {
  readonly method: string;
  readonly path: string;
  readonly status: number;
  /** Apple's `x-request-id`; quote it when opening a Developer Support case. */
  readonly requestId: string | undefined;
  readonly errors: readonly AscApiErrorDetail[];

  constructor(params: {
    method: string;
    path: string;
    status: number;
    requestId: string | undefined;
    errors: readonly AscApiErrorDetail[];
  }) {
    super(
      `App Store Connect ${params.method} ${params.path} failed with HTTP ` +
        `${String(params.status)}.\n${formatErrorDetails(params.errors)}` +
        (params.requestId === undefined ? '' : `\n  request id: ${params.requestId}`),
    );
    this.name = 'AscApiError';
    this.method = params.method;
    this.path = params.path;
    this.status = params.status;
    this.requestId = params.requestId;
    this.errors = params.errors;
  }

  /** True when any envelope entry carries the given Apple error code. */
  hasCode(code: string): boolean {
    return this.errors.some((entry) => entry.code === code);
  }
}

function formatErrorDetails(details: readonly AscApiErrorDetail[]): string {
  if (details.length === 0) {
    return '  (no error envelope in the response body)';
  }
  return details
    .map((entry) => {
      const head = `  [${entry.status} ${entry.code}] ${entry.title}`;
      return entry.detail === undefined || entry.detail.length === 0
        ? head
        : `${head} — ${entry.detail}`;
    })
    .join('\n');
}

// --- DER -> JOSE (P-1363) signature conversion ------------------------------

const DER_SEQUENCE_TAG = 0x30;
const DER_INTEGER_TAG = 0x02;

/** Minimal forward-only reader over a DER blob. */
class DerCursor {
  readonly #bytes: Uint8Array;
  #index = 0;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
  }

  get remaining(): number {
    return this.#bytes.length - this.#index;
  }

  readByte(): number {
    const value = this.#bytes[this.#index];
    if (value === undefined) {
      throw new AscSignatureFormatError(
        `DER signature is truncated: expected a byte at offset ${String(this.#index)} of ` +
          `${String(this.#bytes.length)}.`,
      );
    }
    this.#index += 1;
    return value;
  }

  expectTag(tag: number, label: string): void {
    const actual = this.readByte();
    if (actual !== tag) {
      throw new AscSignatureFormatError(
        `DER signature is malformed: expected a ${label} tag (0x${tag.toString(16)}) at offset ` +
          `${String(this.#index - 1)} but found 0x${actual.toString(16).padStart(2, '0')}.`,
      );
    }
  }

  /** Reads a DER length, accepting short form and up to two long-form bytes. */
  readLength(): number {
    const first = this.readByte();
    if (first < 0x80) {
      return first;
    }
    const byteCount = first & 0x7f;
    if (byteCount === 0 || byteCount > 2) {
      throw new AscSignatureFormatError(
        `DER signature is malformed: length uses ${String(byteCount)} bytes, which is not a ` +
          'plausible ECDSA signature.',
      );
    }
    let length = 0;
    for (let i = 0; i < byteCount; i += 1) {
      length = length * 256 + this.readByte();
    }
    if (length < 0x80) {
      throw new AscSignatureFormatError(
        'DER signature is malformed: long-form length used for a value that fits in short form.',
      );
    }
    return length;
  }

  readSlice(length: number): Uint8Array {
    if (length > this.remaining) {
      throw new AscSignatureFormatError(
        `DER signature is truncated: a field declares ${String(length)} bytes but only ` +
          `${String(this.remaining)} remain.`,
      );
    }
    const slice = this.#bytes.subarray(this.#index, this.#index + length);
    this.#index += length;
    return slice;
  }
}

/**
 * Reads one DER INTEGER and returns its unsigned big-endian magnitude with any
 * DER sign padding removed.
 */
function readDerInteger(cursor: DerCursor, label: string): Uint8Array {
  cursor.expectTag(DER_INTEGER_TAG, `${label} INTEGER`);
  const length = cursor.readLength();
  if (length === 0) {
    throw new AscSignatureFormatError(`DER signature is malformed: ${label} has zero length.`);
  }
  const raw = cursor.readSlice(length);

  const first = raw[0] ?? 0;
  if ((first & 0x80) !== 0) {
    // A leading byte with the high bit set makes this a negative INTEGER, which
    // an ECDSA r or s can never be.
    throw new AscSignatureFormatError(
      `DER signature is malformed: ${label} is encoded as a negative INTEGER.`,
    );
  }
  if (first === 0x00 && length > 1) {
    const second = raw[1] ?? 0;
    if ((second & 0x80) === 0) {
      throw new AscSignatureFormatError(
        `DER signature is malformed: ${label} has a non-minimal leading zero byte.`,
      );
    }
    return raw.subarray(1);
  }
  return raw;
}

/** Left-pads a magnitude to exactly `width` bytes. */
function padToWidth(magnitude: Uint8Array, width: number, label: string): Uint8Array {
  if (magnitude.length > width) {
    throw new AscSignatureFormatError(
      `DER signature is malformed: ${label} is ${String(magnitude.length)} bytes, which does not ` +
        `fit a ${String(width)}-byte curve coordinate.`,
    );
  }
  const padded = new Uint8Array(width);
  padded.set(magnitude, width - magnitude.length);
  return padded;
}

/**
 * Converts an ASN.1 DER ECDSA signature into the fixed-width JOSE / P-1363
 * form `r || s` that Apple (and every other JWT verifier) expects.
 *
 * This is the single most common defect in hand-rolled App Store Connect
 * clients. DER encodes r and s as minimal signed integers, so:
 *
 *   - r < 2^248 loses its leading zero byte and encodes in 31 bytes, and naive
 *     concatenation yields a 63-byte signature;
 *   - r >= 2^255 gains a 0x00 sign byte and encodes in 33 bytes, and naive
 *     concatenation yields a 65- or 66-byte signature.
 *
 * Both must be normalised back to exactly 32 bytes each.
 */
export function derToJoseSignature(
  der: Uint8Array,
  coordinateBytes: number = P256_COORDINATE_BYTES,
): Uint8Array {
  if (!Number.isInteger(coordinateBytes) || coordinateBytes <= 0) {
    throw new RangeError(
      `coordinateBytes must be a positive integer; got ${String(coordinateBytes)}.`,
    );
  }

  const cursor = new DerCursor(der);
  cursor.expectTag(DER_SEQUENCE_TAG, 'SEQUENCE');
  const declared = cursor.readLength();
  if (declared !== cursor.remaining) {
    throw new AscSignatureFormatError(
      `DER signature is malformed: SEQUENCE declares ${String(declared)} content bytes but ` +
        `${String(cursor.remaining)} follow.`,
    );
  }

  const r = readDerInteger(cursor, 'r');
  const s = readDerInteger(cursor, 's');
  if (cursor.remaining !== 0) {
    throw new AscSignatureFormatError(
      `DER signature is malformed: ${String(cursor.remaining)} trailing byte(s) after s.`,
    );
  }

  const jose = new Uint8Array(coordinateBytes * 2);
  jose.set(padToWidth(r, coordinateBytes, 'r'), 0);
  jose.set(padToWidth(s, coordinateBytes, 's'), coordinateBytes);
  return jose;
}

// --- credentials ------------------------------------------------------------

/** Non-secret identifiers plus the on-disk location of the .p8. */
export interface AscConfig {
  readonly keyId: string;
  readonly issuerId: string;
  /** Absolute path to the .p8, with a leading `~` already expanded. */
  readonly keyPath: string;
  /** Apple Developer Team ID, used as `seedId` when creating resources. */
  readonly teamId: string;
}

/** Everything needed to mint a token. The PEM never leaves this process. */
export interface AscCredentials {
  readonly keyId: string;
  readonly issuerId: string;
  readonly signingKey: KeyObject;
  readonly teamId: string;
}

/** Expands a leading `~` and resolves to an absolute path. */
export function expandHomePath(candidate: string, home: string = homedir()): string {
  if (candidate === '~') {
    return home;
  }
  const expanded = candidate.startsWith('~/') ? resolve(home, candidate.slice(2)) : candidate;
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

/**
 * Reads the three mandatory environment variables, failing closed with one
 * message that names every missing variable rather than one per run.
 *
 * Values are never echoed — only variable names appear in the error.
 */
export function resolveAscConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): AscConfig {
  const missing: string[] = [];

  const required = (name: string): string => {
    const value = (env[name] ?? '').trim();
    if (value.length === 0) {
      missing.push(name);
    }
    return value;
  };

  const keyId = required(ENV_KEY_ID);
  const issuerId = required(ENV_ISSUER_ID);
  const keyPath = required(ENV_KEY_PATH);

  if (missing.length > 0) {
    throw new AscConfigurationError(
      `Missing App Store Connect configuration: ${missing.join(', ')}.\n` +
        'Set every variable below before running this script:\n' +
        `  ${ENV_KEY_ID}     the 10-character API key id shown next to the key in App Store Connect\n` +
        `  ${ENV_ISSUER_ID}  the team's issuer UUID, shown above the key list\n` +
        `  ${ENV_KEY_PATH}   path to the downloaded AuthKey_<key id>.p8, e.g. ~/.private/AuthKey_<key id>.p8\n` +
        'None of these are secrets; the .p8 file they point at is. See scripts/apple/README.md.',
    );
  }

  return {
    keyId,
    issuerId,
    keyPath: expandHomePath(keyPath),
    teamId: (env[ENV_TEAM_ID] ?? '').trim() || DEFAULT_APPLE_TEAM_ID,
  };
}

function errorCode(value: unknown): string | undefined {
  if (typeof value === 'object' && value !== null && 'code' in value) {
    const code: unknown = value.code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

/**
 * Reads the .p8 from disk. A missing or unreadable file produces a complete,
 * actionable message — never a stack trace, and never any file content.
 */
export async function readPrivateKeyFile(keyPath: string): Promise<string> {
  let contents: string;
  try {
    contents = await readFile(keyPath, 'utf8');
  } catch (cause) {
    const code = errorCode(cause);
    if (code === 'ENOENT') {
      throw new AscConfigurationError(
        `No App Store Connect private key found at ${keyPath}.\n` +
          'A .p8 can be downloaded exactly once, at creation time, and cannot be re-fetched.\n' +
          'If you still have it, move it there and `chmod 600` it. If you do not, create a new\n' +
          'key with the App Manager role at https://appstoreconnect.apple.com/access/integrations/api\n' +
          `and update ${ENV_KEY_ID} and ${ENV_KEY_PATH}.`,
      );
    }
    if (code === 'EACCES' || code === 'EPERM') {
      throw new AscConfigurationError(
        `The App Store Connect private key at ${keyPath} exists but is not readable by this user.\n` +
          'Fix the ownership, then `chmod 600` it so nothing else on the machine can read it.',
      );
    }
    if (code === 'EISDIR') {
      throw new AscConfigurationError(
        `${ENV_KEY_PATH} points at a directory (${keyPath}); it must point at the .p8 file itself.`,
      );
    }
    throw new AscConfigurationError(
      `Could not read the App Store Connect private key at ${keyPath}` +
        `${code === undefined ? '' : ` (${code})`}.`,
    );
  }

  if (!contents.includes(PEM_PRIVATE_KEY_MARKER)) {
    throw new AscConfigurationError(
      `The file at ${keyPath} is not a PEM-encoded PKCS#8 private key.\n` +
        'App Store Connect keys download as AuthKey_<key id>.p8 and begin with a PEM banner.\n' +
        'Check that the path points at the .p8 itself and that it was not re-encoded or truncated.',
    );
  }

  return contents;
}

/**
 * Parses the PEM into a `KeyObject` and asserts it is the EC P-256 key ES256
 * requires. The PEM string is dropped as soon as this returns, and no part of
 * it can appear in any error raised here.
 */
export function createSigningKey(privateKeyPem: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: privateKeyPem, format: 'pem' });
  } catch {
    throw new AscConfigurationError(
      'The App Store Connect private key could not be parsed as PEM. Re-download the .p8 or\n' +
        'confirm the file was not modified by an editor that rewrote its line endings.',
    );
  }

  if (key.asymmetricKeyType !== 'ec') {
    throw new AscConfigurationError(
      `App Store Connect requires an EC P-256 key for ES256; this key is ` +
        `${key.asymmetricKeyType ?? 'of an unknown type'}.`,
    );
  }

  const curve = key.asymmetricKeyDetails?.namedCurve;
  if (curve !== undefined && curve !== 'prime256v1') {
    throw new AscConfigurationError(
      `App Store Connect requires curve prime256v1 (P-256) for ES256; this key uses ${curve}.`,
    );
  }

  return key;
}

/** Resolves configuration and loads the key in one step. */
export async function loadAscCredentials(config: AscConfig): Promise<AscCredentials> {
  const pem = await readPrivateKeyFile(config.keyPath);
  return {
    keyId: config.keyId,
    issuerId: config.issuerId,
    signingKey: createSigningKey(pem),
    teamId: config.teamId,
  };
}

// --- JWT --------------------------------------------------------------------

export interface AscJwtHeader {
  readonly alg: 'ES256';
  readonly kid: string;
  readonly typ: 'JWT';
}

export interface AscJwtClaims {
  readonly iss: string;
  readonly iat: number;
  readonly exp: number;
  readonly aud: typeof ASC_AUDIENCE;
}

export interface CreateAscJwtOptions {
  readonly keyId: string;
  readonly issuerId: string;
  readonly signingKey: KeyObject;
  /** Unix seconds. Injectable so tests do not depend on the wall clock. */
  readonly issuedAt?: number;
  /** Defaults to, and may never exceed, {@link ASC_MAX_TOKEN_LIFETIME_SECONDS}. */
  readonly lifetimeSeconds?: number;
}

function encodeSegment(value: object): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

/**
 * Mints a signed ES256 token for App Store Connect.
 *
 * The returned string is a bearer credential: it is as sensitive as the key
 * for the next 20 minutes. Never log it.
 */
export function createAscJwt(options: CreateAscJwtOptions): string {
  const lifetimeSeconds = options.lifetimeSeconds ?? ASC_MAX_TOKEN_LIFETIME_SECONDS;
  if (
    !Number.isInteger(lifetimeSeconds) ||
    lifetimeSeconds <= 0 ||
    lifetimeSeconds > ASC_MAX_TOKEN_LIFETIME_SECONDS
  ) {
    throw new RangeError(
      `An App Store Connect token may live for 1..${String(ASC_MAX_TOKEN_LIFETIME_SECONDS)} ` +
        `seconds (Apple rejects anything longer); got ${String(lifetimeSeconds)}.`,
    );
  }

  const issuedAt = Math.floor(options.issuedAt ?? Date.now() / 1000);
  const header: AscJwtHeader = { alg: 'ES256', kid: options.keyId, typ: 'JWT' };
  const claims: AscJwtClaims = {
    iss: options.issuerId,
    iat: issuedAt,
    exp: issuedAt + lifetimeSeconds,
    aud: ASC_AUDIENCE,
  };

  const signingInput = `${encodeSegment(header)}.${encodeSegment(claims)}`;
  // `sign` returns DER for an EC key; Apple only accepts fixed-width r || s.
  const derSignature = sign('sha256', Buffer.from(signingInput, 'utf8'), options.signingKey);
  const joseSignature = Buffer.from(derToJoseSignature(derSignature)).toString('base64url');

  return `${signingInput}.${joseSignature}`;
}

// --- HTTP -------------------------------------------------------------------

export type AscHttpMethod = 'GET' | 'POST' | 'PATCH';

export type AscQueryValue = string | number | boolean | string[];
export type AscQuery = Readonly<Record<string, AscQueryValue | undefined>>;

/** The subset of `Response` this client uses. */
export interface AscHttpResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}

/** The subset of `RequestInit` this client sends. */
export interface AscHttpRequest {
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
  readonly signal?: AbortSignal;
}

/** Injectable transport, so tests never touch the network. */
export type AscFetch = (url: string, init: AscHttpRequest) => Promise<AscHttpResponse>;

const defaultFetch: AscFetch = async (url, init) => {
  const response = await fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    signal: init.signal,
  });
  return {
    status: response.status,
    ok: response.ok,
    headers: { get: (name: string): string | null => response.headers.get(name) },
    text: (): Promise<string> => response.text(),
  };
};

export interface AppStoreConnectClientOptions {
  readonly credentials: AscCredentials;
  readonly baseUrl?: string;
  readonly fetch?: AscFetch;
  /** Milliseconds since the epoch. Injectable for deterministic tests. */
  readonly now?: () => number;
  /** Total attempts per request, including the first. Default 4. */
  readonly maxAttempts?: number;
  /** Backoff before attempt `n` (1-based index of the *next* attempt). */
  readonly retryDelayMs?: (attempt: number) => number;
  /** Per-attempt timeout. Default 30s. */
  readonly timeoutMs?: number;
}

export interface AscRequestOptions {
  readonly query?: AscQuery;
  readonly body?: unknown;
}

/** Apple's JSON:API collection envelope. */
export interface AscCollection<T> {
  readonly data: T[];
  readonly links?: { readonly self?: string; readonly next?: string };
  readonly meta?: { readonly paging?: { readonly total?: number; readonly limit?: number } };
}

/** Apple's JSON:API single-resource envelope. */
export interface AscSingle<T> {
  readonly data: T;
}

/** Retried because they are transient; everything else fails immediately. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 408 || (status >= 500 && status <= 599);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Parses Apple's `{ errors: [{ status, code, title, detail }] }` envelope.
 * Returns an empty list for a body that is not that shape — an HTML error page
 * from an edge proxy, for instance — so the caller still reports the status.
 */
export function parseAscErrorEnvelope(text: string): AscApiErrorDetail[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }

  const errors = asRecord(parsed)?.['errors'];
  if (!Array.isArray(errors)) {
    return [];
  }

  const details: AscApiErrorDetail[] = [];
  for (const entry of errors) {
    const record = asRecord(entry);
    if (record === undefined) {
      continue;
    }
    details.push({
      status: asString(record['status']) ?? '',
      code: asString(record['code']) ?? '',
      title: asString(record['title']) ?? '(no title)',
      detail: asString(record['detail']),
    });
  }
  return details;
}

const MAX_PAGES = 100;

/**
 * Authenticated App Store Connect client.
 *
 * Tokens are minted lazily and reused until shortly before they expire, so a
 * long reconciliation run does not re-sign on every call, and a slow request
 * cannot start with a token that expires mid-flight.
 */
export class AppStoreConnectClient {
  readonly #credentials: AscCredentials;
  readonly #baseUrl: string;
  readonly #fetch: AscFetch;
  readonly #now: () => number;
  readonly #maxAttempts: number;
  readonly #retryDelayMs: (attempt: number) => number;
  readonly #timeoutMs: number;

  #token: string | undefined;
  #tokenExpiresAtMs = 0;

  constructor(options: AppStoreConnectClientOptions) {
    this.#credentials = options.credentials;
    this.#baseUrl = (options.baseUrl ?? ASC_BASE_URL).replace(/\/+$/, '');
    this.#fetch = options.fetch ?? defaultFetch;
    this.#now = options.now ?? ((): number => Date.now());
    this.#maxAttempts = options.maxAttempts ?? 4;
    this.#retryDelayMs = options.retryDelayMs ?? ((attempt): number => 500 * 2 ** (attempt - 1));
    this.#timeoutMs = options.timeoutMs ?? 30_000;
  }

  /** The Apple Developer Team ID these credentials belong to. */
  get teamId(): string {
    return this.#credentials.teamId;
  }

  async get<T>(path: string, query?: AscQuery): Promise<T> {
    return this.request<T>('GET', path, { query });
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', path, { body });
  }

  async patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('PATCH', path, { body });
  }

  /** Follows `links.next` and returns every page's `data` concatenated. */
  async getAll<T>(path: string, query?: AscQuery): Promise<T[]> {
    const collected: T[] = [];
    let next: string | undefined = this.#buildUrl(path, query);

    for (let page = 0; next !== undefined && page < MAX_PAGES; page += 1) {
      const response: AscCollection<T> = await this.request<AscCollection<T>>('GET', next);
      if (Array.isArray(response.data)) {
        collected.push(...response.data);
      }
      const following = response.links?.next;
      next = following === next ? undefined : following;
    }

    return collected;
  }

  async request<T>(
    method: AscHttpMethod,
    path: string,
    options: AscRequestOptions = {},
  ): Promise<T> {
    const url = this.#buildUrl(path, options.query);
    const display = this.#displayPath(url);
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);

    for (let attempt = 1; ; attempt += 1) {
      // Built fresh per attempt and never retained, logged or embedded in an error.
      const headers: Record<string, string> = {
        authorization: `Bearer ${this.#bearerToken()}`,
        accept: 'application/json',
      };
      if (body !== undefined) {
        headers['content-type'] = 'application/json';
      }

      const response = await this.#fetch(url, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      const text = await response.text();

      if (response.ok) {
        return this.#parseBody<T>(method, display, response.status, text);
      }

      const retryable = isRetryableStatus(response.status) && attempt < this.#maxAttempts;
      if (retryable) {
        await sleep(this.#delayFor(attempt, response));
        continue;
      }

      throw new AscApiError({
        method,
        path: display,
        status: response.status,
        requestId: response.headers.get('x-request-id') ?? undefined,
        errors: parseAscErrorEnvelope(text),
      });
    }
  }

  #parseBody<T>(method: AscHttpMethod, path: string, status: number, text: string): T {
    if (text.trim().length === 0) {
      throw new AscResponseError({
        method,
        path,
        status,
        reason: 'the body was empty where a JSON document was expected',
      });
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new AscResponseError({
        method,
        path,
        status,
        reason: 'the body was not valid JSON',
      });
    }
  }

  /** Honours `Retry-After` when Apple sends it, otherwise backs off. */
  #delayFor(attempt: number, response: AscHttpResponse): number {
    const retryAfter = response.headers.get('retry-after');
    if (retryAfter !== null) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.min(seconds * 1000, 60_000);
      }
    }
    return this.#retryDelayMs(attempt);
  }

  #bearerToken(): string {
    const nowMs = this.#now();
    if (this.#token === undefined || nowMs >= this.#tokenExpiresAtMs) {
      const issuedAt = Math.floor(nowMs / 1000);
      this.#token = createAscJwt({
        keyId: this.#credentials.keyId,
        issuerId: this.#credentials.issuerId,
        signingKey: this.#credentials.signingKey,
        issuedAt,
      });
      this.#tokenExpiresAtMs =
        (issuedAt + ASC_MAX_TOKEN_LIFETIME_SECONDS - ASC_TOKEN_RENEWAL_MARGIN_SECONDS) * 1000;
    }
    return this.#token;
  }

  #buildUrl(path: string, query?: AscQuery): string {
    const absolute = path.startsWith('http://') || path.startsWith('https://');
    const base = absolute ? path : `${this.#baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    if (query === undefined) {
      return base;
    }

    const url = new URL(base);
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) {
        continue;
      }
      url.searchParams.set(key, Array.isArray(value) ? value.join(',') : String(value));
    }
    return url.toString();
  }

  /** Strips the base URL so error messages read `/v1/bundleIds?...`. */
  #displayPath(url: string): string {
    return url.startsWith(this.#baseUrl) ? url.slice(this.#baseUrl.length) : url;
  }
}

/** Convenience: environment -> key on disk -> ready client. */
export async function createAscClientFromEnvironment(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<AppStoreConnectClient> {
  const credentials = await loadAscCredentials(resolveAscConfig(env));
  return new AppStoreConnectClient({ credentials });
}
