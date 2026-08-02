import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { AppError } from '@family/contracts';
import { LocationBatchRequestSchema } from '@family/schemas';

import {
  formatFieldPath,
  parseOrThrow,
  toFieldErrors,
  VALIDATION_FAILED_MESSAGE,
} from '../index.js';

function uuid(seed: number): string {
  return `00000000-0000-4000-8000-${seed.toString(16).padStart(12, '0')}`;
}

const DEVICE_ID = uuid(1);

function locationEvent(overrides: Record<string, unknown> = {}): unknown {
  return {
    eventId: uuid(1000),
    deviceId: DEVICE_ID,
    sequenceNumber: 0,
    latitude: 37.4219,
    longitude: -122.0841,
    horizontalAccuracy: 12,
    trackingMode: 'PASSIVE',
    capturedAt: '2026-08-02T10:00:00.000Z',
    createdAt: '2026-08-02T10:00:01.000Z',
    ...overrides,
  };
}

describe('formatFieldPath', () => {
  it('renders the root path when there are no segments', () => {
    expect(formatFieldPath([])).toBe('(root)');
  });

  it('renders a top-level key without a leading dot', () => {
    expect(formatFieldPath(['deviceId'])).toBe('deviceId');
  });

  it('renders nested keys with dots', () => {
    expect(formatFieldPath(['health', 'permission', 'authorization'])).toBe(
      'health.permission.authorization',
    );
  });

  it('renders array indices with brackets', () => {
    expect(formatFieldPath(['events', 3, 'latitude'])).toBe('events[3].latitude');
  });

  it('renders a leading index', () => {
    expect(formatFieldPath([0, 'latitude'])).toBe('[0].latitude');
  });
});

describe('toFieldErrors', () => {
  it('produces one entry per issue with a fixed message', () => {
    const schema = z.strictObject({ name: z.string(), age: z.number() });
    const result = schema.safeParse({ name: 42, age: 'old' });

    expect(result.success).toBe(false);
    if (result.success) return;

    const fields = toFieldErrors(result.error);

    expect(fields).toHaveLength(2);
    expect(fields.map((field) => field.path).sort()).toEqual(['age', 'name']);
    for (const field of fields) {
      expect(field.message).toBe('This value has the wrong type.');
    }
  });

  it('points at each unrecognised key individually', () => {
    const schema = z.strictObject({ name: z.string() });
    const result = schema.safeParse({ name: 'ok', extraOne: 1, extraTwo: 2 });

    expect(result.success).toBe(false);
    if (result.success) return;

    const paths = toFieldErrors(result.error).map((field) => field.path);

    expect(paths).toContain('extraOne');
    expect(paths).toContain('extraTwo');
  });

  it('falls back to a generic message for an unknown issue code', () => {
    const fields = toFieldErrors({
      issues: [{ code: 'a_code_zod_has_not_invented_yet', path: ['field'] }],
    });

    expect(fields).toEqual([{ path: 'field', message: 'This value is not valid.' }]);
  });

  it('falls back to a generic message when an issue has no code', () => {
    const fields = toFieldErrors({ issues: [{ path: ['field'] }] });

    expect(fields[0]?.message).toBe('This value is not valid.');
  });
});

describe('parseOrThrow', () => {
  it('returns the parsed value on success, applying defaults', () => {
    const parsed = parseOrThrow(LocationBatchRequestSchema, {
      deviceId: DEVICE_ID,
      uploadedAt: '2026-08-02T10:00:01.000Z',
      events: [locationEvent()],
    });

    expect(parsed.events).toHaveLength(1);
    expect(parsed.configVersion).toBeNull();
  });

  it('throws AppError with the VALIDATION_FAILED code', () => {
    expect(() => parseOrThrow(z.strictObject({ name: z.string() }), {})).toThrow(AppError);

    try {
      parseOrThrow(z.strictObject({ name: z.string() }), {});
      expect.unreachable('parseOrThrow should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      const appError = error as AppError;
      expect(appError.code).toBe('VALIDATION_FAILED');
      expect(appError.status).toBe(422);
      expect(appError.message).toBe(VALIDATION_FAILED_MESSAGE);
      expect(appError.fields).toEqual([
        { path: 'name', message: 'This value has the wrong type.' },
      ]);
    }
  });

  it('reports the indexed path of a bad event inside a batch', () => {
    try {
      parseOrThrow(LocationBatchRequestSchema, {
        deviceId: DEVICE_ID,
        uploadedAt: '2026-08-02T10:00:01.000Z',
        events: [locationEvent(), locationEvent({ latitude: 91.987654 })],
      });
      expect.unreachable('parseOrThrow should have thrown');
    } catch (error) {
      const appError = error as AppError;
      expect(appError.fields?.map((field) => field.path)).toContain('events[1].latitude');
    }
  });

  it('never echoes the offending value, so a coordinate cannot leak', () => {
    try {
      parseOrThrow(LocationBatchRequestSchema, {
        deviceId: DEVICE_ID,
        uploadedAt: '2026-08-02T10:00:01.000Z',
        events: [locationEvent({ latitude: 91.987654, longitude: -122.0841 })],
      });
      expect.unreachable('parseOrThrow should have thrown');
    } catch (error) {
      const appError = error as AppError;
      const messages = (appError.fields ?? []).map((field) => field.message).join(' ');

      expect(appError.message).not.toMatch(/\d/);
      expect(messages).not.toMatch(/\d/);
      expect(messages).not.toContain('91.987654');
      expect(messages).not.toContain('122.0841');
    }
  });

  it('does not echo an unrecognised key name into the message text', () => {
    try {
      parseOrThrow(LocationBatchRequestSchema, {
        deviceId: DEVICE_ID,
        uploadedAt: '2026-08-02T10:00:01.000Z',
        events: [locationEvent({ homeAddress: '1 Infinite Loop' })],
      });
      expect.unreachable('parseOrThrow should have thrown');
    } catch (error) {
      const appError = error as AppError;
      const messages = (appError.fields ?? []).map((field) => field.message).join(' ');

      expect(messages).not.toContain('Infinite Loop');
      expect(appError.fields?.map((field) => field.path)).toContain('events[0].homeAddress');
    }
  });
});
