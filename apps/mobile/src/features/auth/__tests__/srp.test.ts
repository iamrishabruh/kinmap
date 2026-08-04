import { describe, expect, it } from 'vitest';

import { cognitoTimestamp, createSrpClient, padHex } from '../cognito/srp';

import {
  bytesBase64,
  challengeFor,
  expectedSignature,
  SECRET_BLOCK,
  textBytes,
  type PoolAccount,
} from './support/cognito-server';

/**
 * The SRP handshake, checked against an independent implementation of the other
 * side (`support/cognito-server.ts`, written from the specification against
 * the Web Crypto API). Agreeing on the shared secret is the whole property: it can
 * only happen if both sides hashed the same byte strings in the same order.
 */

const POOL_NAME = '3nqFKcB6x';

const ACCOUNT: PoolAccount = {
  userIdForSrp: '8f14e45f-ceea-467a-9e57-1a1f2c4d5b6e',
  password: 'correct horse battery staple 12',
  // First nibble >= 8 on purpose: this is the salt that needs a sign byte, and
  // the value that catches a padHex that forgets one.
  salt: BigInt('0xf3a1c8b2d94e5607'),
  serverSecret: BigInt('0x2f6b1e9c4d7a3058'),
};

/** `a` is pinned so the transcript is reproducible. */
function fixedRandomBytes(seed: number): (count: number) => Uint8Array {
  return (count: number) => {
    const out = new Uint8Array(count);
    for (let index = 0; index < count; index += 1) {
      out[index] = (seed + index * 31) % 256;
    }
    return out;
  };
}

describe('padHex', () => {
  it('emits an even-length string', () => {
    expect(padHex(0xabcn)).toBe('0abc');
    expect(padHex(0x1n)).toBe('01');
    expect(padHex(0n)).toBe('00');
  });

  it('prepends a sign byte when the most significant bit is set', () => {
    // Without the leading 00 this hashes as a different byte string than the
    // server's, and the pool answers with the same opaque failure a wrong
    // password produces — which is exactly why this is asserted directly.
    expect(padHex(0x80n)).toBe('0080');
    expect(padHex(0xffn)).toBe('00ff');
    expect(padHex(0x7fn)).toBe('7f');
  });

  it('refuses a negative value rather than silently encoding one', () => {
    expect(() => padHex(-1n)).toThrow();
  });
});

describe('cognitoTimestamp', () => {
  it('formats as ddd MMM D HH:mm:ss UTC YYYY with an unpadded day', () => {
    // The pool recomputes the signature over this exact string. A zero-padded
    // day of month produces a valid-looking signature the pool rejects.
    const date = new Date(Date.UTC(2026, 7, 4, 5, 6, 7));
    expect(cognitoTimestamp(date)).toBe('Tue Aug 4 05:06:07 UTC 2026');
  });

  it('zero-pads the time components but never the day', () => {
    const date = new Date(Date.UTC(2026, 11, 25, 23, 9, 3));
    expect(cognitoTimestamp(date)).toBe('Fri Dec 25 23:09:03 UTC 2026');
  });

  it('reads the date in UTC, not the device time zone', () => {
    // 00:30 UTC on the 4th is still the 3rd in New York. Signing the local day
    // would be wrong for a third of the world for an hour a day.
    const date = new Date(Date.UTC(2026, 7, 4, 0, 30, 0));
    expect(cognitoTimestamp(date)).toContain('Aug 4');
  });
});

describe('createSrpClient', () => {
  it('produces a password claim the pool would accept', async () => {
    const client = createSrpClient({
      userPoolName: POOL_NAME,
      randomBytes: fixedRandomBytes(7),
    });
    const challenge = await challengeFor(ACCOUNT, POOL_NAME);

    const claim = await client.derivePasswordClaim({
      userIdForSrp: challenge.USER_ID_FOR_SRP,
      password: ACCOUNT.password,
      saltHex: challenge.SALT,
      serverBHex: challenge.SRP_B,
      secretBlock: challenge.SECRET_BLOCK,
      now: new Date(Date.UTC(2026, 7, 4, 5, 6, 7)),
    });

    expect(claim.timestamp).toBe('Tue Aug 4 05:06:07 UTC 2026');
    expect(claim.signature).toBe(
      await expectedSignature(ACCOUNT, POOL_NAME, client.srpA, claim.timestamp),
    );
  });

  it('produces a claim the pool would reject when the password is wrong', async () => {
    const client = createSrpClient({
      userPoolName: POOL_NAME,
      randomBytes: fixedRandomBytes(11),
    });
    const challenge = await challengeFor(ACCOUNT, POOL_NAME);

    const claim = await client.derivePasswordClaim({
      userIdForSrp: challenge.USER_ID_FOR_SRP,
      password: `${ACCOUNT.password}!`,
      saltHex: challenge.SALT,
      serverBHex: challenge.SRP_B,
      secretBlock: challenge.SECRET_BLOCK,
      now: new Date(Date.UTC(2026, 7, 4, 5, 6, 7)),
    });

    expect(claim.signature).not.toBe(
      await expectedSignature(ACCOUNT, POOL_NAME, client.srpA, claim.timestamp),
    );
  });

  it('binds the claim to the pool it was derived for', async () => {
    // The pool name is mixed into both the salted password hash and the signed
    // message. A build pointed at the wrong pool must not produce a usable
    // claim for the right one.
    const client = createSrpClient({
      userPoolName: 'someOtherPool',
      randomBytes: fixedRandomBytes(13),
    });
    const challenge = await challengeFor(ACCOUNT, POOL_NAME);

    const claim = await client.derivePasswordClaim({
      userIdForSrp: challenge.USER_ID_FOR_SRP,
      password: ACCOUNT.password,
      saltHex: challenge.SALT,
      serverBHex: challenge.SRP_B,
      secretBlock: challenge.SECRET_BLOCK,
      now: new Date(Date.UTC(2026, 7, 4, 5, 6, 7)),
    });

    expect(claim.signature).not.toBe(
      await expectedSignature(ACCOUNT, POOL_NAME, client.srpA, claim.timestamp),
    );
  });

  it('binds the claim to the challenge that asked for it', async () => {
    // The secret block is per-attempt server state. Replaying a signature
    // computed over a different block must not verify.
    const client = createSrpClient({
      userPoolName: POOL_NAME,
      randomBytes: fixedRandomBytes(17),
    });
    const challenge = await challengeFor(ACCOUNT, POOL_NAME);

    const claim = await client.derivePasswordClaim({
      userIdForSrp: challenge.USER_ID_FOR_SRP,
      password: ACCOUNT.password,
      saltHex: challenge.SALT,
      serverBHex: challenge.SRP_B,
      secretBlock: bytesBase64(textBytes('a different challenge')),
      now: new Date(Date.UTC(2026, 7, 4, 5, 6, 7)),
    });

    expect(SECRET_BLOCK).not.toBe(bytesBase64(textBytes('a different challenge')));
    expect(claim.signature).not.toBe(
      await expectedSignature(ACCOUNT, POOL_NAME, client.srpA, claim.timestamp),
    );
  });

  it('never reuses a public value across sign-in attempts', () => {
    const first = createSrpClient({ userPoolName: POOL_NAME });
    const second = createSrpClient({ userPoolName: POOL_NAME });
    expect(first.srpA).not.toBe(second.srpA);
  });

  it('rejects a server value of zero rather than deriving a key from it', async () => {
    const client = createSrpClient({
      userPoolName: POOL_NAME,
      randomBytes: fixedRandomBytes(19),
    });
    await expect(
      client.derivePasswordClaim({
        userIdForSrp: ACCOUNT.userIdForSrp,
        password: ACCOUNT.password,
        saltHex: '01',
        serverBHex: '0',
        secretBlock: SECRET_BLOCK,
      }),
    ).rejects.toThrow(/B cannot be 0/u);
  });
});
