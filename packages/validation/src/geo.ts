import { AppError } from '@family/contracts';

/**
 * Geospatial helpers.
 *
 * `coarseGeohash` is the ONLY sanctioned way to put anything location-derived
 * into a log line, metric dimension, or audit record. It is hard-capped at six
 * characters (a cell roughly a kilometre across), so no caller can accidentally
 * turn it into a precise position by asking for more precision.
 */

/** IUGG mean Earth radius. */
export const EARTH_RADIUS_METERS = 6_371_008.8;

export type GeoPoint = {
  readonly latitude: number;
  readonly longitude: number;
};

export type TimedGeoPoint = GeoPoint & {
  readonly capturedAt: string;
};

const MIN_LATITUDE = -90;
const MAX_LATITUDE = 90;
const MIN_LONGITUDE = -180;
const MAX_LONGITUDE = 180;

/**
 * Value-free failure. The message deliberately names the field and not the
 * number, so it is safe to log or return.
 */
function invalidCoordinate(): AppError {
  return new AppError('VALIDATION_FAILED', 'Coordinate is outside the valid range.', [
    { path: 'coordinate', message: 'This value is not a valid coordinate.' },
  ]);
}

export function isValidCoordinate(point: GeoPoint): boolean {
  return (
    Number.isFinite(point.latitude) &&
    Number.isFinite(point.longitude) &&
    point.latitude >= MIN_LATITUDE &&
    point.latitude <= MAX_LATITUDE &&
    point.longitude >= MIN_LONGITUDE &&
    point.longitude <= MAX_LONGITUDE
  );
}

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

/**
 * Great-circle distance in metres.
 *
 * Handles antimeridian wrap-around naturally: the half-angle sine is symmetric
 * about 180 degrees, so a pair straddling the date line yields the short arc
 * rather than the long way round.
 *
 * @throws AppError('VALIDATION_FAILED') if either point is not a real
 * coordinate — silently returning NaN would let a bad fix flow into a
 * plausibility decision and be treated as "not implausible".
 */
export function haversineMeters(a: GeoPoint, b: GeoPoint): number {
  if (!isValidCoordinate(a) || !isValidCoordinate(b)) {
    throw invalidCoordinate();
  }

  const latitude1 = toRadians(a.latitude);
  const latitude2 = toRadians(b.latitude);
  const deltaLatitude = latitude2 - latitude1;
  const deltaLongitude = toRadians(b.longitude - a.longitude);

  const sinHalfLatitude = Math.sin(deltaLatitude / 2);
  const sinHalfLongitude = Math.sin(deltaLongitude / 2);

  const chord =
    sinHalfLatitude * sinHalfLatitude +
    Math.cos(latitude1) * Math.cos(latitude2) * sinHalfLongitude * sinHalfLongitude;

  // Clamp guards against a chord marginally above 1 from floating-point drift.
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(chord)));
}

/** Metres per degree of latitude; useful for building test fixtures. */
export const METERS_PER_DEGREE_LATITUDE = (EARTH_RADIUS_METERS * Math.PI) / 180;

// ---------------------------------------------------------------------------
// Coarse geohash
// ---------------------------------------------------------------------------

const GEOHASH_ALPHABET = '0123456789bcdefghjkmnpqrstuvwxyz';
const BITS_PER_CHARACTER = 5;

/** Smallest precision worth emitting: a cell thousands of kilometres wide. */
export const MIN_COARSE_GEOHASH_PRECISION = 1;

/**
 * Hard ceiling. Six characters is roughly a kilometre — coarse enough that it
 * identifies a neighbourhood, not a person. Requests for more are clamped, not
 * honoured, so no call site can opt out of the privacy floor.
 */
export const MAX_COARSE_GEOHASH_PRECISION = 6;

export const DEFAULT_COARSE_GEOHASH_PRECISION = 5;

function clampPrecision(precision: number): number {
  if (!Number.isFinite(precision)) {
    return DEFAULT_COARSE_GEOHASH_PRECISION;
  }
  const truncated = Math.trunc(precision);
  if (truncated < MIN_COARSE_GEOHASH_PRECISION) {
    return MIN_COARSE_GEOHASH_PRECISION;
  }
  if (truncated > MAX_COARSE_GEOHASH_PRECISION) {
    return MAX_COARSE_GEOHASH_PRECISION;
  }
  return truncated;
}

/**
 * Standard base32 geohash, clamped to a coarse precision.
 *
 * @throws AppError('VALIDATION_FAILED') on an invalid coordinate.
 */
export function coarseGeohash(
  latitude: number,
  longitude: number,
  precision: number = DEFAULT_COARSE_GEOHASH_PRECISION,
): string {
  if (!isValidCoordinate({ latitude, longitude })) {
    throw invalidCoordinate();
  }

  const targetLength = clampPrecision(precision);

  let latitudeLow = MIN_LATITUDE;
  let latitudeHigh = MAX_LATITUDE;
  let longitudeLow = MIN_LONGITUDE;
  let longitudeHigh = MAX_LONGITUDE;

  let hash = '';
  let bits = 0;
  let bitCount = 0;
  let splittingLongitude = true;

  while (hash.length < targetLength) {
    if (splittingLongitude) {
      const middle = (longitudeLow + longitudeHigh) / 2;
      if (longitude >= middle) {
        bits = bits * 2 + 1;
        longitudeLow = middle;
      } else {
        bits *= 2;
        longitudeHigh = middle;
      }
    } else {
      const middle = (latitudeLow + latitudeHigh) / 2;
      if (latitude >= middle) {
        bits = bits * 2 + 1;
        latitudeLow = middle;
      } else {
        bits *= 2;
        latitudeHigh = middle;
      }
    }

    splittingLongitude = !splittingLongitude;
    bitCount += 1;

    if (bitCount === BITS_PER_CHARACTER) {
      hash += GEOHASH_ALPHABET.charAt(bits);
      bits = 0;
      bitCount = 0;
    }
  }

  return hash;
}
