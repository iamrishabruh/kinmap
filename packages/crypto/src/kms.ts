import {
  DecryptCommand,
  GenerateDataKeyCommand,
  KMSClient,
  type DecryptCommandOutput,
  type GenerateDataKeyCommandOutput,
  type KMSClientConfig,
} from '@aws-sdk/client-kms';

import type { EncryptionContext } from './encryption-context.js';
import { DATA_KEY_BYTES } from './types.js';

/**
 * The narrow slice of KMS this package needs. Depending on the interface rather
 * than on `KMSClient` keeps the encryption service unit-testable without network
 * access or credentials (see {@link ../in-memory-kms-stub.js}).
 */

export type DataKeyMaterial = {
  /** Plaintext AES-256 key. The caller owns it and must zeroise it after use. */
  plaintextKey: Buffer;
  /** KMS-wrapped key. Safe to persist next to the ciphertext. */
  encryptedDataKey: Buffer;
  /** Resolved CMK id/ARN, recorded for rotation and audit. */
  keyId: string;
};

export type GenerateDataKeyRequest = {
  encryptionContext: EncryptionContext;
};

export type DecryptDataKeyRequest = {
  encryptedDataKey: Buffer;
  encryptionContext: EncryptionContext;
};

export interface DataKeyProvider {
  generateDataKey(request: GenerateDataKeyRequest): Promise<DataKeyMaterial>;
  decryptDataKey(request: DecryptDataKeyRequest): Promise<DataKeyMaterial>;
}

export type DataKeyProviderFailure =
  /** KMS refused the wrapped key: wrong encryption context, wrong CMK, or corruption. */
  | 'INVALID_CIPHERTEXT'
  /** Throttling, network, credential, or key-state problem. Retryable. */
  | 'UNAVAILABLE'
  /** KMS answered, but not with a usable AES-256 key. */
  | 'INVALID_KEY_MATERIAL';

const DATA_KEY_PROVIDER_MESSAGES: Record<DataKeyProviderFailure, string> = {
  INVALID_CIPHERTEXT: 'The wrapped data key was rejected.',
  UNAVAILABLE: 'The key management service is unavailable.',
  INVALID_KEY_MATERIAL: 'The key management service returned unusable key material.',
};

/** Carries no coordinate, no plaintext, and no key bytes — only a reason code. */
export class DataKeyProviderError extends Error {
  constructor(readonly failure: DataKeyProviderFailure) {
    super(DATA_KEY_PROVIDER_MESSAGES[failure]);
    this.name = 'DataKeyProviderError';
  }
}

/**
 * KMS reports a wrong encryption context and a corrupted blob identically
 * (`InvalidCiphertextException`) precisely so that callers cannot probe key
 * policy. We preserve that behaviour rather than trying to distinguish them.
 */
const INVALID_CIPHERTEXT_ERROR_NAMES = new Set([
  'InvalidCiphertextException',
  'IncorrectKeyException',
  'KeyUnavailableException',
]);

function errorName(error: unknown): string {
  if (error instanceof Error) {
    return error.name !== '' && error.name !== 'Error' ? error.name : error.constructor.name;
  }
  return '';
}

export type AwsKmsDataKeyProviderOptions = {
  /** CMK id, alias, or ARN used to wrap coordinate data keys. */
  keyId: string;
  /** Pre-configured client (share one per Lambda container). */
  client?: KMSClient;
  /** Used only when `client` is omitted. */
  clientConfig?: KMSClientConfig;
};

export class AwsKmsDataKeyProvider implements DataKeyProvider {
  private readonly client: KMSClient;
  private readonly keyId: string;

  constructor(options: AwsKmsDataKeyProviderOptions) {
    if (options.keyId.trim() === '') {
      throw new RangeError('AwsKmsDataKeyProvider requires a KMS key id.');
    }
    this.keyId = options.keyId;
    this.client = options.client ?? new KMSClient(options.clientConfig ?? {});
  }

  async generateDataKey(request: GenerateDataKeyRequest): Promise<DataKeyMaterial> {
    let response: GenerateDataKeyCommandOutput;
    try {
      response = await this.client.send(
        new GenerateDataKeyCommand({
          KeyId: this.keyId,
          KeySpec: 'AES_256',
          EncryptionContext: { ...request.encryptionContext },
        }),
      );
    } catch (error) {
      throw new DataKeyProviderError(
        INVALID_CIPHERTEXT_ERROR_NAMES.has(errorName(error)) ? 'INVALID_CIPHERTEXT' : 'UNAVAILABLE',
      );
    }

    const plaintext = response.Plaintext;
    const wrapped = response.CiphertextBlob;
    if (plaintext === undefined || wrapped === undefined || response.KeyId === undefined) {
      throw new DataKeyProviderError('INVALID_KEY_MATERIAL');
    }
    const plaintextKey = Buffer.from(plaintext);
    if (plaintextKey.length !== DATA_KEY_BYTES) {
      plaintextKey.fill(0);
      throw new DataKeyProviderError('INVALID_KEY_MATERIAL');
    }
    return {
      plaintextKey,
      encryptedDataKey: Buffer.from(wrapped),
      keyId: response.KeyId,
    };
  }

  async decryptDataKey(request: DecryptDataKeyRequest): Promise<DataKeyMaterial> {
    let response: DecryptCommandOutput;
    try {
      response = await this.client.send(
        new DecryptCommand({
          CiphertextBlob: request.encryptedDataKey,
          EncryptionContext: { ...request.encryptionContext },
          KeyId: this.keyId,
          EncryptionAlgorithm: 'SYMMETRIC_DEFAULT',
        }),
      );
    } catch (error) {
      throw new DataKeyProviderError(
        INVALID_CIPHERTEXT_ERROR_NAMES.has(errorName(error)) ? 'INVALID_CIPHERTEXT' : 'UNAVAILABLE',
      );
    }

    const plaintext = response.Plaintext;
    if (plaintext === undefined || response.KeyId === undefined) {
      throw new DataKeyProviderError('INVALID_KEY_MATERIAL');
    }
    const plaintextKey = Buffer.from(plaintext);
    if (plaintextKey.length !== DATA_KEY_BYTES) {
      plaintextKey.fill(0);
      throw new DataKeyProviderError('INVALID_KEY_MATERIAL');
    }
    return {
      plaintextKey,
      encryptedDataKey: Buffer.from(request.encryptedDataKey),
      keyId: response.KeyId,
    };
  }
}
