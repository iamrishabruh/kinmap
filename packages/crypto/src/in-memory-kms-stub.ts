import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { canonicalizeEncryptionContext } from './encryption-context.js';
import {
  DataKeyProviderError,
  type DataKeyMaterial,
  type DataKeyProvider,
  type DecryptDataKeyRequest,
  type GenerateDataKeyRequest,
} from './kms.js';
import { AUTH_TAG_BYTES, DATA_KEY_BYTES, IV_BYTES, NODE_CIPHER_ALGORITHM } from './types.js';

/**
 * Deterministic, offline stand-in for AWS KMS.
 *
 * It reproduces the two behaviours the service actually depends on:
 *  1. the wrapped key is opaque and only unwrappable with the *same* encryption
 *     context, and
 *  2. a wrong context and a corrupt blob are indistinguishable to the caller.
 *
 * Test-only: the "CMK" is a random buffer held in this object, so nothing about
 * it is durable or shareable.
 */

const STUB_BLOB_VERSION = 0x01;
const STUB_BLOB_HEADER_BYTES = 1 + IV_BYTES + AUTH_TAG_BYTES;

export const STUB_KMS_KEY_ID =
  'arn:aws:kms:us-east-1:000000000000:key/00000000-0000-4000-8000-000000000000';

export type InMemoryKmsStubOptions = {
  keyId?: string;
};

export type InMemoryKmsCallCounts = {
  generateDataKey: number;
  decryptDataKey: number;
};

export class InMemoryKmsStub implements DataKeyProvider {
  readonly keyId: string;

  /**
   * Flip to true to exercise the retryable-upstream path without touching the
   * network.
   */
  simulateUnavailable = false;

  private readonly masterKey = randomBytes(DATA_KEY_BYTES);
  private generateCalls = 0;
  private decryptCalls = 0;

  constructor(options: InMemoryKmsStubOptions = {}) {
    this.keyId = options.keyId ?? STUB_KMS_KEY_ID;
  }

  get calls(): InMemoryKmsCallCounts {
    return { generateDataKey: this.generateCalls, decryptDataKey: this.decryptCalls };
  }

  resetCalls(): void {
    this.generateCalls = 0;
    this.decryptCalls = 0;
  }

  generateDataKey(request: GenerateDataKeyRequest): Promise<DataKeyMaterial> {
    this.generateCalls += 1;
    if (this.simulateUnavailable) {
      return Promise.reject(new DataKeyProviderError('UNAVAILABLE'));
    }

    const plaintextKey = randomBytes(DATA_KEY_BYTES);
    const aad = Buffer.from(canonicalizeEncryptionContext(request.encryptionContext), 'utf8');
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(NODE_CIPHER_ALGORITHM, this.masterKey, iv);
    cipher.setAAD(aad);
    const wrapped = Buffer.concat([cipher.update(plaintextKey), cipher.final()]);
    const encryptedDataKey = Buffer.concat([
      Buffer.from([STUB_BLOB_VERSION]),
      iv,
      cipher.getAuthTag(),
      wrapped,
    ]);

    return Promise.resolve({ plaintextKey, encryptedDataKey, keyId: this.keyId });
  }

  decryptDataKey(request: DecryptDataKeyRequest): Promise<DataKeyMaterial> {
    this.decryptCalls += 1;
    if (this.simulateUnavailable) {
      return Promise.reject(new DataKeyProviderError('UNAVAILABLE'));
    }

    const blob = request.encryptedDataKey;
    if (blob.length <= STUB_BLOB_HEADER_BYTES || blob[0] !== STUB_BLOB_VERSION) {
      return Promise.reject(new DataKeyProviderError('INVALID_CIPHERTEXT'));
    }

    const iv = blob.subarray(1, 1 + IV_BYTES);
    const authTag = blob.subarray(1 + IV_BYTES, STUB_BLOB_HEADER_BYTES);
    const wrapped = blob.subarray(STUB_BLOB_HEADER_BYTES);
    const aad = Buffer.from(canonicalizeEncryptionContext(request.encryptionContext), 'utf8');

    let plaintextKey: Buffer;
    try {
      const decipher = createDecipheriv(NODE_CIPHER_ALGORITHM, this.masterKey, iv);
      decipher.setAAD(aad);
      decipher.setAuthTag(authTag);
      plaintextKey = Buffer.concat([decipher.update(wrapped), decipher.final()]);
    } catch {
      // Mirrors KMS: a mismatched encryption context and a tampered blob are
      // reported identically.
      return Promise.reject(new DataKeyProviderError('INVALID_CIPHERTEXT'));
    }

    if (plaintextKey.length !== DATA_KEY_BYTES) {
      plaintextKey.fill(0);
      return Promise.reject(new DataKeyProviderError('INVALID_KEY_MATERIAL'));
    }

    return Promise.resolve({
      plaintextKey,
      encryptedDataKey: Buffer.from(blob),
      keyId: this.keyId,
    });
  }
}
