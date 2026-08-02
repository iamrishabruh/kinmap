import { CoordinateCryptoError } from './errors.js';
import { COORDINATE_PAYLOAD_BYTES, CoordinatesSchema, type Coordinates } from './types.js';

/**
 * Fixed-width binary payload: latitude then longitude as little-endian IEEE-754
 * doubles.
 *
 * A decimal/JSON encoding would either truncate (losing the ~1 cm of precision
 * the 7th decimal place carries) or leak length information about the value.
 * A constant 16 bytes round-trips bit-exactly and makes every ciphertext the
 * same size, so ciphertext length reveals nothing.
 */

export function encodeCoordinates(coordinates: Coordinates): Buffer {
  assertValidCoordinates(coordinates);
  const payload = Buffer.alloc(COORDINATE_PAYLOAD_BYTES);
  payload.writeDoubleLE(coordinates.lat, 0);
  payload.writeDoubleLE(coordinates.lng, 8);
  return payload;
}

/**
 * @throws CoordinateCryptoError INTEGRITY_CHECK_FAILED when the payload is the
 * wrong size or decodes to an impossible coordinate — both mean the plaintext
 * we recovered is not the plaintext that was sealed.
 */
export function decodeCoordinates(payload: Buffer): Coordinates {
  if (payload.length !== COORDINATE_PAYLOAD_BYTES) {
    throw new CoordinateCryptoError('INTEGRITY_CHECK_FAILED');
  }
  const candidate = {
    lat: payload.readDoubleLE(0),
    lng: payload.readDoubleLE(8),
  };
  if (!CoordinatesSchema.safeParse(candidate).success) {
    throw new CoordinateCryptoError('INTEGRITY_CHECK_FAILED');
  }
  return candidate;
}

/**
 * Validates without ever echoing the value. `safeParse` is used purely for its
 * boolean outcome; the zod issue list is discarded because issue objects can
 * carry the received input.
 */
export function assertValidCoordinates(value: unknown): asserts value is Coordinates {
  const parsed = CoordinatesSchema.safeParse(value);
  if (!parsed.success) {
    throw new CoordinateCryptoError('INVALID_COORDINATES');
  }
  if (!Number.isFinite(parsed.data.lat) || !Number.isFinite(parsed.data.lng)) {
    throw new CoordinateCryptoError('INVALID_COORDINATES');
  }
}
