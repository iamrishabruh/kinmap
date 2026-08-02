import { inspect } from 'node:util';

import { describe, expect, it } from 'vitest';

import {
  CRYPTO_FAILURE_MESSAGES,
  CoordinateCryptoError,
  EncryptionService,
  InMemoryKmsStub,
  decodeCoordinates,
  encodeCoordinates,
  type Coordinates,
  type EncryptedCoordinateRecord,
  type KeyContext,
} from '../src/index.js';

/**
 * Spec §20: a coordinate must never reach a log, a metric, a trace, or an error
 * message. These tests exercise every failure path the package has and assert
 * the thrown value is inert — message, stack, own properties, JSON form, and
 * deep inspection are all searched.
 */

const FAMILY = '55555555-5555-4555-8555-555555555555';
const OTHER_FAMILY = '66666666-6666-4666-8666-666666666666';
const USER = '77777777-7777-4777-8777-777777777777';

/** Digits chosen so any partial formatting of the value is still detectable. */
const SECRET: Coordinates = { lat: 12.3456789, lng: -98.7654321 };

/**
 * Four or more decimal places is roughly 11 m — far finer than the coarse grid
 * the privacy rules allow — so any of these appearing anywhere near an error is
 * a leak.
 */
const FORBIDDEN_FRAGMENTS = [
  '12.3456789',
  '-98.7654321',
  '98.7654321',
  '12.345678',
  '98.765432',
  '3456789',
  '7654321',
  '12.3456',
  '98.7654',
];

function surfaceOf(error: unknown): string {
  const parts: string[] = [inspect(error, { depth: 10, showHidden: true, getters: true })];
  if (error instanceof Error) {
    parts.push(error.message, error.name, error.stack ?? '', String(error));
    parts.push(JSON.stringify(error, Object.getOwnPropertyNames(error)));
    let prototype: object | null = Object.getPrototypeOf(error) as object | null;
    while (prototype !== null && prototype !== Object.prototype) {
      parts.push(Object.getOwnPropertyNames(prototype).join(','));
      prototype = Object.getPrototypeOf(prototype) as object | null;
    }
  } else {
    parts.push(String(error));
  }
  return parts.join('\n');
}

function expectInert(error: unknown): void {
  const surface = surfaceOf(error);
  for (const fragment of FORBIDDEN_FRAGMENTS) {
    expect(surface).not.toContain(fragment);
  }
  // The raw little-endian payload must not have escaped either.
  const payload = encodeCoordinates(SECRET);
  expect(surface).not.toContain(payload.toString('base64'));
  expect(surface).not.toContain(payload.toString('hex'));
}

async function captureRejection(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  throw new Error('expected the operation to reject');
}

describe('errors never carry plaintext coordinates', () => {
  const context: KeyContext = { familyId: FAMILY, userId: USER };

  async function seal(): Promise<{
    service: EncryptionService;
    kms: InMemoryKmsStub;
    record: EncryptedCoordinateRecord;
  }> {
    const kms = new InMemoryKmsStub();
    const service = new EncryptionService({ keyProvider: kms });
    const record = await service.encryptCoordinates(SECRET, context);
    return { service, kms, record };
  }

  it('invalid coordinates', async () => {
    const kms = new InMemoryKmsStub();
    const service = new EncryptionService({ keyProvider: kms });
    const error = await captureRejection(
      service.encryptCoordinates({ lat: 912.3456789, lng: -98.7654321 }, context),
    );
    expect(error).toBeInstanceOf(CoordinateCryptoError);
    const surface = surfaceOf(error);
    expect(surface).not.toContain('912.3456789');
    expect(surface).not.toContain('98.7654321');
  });

  it('invalid key context', async () => {
    const kms = new InMemoryKmsStub();
    const service = new EncryptionService({ keyProvider: kms });
    expectInert(
      await captureRejection(
        service.encryptCoordinates(SECRET, { familyId: 'nope' } as KeyContext),
      ),
    );
  });

  it('key provider unavailable', async () => {
    const kms = new InMemoryKmsStub();
    kms.simulateUnavailable = true;
    const service = new EncryptionService({ keyProvider: kms });
    expectInert(await captureRejection(service.encryptCoordinates(SECRET, context)));
  });

  it('wrong encryption context on read', async () => {
    const { service, record } = await seal();
    expectInert(
      await captureRejection(service.decryptCoordinates(record, { familyId: OTHER_FAMILY })),
    );
  });

  it('tampered ciphertext on read', async () => {
    const { service, record } = await seal();
    const bytes = Buffer.from(record.ciphertext, 'base64');
    const first = bytes[0] ?? 0;
    bytes[0] = first ^ 0xff;
    expectInert(
      await captureRejection(
        service.decryptCoordinates({ ...record, ciphertext: bytes.toString('base64') }, context),
      ),
    );
  });

  it('malformed record on read', async () => {
    const { service, record } = await seal();
    expectInert(
      await captureRejection(
        service.decryptCoordinates(
          { ...record, authTag: '###' } as EncryptedCoordinateRecord,
          context,
        ),
      ),
    );
  });

  it('corrupted payload decode', () => {
    let thrown: unknown;
    try {
      decodeCoordinates(Buffer.alloc(4));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CoordinateCryptoError);
    expectInert(thrown);
  });

  it('every declared failure message is a fixed, value-free string', () => {
    for (const [reason, message] of Object.entries(CRYPTO_FAILURE_MESSAGES)) {
      const error = new CoordinateCryptoError(reason as CoordinateCryptoError['reason']);
      expect(error.message).toBe(message);
      expect(error.message).not.toMatch(/-?\d+\.\d+/);
      expectInert(error);
    }
  });

  it('a successful envelope contains no recoverable plaintext', async () => {
    const { record } = await seal();
    const serialised = JSON.stringify(record);
    for (const fragment of FORBIDDEN_FRAGMENTS) {
      expect(serialised).not.toContain(fragment);
    }
    expect(Buffer.from(record.ciphertext, 'base64').toString('hex')).not.toBe(
      encodeCoordinates(SECRET).toString('hex'),
    );
  });
});
