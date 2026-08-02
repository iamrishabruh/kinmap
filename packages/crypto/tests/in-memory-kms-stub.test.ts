import { describe, expect, it } from 'vitest';

import {
  DataKeyProviderError,
  InMemoryKmsStub,
  buildEncryptionContext,
  canonicalizeEncryptionContext,
  encryptionContextsMatch,
} from '../src/index.js';

const FAMILY = '88888888-8888-4888-8888-888888888888';
const OTHER_FAMILY = '99999999-9999-4999-8999-999999999999';
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('encryption context', () => {
  it('is order independent', () => {
    const a = { familyId: FAMILY, purpose: 'p', schemaVersion: '1' };
    const b = { schemaVersion: '1', purpose: 'p', familyId: FAMILY };
    expect(canonicalizeEncryptionContext(a)).toBe(canonicalizeEncryptionContext(b));
    expect(encryptionContextsMatch(a, b)).toBe(true);
  });

  it('separates a family-wide key from a per-member key', () => {
    const familyOnly = buildEncryptionContext({ familyId: FAMILY });
    const withUser = buildEncryptionContext({ familyId: FAMILY, userId: USER });

    expect(familyOnly.userId).toBeUndefined();
    expect(withUser.userId).toBe(USER);
    expect(encryptionContextsMatch(familyOnly, withUser)).toBe(false);
  });

  it('distinguishes families', () => {
    expect(
      encryptionContextsMatch(
        buildEncryptionContext({ familyId: FAMILY }),
        buildEncryptionContext({ familyId: OTHER_FAMILY }),
      ),
    ).toBe(false);
  });

  it('pins the purpose so a coordinate key is not reusable elsewhere', () => {
    expect(buildEncryptionContext({ familyId: FAMILY }).purpose).toBe('family-location:coordinate');
  });
});

describe('InMemoryKmsStub', () => {
  it('mints a distinct AES-256 key per call', async () => {
    const kms = new InMemoryKmsStub();
    const context = buildEncryptionContext({ familyId: FAMILY });

    const first = await kms.generateDataKey({ encryptionContext: context });
    const second = await kms.generateDataKey({ encryptionContext: context });

    expect(first.plaintextKey).toHaveLength(32);
    expect(first.plaintextKey.equals(second.plaintextKey)).toBe(false);
    expect(first.encryptedDataKey.equals(second.encryptedDataKey)).toBe(false);
    expect(kms.calls.generateDataKey).toBe(2);
  });

  it('never exposes the plaintext key inside the wrapped blob', async () => {
    const kms = new InMemoryKmsStub();
    const material = await kms.generateDataKey({
      encryptionContext: buildEncryptionContext({ familyId: FAMILY }),
    });

    expect(material.encryptedDataKey.includes(material.plaintextKey)).toBe(false);
  });

  it('unwraps only under the original context', async () => {
    const kms = new InMemoryKmsStub();
    const context = buildEncryptionContext({ familyId: FAMILY, userId: USER });
    const material = await kms.generateDataKey({ encryptionContext: context });

    const unwrapped = await kms.decryptDataKey({
      encryptedDataKey: material.encryptedDataKey,
      encryptionContext: context,
    });
    expect(unwrapped.plaintextKey.equals(material.plaintextKey)).toBe(true);

    await expect(
      kms.decryptDataKey({
        encryptedDataKey: material.encryptedDataKey,
        encryptionContext: buildEncryptionContext({ familyId: OTHER_FAMILY, userId: USER }),
      }),
    ).rejects.toBeInstanceOf(DataKeyProviderError);
  });

  it('rejects a tampered blob the same way it rejects a wrong context', async () => {
    const kms = new InMemoryKmsStub();
    const context = buildEncryptionContext({ familyId: FAMILY });
    const material = await kms.generateDataKey({ encryptionContext: context });

    const tampered = Buffer.from(material.encryptedDataKey);
    const last = tampered.length - 1;
    tampered[last] = (tampered[last] ?? 0) ^ 0xff;

    const wrongContext = await kms
      .decryptDataKey({
        encryptedDataKey: material.encryptedDataKey,
        encryptionContext: buildEncryptionContext({ familyId: OTHER_FAMILY }),
      })
      .catch((error: unknown) => error);
    const corrupted = await kms
      .decryptDataKey({ encryptedDataKey: tampered, encryptionContext: context })
      .catch((error: unknown) => error);

    expect(wrongContext).toBeInstanceOf(DataKeyProviderError);
    expect(corrupted).toBeInstanceOf(DataKeyProviderError);
    expect((wrongContext as DataKeyProviderError).failure).toBe('INVALID_CIPHERTEXT');
    expect((corrupted as DataKeyProviderError).failure).toBe('INVALID_CIPHERTEXT');
    expect((wrongContext as DataKeyProviderError).message).toBe(
      (corrupted as DataKeyProviderError).message,
    );
  });

  it('rejects a blob it did not produce', async () => {
    const kms = new InMemoryKmsStub();
    await expect(
      kms.decryptDataKey({
        encryptedDataKey: Buffer.alloc(8),
        encryptionContext: buildEncryptionContext({ familyId: FAMILY }),
      }),
    ).rejects.toMatchObject({ failure: 'INVALID_CIPHERTEXT' });
  });

  it('simulates an unavailable key service', async () => {
    const kms = new InMemoryKmsStub();
    kms.simulateUnavailable = true;

    await expect(
      kms.generateDataKey({ encryptionContext: buildEncryptionContext({ familyId: FAMILY }) }),
    ).rejects.toMatchObject({ failure: 'UNAVAILABLE' });
  });
});
