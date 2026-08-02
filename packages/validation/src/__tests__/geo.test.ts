import { describe, expect, it } from 'vitest';

import { AppError } from '@family/contracts';

import {
  coarseGeohash,
  DEFAULT_COARSE_GEOHASH_PRECISION,
  EARTH_RADIUS_METERS,
  haversineMeters,
  isValidCoordinate,
  MAX_COARSE_GEOHASH_PRECISION,
  METERS_PER_DEGREE_LATITUDE,
} from '../index.js';

describe('isValidCoordinate', () => {
  it('accepts the extremes of both axes', () => {
    expect(isValidCoordinate({ latitude: 90, longitude: 180 })).toBe(true);
    expect(isValidCoordinate({ latitude: -90, longitude: -180 })).toBe(true);
  });

  it('rejects values outside either axis', () => {
    expect(isValidCoordinate({ latitude: 90.0001, longitude: 0 })).toBe(false);
    expect(isValidCoordinate({ latitude: 0, longitude: 180.0001 })).toBe(false);
  });

  it('rejects non-finite values', () => {
    expect(isValidCoordinate({ latitude: Number.NaN, longitude: 0 })).toBe(false);
    expect(isValidCoordinate({ latitude: 0, longitude: Number.POSITIVE_INFINITY })).toBe(false);
  });
});

describe('haversineMeters', () => {
  it('is zero for identical points', () => {
    expect(
      haversineMeters({ latitude: 51.5, longitude: -0.12 }, { latitude: 51.5, longitude: -0.12 }),
    ).toBe(0);
  });

  it('matches one degree of latitude at the equator', () => {
    const distance = haversineMeters({ latitude: 0, longitude: 0 }, { latitude: 1, longitude: 0 });

    expect(distance).toBeCloseTo(METERS_PER_DEGREE_LATITUDE, 3);
  });

  it('matches a known long-haul distance', () => {
    // London to Paris, ~343.5 km.
    const distance = haversineMeters(
      { latitude: 51.5007, longitude: -0.1246 },
      { latitude: 48.8567, longitude: 2.3508 },
    );

    expect(distance).toBeGreaterThan(342_000);
    expect(distance).toBeLessThan(345_000);
  });

  it('is symmetric', () => {
    const a = { latitude: 37.4219, longitude: -122.0841 };
    const b = { latitude: 37.3861, longitude: -122.0839 };

    expect(haversineMeters(a, b)).toBeCloseTo(haversineMeters(b, a), 9);
  });

  it('takes the short arc across the antimeridian', () => {
    const distance = haversineMeters(
      { latitude: 0, longitude: 179.5 },
      { latitude: 0, longitude: -179.5 },
    );

    // One degree of arc, not 359.
    expect(distance).toBeCloseTo(METERS_PER_DEGREE_LATITUDE, 3);
  });

  it('reaches half the circumference for antipodal points', () => {
    const distance = haversineMeters(
      { latitude: 0, longitude: 0 },
      { latitude: 0, longitude: 180 },
    );

    expect(distance).toBeCloseTo(Math.PI * EARTH_RADIUS_METERS, 3);
  });

  it('throws rather than returning NaN for an invalid coordinate', () => {
    expect(() =>
      haversineMeters({ latitude: 999, longitude: 0 }, { latitude: 0, longitude: 0 }),
    ).toThrow(AppError);

    expect(() =>
      haversineMeters({ latitude: 0, longitude: 0 }, { latitude: Number.NaN, longitude: 0 }),
    ).toThrow(AppError);
  });

  it('does not put the offending coordinate into the error', () => {
    try {
      haversineMeters({ latitude: 91.987654, longitude: -122.0841 }, { latitude: 0, longitude: 0 });
      expect.unreachable('haversineMeters should have thrown');
    } catch (error) {
      const appError = error as AppError;
      expect(appError.code).toBe('VALIDATION_FAILED');
      expect(appError.message).not.toMatch(/\d/);
      expect(JSON.stringify(appError.fields)).not.toMatch(/\d/);
    }
  });
});

describe('coarseGeohash', () => {
  it('matches the reference encoding', () => {
    // The canonical geohash for this point is "u4pruydqqvj"; five characters
    // of it is the coarse prefix.
    expect(coarseGeohash(57.64911, 10.40744, 5)).toBe('u4pru');
  });

  it('encodes the null island', () => {
    expect(coarseGeohash(0, 0, 5)).toBe('s0000');
  });

  it('defaults to the coarse default precision', () => {
    expect(coarseGeohash(57.64911, 10.40744)).toHaveLength(DEFAULT_COARSE_GEOHASH_PRECISION);
  });

  it('produces a prefix relationship as precision grows', () => {
    const coarse = coarseGeohash(57.64911, 10.40744, 3);
    const finer = coarseGeohash(57.64911, 10.40744, 6);

    expect(finer.startsWith(coarse)).toBe(true);
  });

  it('clamps a precision request above the privacy ceiling', () => {
    expect(coarseGeohash(57.64911, 10.40744, 12)).toHaveLength(MAX_COARSE_GEOHASH_PRECISION);
    expect(coarseGeohash(57.64911, 10.40744, 1000)).toHaveLength(MAX_COARSE_GEOHASH_PRECISION);
  });

  it('clamps a precision request below the floor', () => {
    expect(coarseGeohash(57.64911, 10.40744, 0)).toHaveLength(1);
    expect(coarseGeohash(57.64911, 10.40744, -5)).toHaveLength(1);
  });

  it('falls back to the default for a non-finite precision', () => {
    expect(coarseGeohash(57.64911, 10.40744, Number.NaN)).toHaveLength(
      DEFAULT_COARSE_GEOHASH_PRECISION,
    );
  });

  it('truncates a fractional precision', () => {
    expect(coarseGeohash(57.64911, 10.40744, 3.9)).toHaveLength(3);
  });

  it('holds the privacy ceiling at a coarse cell size', () => {
    // Six characters is roughly a kilometre. Raising this constant would widen
    // what may legally be logged, so it is asserted rather than assumed.
    expect(MAX_COARSE_GEOHASH_PRECISION).toBe(6);
    expect(DEFAULT_COARSE_GEOHASH_PRECISION).toBeLessThanOrEqual(MAX_COARSE_GEOHASH_PRECISION);
  });

  it('throws on an invalid coordinate', () => {
    expect(() => coarseGeohash(91, 0)).toThrow(AppError);
    expect(() => coarseGeohash(0, 181)).toThrow(AppError);
    expect(() => coarseGeohash(Number.NaN, 0)).toThrow(AppError);
  });

  it('emits only base32 geohash characters', () => {
    expect(coarseGeohash(-33.8688, 151.2093, 6)).toMatch(/^[0-9bcdefghjkmnpqrstuvwxyz]+$/);
  });
});
