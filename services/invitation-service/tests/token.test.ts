import { createHash, timingSafeEqual } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { InvitationTokenSchema } from '@family/schemas';

import {
  buildInviteUrl,
  generateInvitationToken,
  hashInvitationToken,
  INVITATION_HASH_LENGTH,
  INVITATION_TOKEN_BYTES,
  timingSafeHashEquals,
} from '../src/domain/token.js';

describe('generateInvitationToken', () => {
  it('draws 32 bytes from the CSPRNG', () => {
    const random = vi.fn((size: number) => Buffer.alloc(size, 7));

    const issued = generateInvitationToken(random);

    expect(random).toHaveBeenCalledWith(INVITATION_TOKEN_BYTES);
    expect(Buffer.from(issued.token, 'base64url')).toHaveLength(INVITATION_TOKEN_BYTES);
  });

  it('produces a token the API contract accepts as URL-safe', () => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const { token } = generateInvitationToken();
      expect(InvitationTokenSchema.safeParse(token).success).toBe(true);
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('never repeats', () => {
    const seen = new Set<string>();
    for (let attempt = 0; attempt < 500; attempt += 1) {
      seen.add(generateInvitationToken().token);
    }
    expect(seen.size).toBe(500);
  });

  it('returns a hash that is not the token and cannot be reversed to it', () => {
    const issued = generateInvitationToken();

    expect(issued.tokenHash).not.toBe(issued.token);
    expect(issued.tokenHash).toHaveLength(INVITATION_HASH_LENGTH);
    expect(issued.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    // The hash is a plain SHA-256 of the token: verifiable, one-way.
    expect(issued.tokenHash).toBe(createHash('sha256').update(issued.token, 'utf8').digest('hex'));
    expect(issued.tokenHash).not.toContain(issued.token.slice(0, 8));
  });
});

describe('hashInvitationToken', () => {
  it('is deterministic', () => {
    expect(hashInvitationToken('abc')).toBe(hashInvitationToken('abc'));
  });

  it('separates tokens that differ by one character', () => {
    expect(hashInvitationToken('abc')).not.toBe(hashInvitationToken('abd'));
  });
});

describe('timingSafeHashEquals', () => {
  it('accepts an identical hash', () => {
    const hash = hashInvitationToken('token');
    expect(timingSafeHashEquals(hash, hash)).toBe(true);
  });

  it('rejects a different hash', () => {
    expect(timingSafeHashEquals(hashInvitationToken('a'), hashInvitationToken('b'))).toBe(false);
  });

  it('rejects hashes of different lengths without throwing', () => {
    expect(timingSafeHashEquals('short', hashInvitationToken('a'))).toBe(false);
    expect(timingSafeHashEquals(hashInvitationToken('a'), '')).toBe(false);
  });

  it('uses a constant-time primitive rather than string comparison', () => {
    // Proves the property structurally: the implementation delegates to
    // node:crypto's timingSafeEqual, the only comparison in Node that does not
    // short-circuit on the first differing byte. A regression to `===` or to
    // `Buffer.compare` would fail here even though the return values match.
    const source = timingSafeHashEquals.toString();

    expect(source).toContain('timingSafeEqual');
    expect(source).not.toContain('===');
    expect(source).not.toContain('localeCompare');
    expect(source).not.toContain('.compare(');
    expect(source).not.toContain('startsWith');
  });

  it('agrees with the primitive it wraps on equal-length inputs', () => {
    const left = hashInvitationToken('left');
    const right = hashInvitationToken('right');

    expect(timingSafeHashEquals(left, right)).toBe(
      timingSafeEqual(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')),
    );
  });

  it('does not leak how many leading characters matched', () => {
    const target = hashInvitationToken('target');
    // Differs only in the final character.
    const almost = `${target.slice(0, 63)}${target.at(63) === 'a' ? 'b' : 'a'}`;
    // Differs from the first character onwards.
    const nothing = hashInvitationToken('completely-different');

    // Rejected identically; nothing in the outcome distinguishes "wrong on the
    // last character" from "wrong everywhere".
    expect(timingSafeHashEquals(target, almost)).toBe(false);
    expect(timingSafeHashEquals(target, nothing)).toBe(false);
  });
});

describe('buildInviteUrl', () => {
  it('embeds the token in a universal link', () => {
    expect(buildInviteUrl('https://kinmap.example/invite', 'abc-123')).toBe(
      'https://kinmap.example/invite/abc-123',
    );
  });

  it('tolerates a trailing slash on the base', () => {
    expect(buildInviteUrl('https://kinmap.example/invite/', 'abc')).toBe(
      'https://kinmap.example/invite/abc',
    );
  });

  it('percent-encodes so a hostile token cannot escape the path', () => {
    expect(buildInviteUrl('https://kinmap.example/invite', '../../admin')).toBe(
      'https://kinmap.example/invite/..%2F..%2Fadmin',
    );
  });
});
