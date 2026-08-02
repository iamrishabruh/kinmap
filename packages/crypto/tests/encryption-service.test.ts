import { describe, expect, it } from 'vitest';

import {
  CoordinateCryptoError,
  DataKeyCache,
  EncryptionService,
  InMemoryKmsStub,
  type Coordinates,
  type EncryptedCoordinateRecord,
  type KeyContext,
} from '../src/index.js';

const FAMILY_A = '11111111-1111-4111-8111-111111111111';
const FAMILY_B = '22222222-2222-4222-8222-222222222222';
const USER_A = '33333333-3333-4333-8333-333333333333';
const USER_B = '44444444-4444-4444-8444-444444444444';

function newService(overrides: { now?: () => number; ttlMs?: number } = {}): {
  service: EncryptionService;
  kms: InMemoryKmsStub;
} {
  const kms = new InMemoryKmsStub();
  const service = new EncryptionService({
    keyProvider: kms,
    ...(overrides.now !== undefined ? { now: overrides.now } : {}),
    ...(overrides.ttlMs !== undefined ? { dataKeyTtlMs: overrides.ttlMs } : {}),
  });
  return { service, kms };
}

/** Re-encodes after flipping one raw byte so the field stays canonical base64. */
function flipByte(base64Value: string, index: number): string {
  const bytes = Buffer.from(base64Value, 'base64');
  const current = bytes[index];
  if (current === undefined) {
    throw new Error('test set-up error: index out of range');
  }
  bytes[index] = current ^ 0b0000_0001;
  return bytes.toString('base64');
}

describe('EncryptionService round trip', () => {
  const context: KeyContext = { familyId: FAMILY_A, userId: USER_A };

  const cases: ReadonlyArray<{ name: string; coordinates: Coordinates }> = [
    { name: 'seven decimal places', coordinates: { lat: 37.4219983, lng: -122.084 } },
    { name: 'seven decimals both axes', coordinates: { lat: 12.3456789, lng: -98.7654321 } },
    { name: 'null island', coordinates: { lat: 0, lng: 0 } },
    { name: 'south-west extreme', coordinates: { lat: -90, lng: -180 } },
    { name: 'north-east extreme', coordinates: { lat: 90, lng: 180 } },
    { name: 'sub-metre precision', coordinates: { lat: 51.5073509, lng: -0.1277583 } },
    { name: 'near-zero negatives', coordinates: { lat: -0.0000001, lng: 0.0000001 } },
  ];

  for (const { name, coordinates } of cases) {
    it(`preserves ${name} bit-exactly`, async () => {
      const { service } = newService();
      const record = await service.encryptCoordinates(coordinates, context);
      const decrypted = await service.decryptCoordinates(record, context);

      expect(decrypted.lat).toBe(coordinates.lat);
      expect(decrypted.lng).toBe(coordinates.lng);
      expect(decrypted.lat.toFixed(7)).toBe(coordinates.lat.toFixed(7));
      expect(decrypted.lng.toFixed(7)).toBe(coordinates.lng.toFixed(7));
      // ~1.1 cm at the equator: the 7th decimal place must survive.
      expect(Math.abs(decrypted.lat - coordinates.lat)).toBeLessThan(1e-9);
      expect(Math.abs(decrypted.lng - coordinates.lng)).toBeLessThan(1e-9);
    });
  }

  it('round-trips through a cold service, proving nothing depends on cache state', async () => {
    const kms = new InMemoryKmsStub();
    const writer = new EncryptionService({ keyProvider: kms });
    const reader = new EncryptionService({ keyProvider: kms });

    const record = await writer.encryptCoordinates({ lat: 48.8583701, lng: 2.2944813 }, context);
    const decrypted = await reader.decryptCoordinates(record, context);

    expect(decrypted).toEqual({ lat: 48.8583701, lng: 2.2944813 });
  });

  it('emits a well-formed envelope and never the plaintext', async () => {
    const { service } = newService();
    const record = await service.encryptCoordinates({ lat: 12.3456789, lng: -98.7654321 }, context);

    expect(record.algorithm).toBe('AES-256-GCM');
    expect(record.schemaVersion).toBe(1);
    expect(record.keyId).toMatch(/^arn:aws:kms:/);
    expect(Buffer.from(record.iv, 'base64')).toHaveLength(12);
    expect(Buffer.from(record.authTag, 'base64')).toHaveLength(16);
    // 16-byte payload, GCM is a stream cipher: ciphertext is exactly 16 bytes.
    expect(Buffer.from(record.ciphertext, 'base64')).toHaveLength(16);

    const serialised = JSON.stringify(record);
    expect(serialised).not.toContain('12.345');
    expect(serialised).not.toContain('98.765');
  });

  it('produces a distinct IV and ciphertext for identical coordinates', async () => {
    const { service } = newService();
    const first = await service.encryptCoordinates({ lat: 1.2345678, lng: 2.3456789 }, context);
    const second = await service.encryptCoordinates({ lat: 1.2345678, lng: 2.3456789 }, context);

    expect(first.iv).not.toBe(second.iv);
    expect(first.ciphertext).not.toBe(second.ciphertext);
    // Same context inside the TTL: the data key is reused, not re-minted.
    expect(first.encryptedDataKey).toBe(second.encryptedDataKey);
  });
});

describe('tamper detection', () => {
  const context: KeyContext = { familyId: FAMILY_A, userId: USER_A };
  const coordinates: Coordinates = { lat: 40.7127753, lng: -74.0059728 };

  async function sealed(): Promise<{
    service: EncryptionService;
    record: EncryptedCoordinateRecord;
  }> {
    const { service } = newService();
    const record = await service.encryptCoordinates(coordinates, context);
    return { service, record };
  }

  it('rejects a flipped auth-tag byte', async () => {
    const { service, record } = await sealed();
    const tampered = { ...record, authTag: flipByte(record.authTag, 0) };

    await expect(service.decryptCoordinates(tampered, context)).rejects.toMatchObject({
      name: 'CoordinateCryptoError',
      reason: 'INTEGRITY_CHECK_FAILED',
    });
  });

  it('rejects a flipped ciphertext byte', async () => {
    const { service, record } = await sealed();
    const tampered = { ...record, ciphertext: flipByte(record.ciphertext, 3) };

    await expect(service.decryptCoordinates(tampered, context)).rejects.toMatchObject({
      reason: 'INTEGRITY_CHECK_FAILED',
    });
  });

  it('rejects a flipped IV byte', async () => {
    const { service, record } = await sealed();
    const tampered = { ...record, iv: flipByte(record.iv, 5) };

    await expect(service.decryptCoordinates(tampered, context)).rejects.toMatchObject({
      reason: 'INTEGRITY_CHECK_FAILED',
    });
  });

  it('rejects a tampered wrapped data key', async () => {
    const { service, record } = await sealed();
    const tampered = {
      ...record,
      encryptedDataKey: flipByte(record.encryptedDataKey, 20),
    };

    await expect(service.decryptCoordinates(tampered, context)).rejects.toBeInstanceOf(
      CoordinateCryptoError,
    );
  });

  it('rejects a truncated ciphertext', async () => {
    const { service, record } = await sealed();
    const bytes = Buffer.from(record.ciphertext, 'base64').subarray(0, 8);
    const tampered = { ...record, ciphertext: bytes.toString('base64') };

    await expect(service.decryptCoordinates(tampered, context)).rejects.toMatchObject({
      reason: 'INTEGRITY_CHECK_FAILED',
    });
  });

  it('rejects a structurally invalid record', async () => {
    const { service, record } = await sealed();
    const tampered = { ...record, iv: 'not-base64!!' } as EncryptedCoordinateRecord;

    await expect(service.decryptCoordinates(tampered, context)).rejects.toMatchObject({
      reason: 'MALFORMED_RECORD',
    });
  });

  it('rejects an unknown schema version', async () => {
    const { service, record } = await sealed();
    const tampered = { ...record, schemaVersion: 99 };

    await expect(service.decryptCoordinates(tampered, context)).rejects.toMatchObject({
      reason: 'UNSUPPORTED_SCHEMA_VERSION',
    });
  });
});

describe('encryption context binding', () => {
  const coordinates: Coordinates = { lat: 35.6811673, lng: 139.7670516 };

  it('refuses to decrypt under a different family', async () => {
    const { service } = newService();
    const record = await service.encryptCoordinates(coordinates, { familyId: FAMILY_A });

    await expect(service.decryptCoordinates(record, { familyId: FAMILY_B })).rejects.toMatchObject({
      reason: 'ENCRYPTION_CONTEXT_MISMATCH',
    });
  });

  it('refuses to decrypt under a different user in the same family', async () => {
    const { service } = newService();
    const record = await service.encryptCoordinates(coordinates, {
      familyId: FAMILY_A,
      userId: USER_A,
    });

    await expect(
      service.decryptCoordinates(record, { familyId: FAMILY_A, userId: USER_B }),
    ).rejects.toMatchObject({ reason: 'ENCRYPTION_CONTEXT_MISMATCH' });
  });

  it('refuses to decrypt when the user binding is dropped', async () => {
    const { service } = newService();
    const record = await service.encryptCoordinates(coordinates, {
      familyId: FAMILY_A,
      userId: USER_A,
    });

    await expect(service.decryptCoordinates(record, { familyId: FAMILY_A })).rejects.toMatchObject({
      reason: 'ENCRYPTION_CONTEXT_MISMATCH',
    });
  });

  it('refuses to decrypt when a user binding is added', async () => {
    const { service } = newService();
    const record = await service.encryptCoordinates(coordinates, { familyId: FAMILY_A });

    await expect(
      service.decryptCoordinates(record, { familyId: FAMILY_A, userId: USER_A }),
    ).rejects.toMatchObject({ reason: 'ENCRYPTION_CONTEXT_MISMATCH' });
  });

  it('cannot be bypassed by replaying another family cached data key', async () => {
    const kms = new InMemoryKmsStub();
    const service = new EncryptionService({ keyProvider: kms });

    // Warm both contexts so both data keys are live in the cache.
    const recordA = await service.encryptCoordinates(coordinates, { familyId: FAMILY_A });
    await service.encryptCoordinates(coordinates, { familyId: FAMILY_B });

    await expect(service.decryptCoordinates(recordA, { familyId: FAMILY_B })).rejects.toMatchObject(
      { reason: 'ENCRYPTION_CONTEXT_MISMATCH' },
    );
  });

  it('rejects a key context that is not a valid identifier pair', async () => {
    const { service } = newService();

    await expect(
      service.encryptCoordinates(coordinates, { familyId: 'not-a-uuid' } as KeyContext),
    ).rejects.toMatchObject({ reason: 'INVALID_KEY_CONTEXT' });
  });
});

describe('data key lifecycle', () => {
  const context: KeyContext = { familyId: FAMILY_A };

  it('reuses one data key across calls inside the TTL', async () => {
    const { service, kms } = newService();

    for (let index = 0; index < 5; index += 1) {
      await service.encryptCoordinates({ lat: index / 10, lng: index / 10 }, context);
    }

    expect(kms.calls.generateDataKey).toBe(1);
  });

  it('mints a fresh data key once the TTL elapses', async () => {
    let clock = 1_000;
    const { service, kms } = newService({ now: () => clock, ttlMs: 60_000 });

    await service.encryptCoordinates({ lat: 1, lng: 1 }, context);
    clock += 59_000;
    await service.encryptCoordinates({ lat: 1, lng: 1 }, context);
    expect(kms.calls.generateDataKey).toBe(1);

    clock += 2_000;
    await service.encryptCoordinates({ lat: 1, lng: 1 }, context);
    expect(kms.calls.generateDataKey).toBe(2);
  });

  it('caches unwrapped keys so repeat reads do not hammer KMS', async () => {
    const { service, kms } = newService();
    const record = await service.encryptCoordinates({ lat: 5.5, lng: 6.6 }, context);

    await service.decryptCoordinates(record, context);
    await service.decryptCoordinates(record, context);
    await service.decryptCoordinates(record, context);

    expect(kms.calls.decryptDataKey).toBe(1);
  });

  it('clearKeyCache forces a fresh unwrap', async () => {
    const { service, kms } = newService();
    const record = await service.encryptCoordinates({ lat: 5.5, lng: 6.6 }, context);
    await service.decryptCoordinates(record, context);

    service.clearKeyCache();
    await service.decryptCoordinates(record, context);

    expect(kms.calls.decryptDataKey).toBe(2);
  });

  it('surfaces a retryable failure when KMS is unavailable', async () => {
    const kms = new InMemoryKmsStub();
    kms.simulateUnavailable = true;
    const service = new EncryptionService({ keyProvider: kms });

    await expect(service.encryptCoordinates({ lat: 1.1, lng: 2.2 }, context)).rejects.toMatchObject(
      { reason: 'DATA_KEY_UNAVAILABLE', code: 'UPSTREAM_UNAVAILABLE' },
    );
  });

  it('honours an injected shared cache', async () => {
    const kms = new InMemoryKmsStub();
    const shared = new DataKeyCache({ maxEntries: 4, ttlMs: 60_000 });
    const first = new EncryptionService({ keyProvider: kms, encryptionKeyCache: shared });
    const second = new EncryptionService({ keyProvider: kms, encryptionKeyCache: shared });

    await first.encryptCoordinates({ lat: 1, lng: 1 }, context);
    await second.encryptCoordinates({ lat: 2, lng: 2 }, context);

    expect(kms.calls.generateDataKey).toBe(1);
  });
});

describe('coordinate validation', () => {
  const context: KeyContext = { familyId: FAMILY_A };

  const invalid: ReadonlyArray<{ name: string; value: unknown }> = [
    { name: 'latitude above range', value: { lat: 90.0001, lng: 0 } },
    { name: 'longitude below range', value: { lat: 0, lng: -180.0001 } },
    { name: 'NaN latitude', value: { lat: Number.NaN, lng: 0 } },
    { name: 'infinite longitude', value: { lat: 0, lng: Number.POSITIVE_INFINITY } },
    { name: 'missing longitude', value: { lat: 10 } },
    { name: 'string coordinates', value: { lat: '10', lng: '20' } },
  ];

  for (const { name, value } of invalid) {
    it(`rejects ${name}`, async () => {
      const { service } = newService();
      await expect(service.encryptCoordinates(value as Coordinates, context)).rejects.toMatchObject(
        { reason: 'INVALID_COORDINATES', code: 'VALIDATION_FAILED' },
      );
    });
  }
});
