import { hkdfSha256, hmacSha256, randomBytes, sha256 } from '@/features/location/crypto/digest';

import { concatBytes, fromBase64, fromHex, toBase64, toHex, utf8Encode } from './encoding';

/**
 * Secure Remote Password, the Cognito dialect.
 *
 * The deployed app client permits exactly one explicit auth flow —
 * `ALLOW_USER_SRP_AUTH`, verified against the pool, and the only one it is
 * *allowed* to permit while refresh-token rotation is on. That is the whole
 * reason this file exists, and it is a good constraint: the password is never
 * sent anywhere. What travels is a public value `A`, and then a signature that
 * can only be produced by someone who knows the password, computed against a
 * value `B` that only the pool could have produced. Neither side can be
 * replayed and a network observer learns nothing usable.
 *
 * WHY THIS IS NOT A DEPENDENCY. Every published Cognito SRP client fails one of
 * this app's constraints: `amazon-cognito-identity-js` resolves its React
 * Native storage helper to `@react-native-async-storage/async-storage` — the
 * one place tokens are forbidden to go — and ships two autolinked native
 * modules; `@aws-amplify/auth` additionally requires `@aws-amplify/react-native`
 * and a global `Amplify.configure`; the small third-party helpers reach for
 * Node's `crypto`. What is left is modular arithmetic over a fixed group, and
 * the app already owns audited SHA-256, HMAC and HKDF built on the native
 * digest (`features/location/crypto/digest.ts`). Forking those primitives to
 * avoid one import would be the genuinely dangerous choice, so they are reused.
 *
 * The transcript below is `AuthenticationHelper` in `amazon-cognito-identity-js`
 * expressed with Hermes's native BigInt, including the details that are easy to
 * get subtly wrong and that the pool answers with an indistinguishable failure:
 * the sign-byte hex padding, the salt being re-normalised through an integer
 * rather than used as the string the server sent, and the unpadded day-of-month
 * in the signed timestamp.
 */

/** RFC 5054 group 3072. Fixed by Cognito; not configurable. */
const N_HEX =
  'FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD1' +
  '29024E088A67CC74020BBEA63B139B22514A08798E3404DD' +
  'EF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245' +
  'E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED' +
  'EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3D' +
  'C2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F' +
  '83655D23DCA3AD961C62F356208552BB9ED529077096966D' +
  '670C354E4ABC9804F1746C08CA18217C32905E462E36CE3B' +
  'E39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9' +
  'DE2BCBF6955817183995497CEA956AE515D2261898FA0510' +
  '15728E5A8AAAC42DAD33170D04507A33A85521ABDF1CBA64' +
  'ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7' +
  'ABF5AE8CDB0933D71E8C94E04A25619DCEE3D2261AD2EE6B' +
  'F12FFA06D98A0864D87602733EC86A64521F2B18177B200C' +
  'BBE117577A615D6C770988C0BAD946E208E24FA074E5AB31' +
  '43DB5BFCE0FD108E4B82D120A93AD2CAFFFFFFFFFFFFFFFF';

const N = BigInt(`0x${N_HEX}`);
const G = 2n;

/** Cognito's HKDF info string. Not a secret; it is a domain separator. */
const DERIVED_KEY_INFO = 'Caldera Derived Key';
const DERIVED_KEY_BYTES = 16;

/** 128 bytes of `a`. N is 3072-bit, so no reduction modulo N-1 is needed. */
const SMALL_A_BYTES = 128;

const WEEK_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

// ---------------------------------------------------------------------------
// Arithmetic and encoding helpers
// ---------------------------------------------------------------------------

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  // The base may arrive negative — `B - k*g^x` routinely is — and a negative
  // JavaScript remainder would silently produce the wrong shared secret.
  let value = ((base % modulus) + modulus) % modulus;
  let remaining = exponent;
  while (remaining > 0n) {
    if ((remaining & 1n) === 1n) {
      result = (result * value) % modulus;
    }
    value = (value * value) % modulus;
    remaining >>= 1n;
  }
  return result;
}

/**
 * An unambiguous, even-length hex string with an explicit sign byte.
 *
 * Every value SRP hashes is a non-negative integer, but the transcript is
 * defined over *bytes*, so a value whose top nibble is >= 8 gets a leading
 * `00`. Omitting it hashes a different byte string than the server does, and
 * the only symptom is a signature the pool rejects.
 */
export function padHex(value: bigint): string {
  if (value < 0n) {
    throw new Error('padHex expects a non-negative value.');
  }
  let hex = value.toString(16);
  if (hex.length % 2 !== 0) {
    hex = `0${hex}`;
  }
  return /^[89a-f]/iu.test(hex) ? `00${hex}` : hex;
}

async function hashBytes(bytes: Uint8Array): Promise<string> {
  return toHex(await sha256(bytes));
}

/** SHA-256 of the bytes a hex string denotes, returned as hex. */
async function hexHash(hex: string): Promise<string> {
  return hashBytes(fromHex(hex));
}

/**
 * `ddd MMM D HH:mm:ss UTC YYYY`, in UTC.
 *
 * The day of month is NOT zero-padded and the time components are. The pool
 * recomputes the signature over this exact string, so the format is part of the
 * protocol rather than a presentation choice.
 */
export function cognitoTimestamp(now: Date): string {
  const pad = (value: number): string => (value < 10 ? `0${value}` : `${value}`);
  const weekDay = WEEK_DAYS[now.getUTCDay()] ?? WEEK_DAYS[0];
  const month = MONTHS[now.getUTCMonth()] ?? MONTHS[0];
  const time = `${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())}`;
  return `${weekDay} ${month} ${now.getUTCDate()} ${time} UTC ${now.getUTCFullYear()}`;
}

// ---------------------------------------------------------------------------
// Handshake
// ---------------------------------------------------------------------------

/** The `PASSWORD_VERIFIER` challenge, exactly as Cognito states it. */
export type PasswordVerifierChallenge = {
  /**
   * `USER_ID_FOR_SRP` from the challenge parameters — the pool's own identifier
   * for the account, which is what the transcript is bound to. Not the address
   * the user typed, and not something to show or store.
   */
  readonly userIdForSrp: string;
  readonly password: string;
  /** `SALT`, hex. */
  readonly saltHex: string;
  /** `SRP_B`, hex. */
  readonly serverBHex: string;
  /** `SECRET_BLOCK`, base64. Opaque server state; echoed back untouched. */
  readonly secretBlock: string;
  /** Injected so the signed timestamp is deterministic under test. */
  readonly now?: Date;
};

export type PasswordClaim = {
  readonly signature: string;
  readonly timestamp: string;
};

export type SrpClient = {
  /** `SRP_A` as it goes on the wire: bare hex, no sign byte. */
  readonly srpA: string;
  derivePasswordClaim(challenge: PasswordVerifierChallenge): Promise<PasswordClaim>;
};

/**
 * `k = H(N | g)`. A constant of the group, so it is computed once per process
 * rather than per sign-in, and computed rather than pasted so the derivation
 * stays auditable.
 */
let kValue: Promise<bigint> | null = null;
function multiplierParameter(): Promise<bigint> {
  kValue ??= hexHash(`${padHex(N)}${padHex(G)}`).then((hex) => BigInt(`0x${hex}`));
  return kValue;
}

export type SrpClientOptions = {
  /** The pool name, e.g. `XXXXXXXXX`. Mixed into `x` and into the signature. */
  readonly userPoolName: string;
  /** Overridable only so a test can pin `a` and get a reproducible transcript. */
  readonly randomBytes?: (count: number) => Uint8Array;
};

export function createSrpClient(options: SrpClientOptions): SrpClient {
  const source = options.randomBytes ?? randomBytes;
  const smallA = BigInt(`0x${toHex(source(SMALL_A_BYTES))}`);
  const largeA = modPow(G, smallA, N);

  // A ≡ 0 (mod N) would let anyone authenticate as anyone. It cannot happen
  // with a random 1024-bit `a`, and it is still checked, because the cost of
  // the check is nothing and the cost of being wrong is every account.
  if (largeA % N === 0n) {
    throw new Error('Illegal parameter: A mod N cannot be 0.');
  }

  return {
    srpA: largeA.toString(16),

    async derivePasswordClaim(challenge: PasswordVerifierChallenge): Promise<PasswordClaim> {
      const serverB = BigInt(`0x${challenge.serverBHex}`);
      if (serverB % N === 0n) {
        throw new Error('Illegal parameter: B cannot be 0.');
      }

      const scrambler = BigInt(`0x${await hexHash(`${padHex(largeA)}${padHex(serverB)}`)}`);
      if (scrambler === 0n) {
        throw new Error('Illegal parameter: u cannot be 0.');
      }

      // The salt is re-normalised through an integer rather than hashed as the
      // string the server sent: a salt whose first nibble is >= 8 arrives
      // without the sign byte the transcript requires.
      const salt = BigInt(`0x${challenge.saltHex}`);

      // The only place the password appears. It is hashed immediately and the
      // string is never stored, logged, or included in any error below.
      const credentialHash = await hashBytes(
        utf8Encode(`${options.userPoolName}${challenge.userIdForSrp}:${challenge.password}`),
      );
      const exponent = BigInt(`0x${await hexHash(`${padHex(salt)}${credentialHash}`)}`);

      const verifier = modPow(G, exponent, N);
      const kMultiplier = await multiplierParameter();
      const sharedSecret = modPow(
        serverB - kMultiplier * verifier,
        smallA + scrambler * exponent,
        N,
      );

      const key = await hkdfSha256(
        fromHex(padHex(sharedSecret)),
        fromHex(padHex(scrambler)),
        utf8Encode(DERIVED_KEY_INFO),
        DERIVED_KEY_BYTES,
      );

      const timestamp = cognitoTimestamp(challenge.now ?? new Date());
      const message = concatBytes(
        utf8Encode(options.userPoolName),
        utf8Encode(challenge.userIdForSrp),
        fromBase64(challenge.secretBlock),
        utf8Encode(timestamp),
      );

      return { signature: toBase64(await hmacSha256(key, message)), timestamp };
    },
  };
}

/** Exposed for the round-trip test that plays the server side of the handshake. */
export const SRP_GROUP = { N, G } as const;
