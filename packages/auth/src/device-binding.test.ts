import { describe, expect, it } from 'vitest';

import { DEVICE_ID_CLAIM, resolveDeviceId } from './device-binding.js';

/**
 * This resolver decides whether a request can reach anybody's location: the
 * authorization checker denies every location-bearing operation when it returns
 * null. It returned null for every request in the deployed environment, because
 * the only source it read was a claim the user pool does not mint.
 */
const DEVICE = '018f3a2b-4c5d-7e8f-9a0b-1c2d3e4f5a6b';
const OTHER = '018f3a2b-4c5d-7e8f-9a0b-000000000000';

describe('resolveDeviceId', () => {
  it('prefers the signed claim over the header', () => {
    // The claim is inside a signature the caller cannot forge, so when both are
    // present the header must not be able to override it.
    expect(
      resolveDeviceId({
        claims: { [DEVICE_ID_CLAIM]: DEVICE },
        headers: { 'x-device-id': OTHER },
      }),
    ).toBe(DEVICE);
  });

  it('falls back to the header when the pool mints no claim', () => {
    expect(resolveDeviceId({ claims: {}, headers: { 'x-device-id': DEVICE } })).toBe(DEVICE);
  });

  it('matches the header whatever its case', () => {
    // API Gateway lower-cases header names in the v2 payload; a direct
    // invocation or a test may not.
    expect(resolveDeviceId({ headers: { 'X-Device-Id': DEVICE } })).toBe(DEVICE);
  });

  it('rejects a value that is not a device id', () => {
    // A malformed assertion must resolve to null rather than flow into an
    // authorization decision as an untyped string.
    expect(resolveDeviceId({ headers: { 'x-device-id': 'not-a-device-id' } })).toBeNull();
    expect(resolveDeviceId({ claims: { [DEVICE_ID_CLAIM]: 42 } })).toBeNull();
  });

  it('returns null when there is nothing to read', () => {
    expect(resolveDeviceId({})).toBeNull();
    expect(resolveDeviceId({ claims: {}, headers: {} })).toBeNull();
    expect(resolveDeviceId({ headers: null })).toBeNull();
  });
});
