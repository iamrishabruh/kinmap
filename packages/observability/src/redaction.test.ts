import { describe, expect, it } from 'vitest';

import { REDACTED_KEYS, isRedactedKey, normalizeKey } from './deny-list.js';
import { redact, redactToJson } from './redaction.js';

/**
 * The spec-required proof: coordinates and other denied fields must be gone
 * from a deeply nested structure AND from the string that actually reaches the
 * log stream. Asserting only on the object would miss a payload that was
 * stringified before redaction ran.
 */

const HOME_LATITUDE = 37.774929;
const HOME_LONGITUDE = -122.419418;

function deeplyNestedPayload(): Record<string, unknown> {
  return {
    requestId: 'req-1',
    family: {
      familyId: 'fam-1',
      familyName: 'The Chouhans',
      members: [
        {
          userId: 'user-1',
          sharingStatus: 'SHARING',
          email: 'someone@example.com',
          lastFix: {
            latitude: HOME_LATITUDE,
            longitude: HOME_LONGITUDE,
            horizontalAccuracy: 12,
            capturedAt: '2026-01-01T00:00:00.000Z',
          },
          devices: [
            {
              deviceId: 'device-1',
              pushToken: 'apns-token-value',
              lastKnown: { coords: { lat: HOME_LATITUDE, lng: HOME_LONGITUDE } },
            },
          ],
        },
      ],
      places: [
        {
          placeId: 'place-1',
          placeName: 'Home',
          address: '1 Market St, San Francisco',
          coordinates: [HOME_LATITUDE, HOME_LONGITUDE],
          radiusMeters: 150,
        },
      ],
    },
    session: {
      accessToken: 'header.payload.signature',
      refreshToken: 'refresh-value',
      inviteToken: 'invite-value',
      expiresAt: '2026-01-01T01:00:00.000Z',
    },
  };
}

describe('deny-list', () => {
  it('normalises separators and casing so key variants collapse', () => {
    expect(normalizeKey('access_token')).toBe('accesstoken');
    expect(normalizeKey('ACCESS-TOKEN')).toBe('accesstoken');
    expect(normalizeKey('accessToken')).toBe('accesstoken');
  });

  it('denies every spec-mandated key in each of its casings', () => {
    for (const key of REDACTED_KEYS) {
      expect(isRedactedKey(key), key).toBe(true);
      expect(isRedactedKey(key.toUpperCase()), key).toBe(true);
      expect(isRedactedKey(key.replace(/([A-Z])/g, '_$1').toLowerCase()), key).toBe(true);
    }
  });

  it('does not deny keys that merely start with a denied key', () => {
    expect(isRedactedKey('latency')).toBe(false);
    expect(isRedactedKey('flat')).toBe(false);
    expect(isRedactedKey('tokenizer')).toBe(false);
  });
});

describe('redact — deeply nested object', () => {
  it('drops coordinate keys at every nesting depth, including inside arrays', () => {
    const redacted = redact(deeplyNestedPayload()) as Record<string, any>;

    const member = redacted.family.members[0];
    expect(member.userId).toBe('user-1');
    expect(member.sharingStatus).toBe('SHARING');
    expect(member).not.toHaveProperty('email');
    expect(member.lastFix).not.toHaveProperty('latitude');
    expect(member.lastFix).not.toHaveProperty('longitude');
    // Non-sensitive siblings survive, which is what makes the log useful.
    expect(member.lastFix.horizontalAccuracy).toBe(12);
    expect(member.lastFix.capturedAt).toBe('2026-01-01T00:00:00.000Z');

    const device = member.devices[0];
    expect(device.deviceId).toBe('device-1');
    expect(device).not.toHaveProperty('pushToken');
    expect(device.lastKnown).not.toHaveProperty('coords');

    const place = redacted.family.places[0];
    expect(place.placeId).toBe('place-1');
    expect(place.radiusMeters).toBe(150);
    expect(place).not.toHaveProperty('placeName');
    expect(place).not.toHaveProperty('address');
    expect(place).not.toHaveProperty('coordinates');

    expect(redacted.family).not.toHaveProperty('familyName');
    expect(redacted.session).not.toHaveProperty('accessToken');
    expect(redacted.session).not.toHaveProperty('refreshToken');
    expect(redacted.session).not.toHaveProperty('inviteToken');
    expect(redacted.session.expiresAt).toBe('2026-01-01T01:00:00.000Z');
  });

  it('does not mutate the input', () => {
    const original = deeplyNestedPayload();
    redact(original);
    expect((original.family as any).members[0].lastFix.latitude).toBe(HOME_LATITUDE);
  });
});

describe('redact — stringified payload', () => {
  it('leaves no coordinate key or value anywhere in the serialised output', () => {
    const serialized = redactToJson(deeplyNestedPayload());

    for (const key of REDACTED_KEYS) {
      expect(serialized, `key "${key}" survived serialisation`).not.toContain(`"${key}"`);
    }
    expect(serialized).not.toContain(String(HOME_LATITUDE));
    expect(serialized).not.toContain(String(HOME_LONGITUDE));
    expect(serialized).not.toContain('37.774');
    expect(serialized).not.toContain('122.419');
    expect(serialized).not.toContain('someone@example.com');
    expect(serialized).not.toContain('Market St');

    // Still a useful log line.
    expect(serialized).toContain('"requestId":"req-1"');
    expect(serialized).toContain('"radiusMeters":150');
  });

  it('redacts JSON that was stringified before it reached the logger', () => {
    const smuggled = {
      note: 'batch upload',
      body: JSON.stringify({
        events: [{ eventId: 'e1', latitude: HOME_LATITUDE, longitude: HOME_LONGITUDE }],
      }),
    };

    const serialized = redactToJson(smuggled);

    expect(serialized).not.toContain('37.774');
    expect(serialized).not.toContain('122.419');
    expect(serialized).not.toContain('latitude');
    expect(serialized).toContain('e1');
  });

  it('scrubs coordinates interpolated into free text', () => {
    const serialized = redactToJson({
      reason: `fix rejected at ${HOME_LATITUDE},${HOME_LONGITUDE}`,
      note: 'latitude: 37.774929 was implausible',
    });

    expect(serialized).not.toContain('37.774');
    expect(serialized).not.toContain('122.419');
    expect(serialized).toContain('fix rejected at');
  });
});

describe('redact — structural edge cases', () => {
  it('handles cycles without recursing forever', () => {
    const node: Record<string, unknown> = { id: 'a', latitude: HOME_LATITUDE };
    node.self = node;

    const redacted = redact(node) as Record<string, unknown>;

    expect(redacted).not.toHaveProperty('latitude');
    expect(redacted.self).toBe('[circular]');
  });

  it('walks Maps and Sets', () => {
    const redacted = redact({
      byUser: new Map([['user-1', { lat: HOME_LATITUDE, deviceCount: 2 }]]),
      seen: new Set(['a', 'b']),
    }) as Record<string, any>;

    expect(redacted.byUser['user-1']).toEqual({ deviceCount: 2 });
    expect(redacted.seen).toEqual(['a', 'b']);
  });

  it('serialises Errors without a stack by default and scrubs the message', () => {
    const error = new Error(`geocode failed for ${HOME_LATITUDE},${HOME_LONGITUDE}`);
    const redacted = redact({ err: error }) as Record<string, any>;

    expect(redacted.err.name).toBe('Error');
    expect(redacted.err.message).not.toContain('37.774');
    expect(redacted.err).not.toHaveProperty('stack');
  });

  it('stops at the configured depth instead of blowing the stack', () => {
    let deep: Record<string, unknown> = { latitude: HOME_LATITUDE };
    for (let index = 0; index < 40; index += 1) deep = { nested: deep };

    const serialized = redactToJson(deep, { maxDepth: 5 });

    expect(serialized).toContain('[max-depth]');
    expect(serialized).not.toContain('37.774');
  });
});
