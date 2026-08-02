import * as SecureStore from 'expo-secure-store';

import { LocationFeatureError } from '../errors';
import { fromBase64, toBase64 } from '../internal/bytes';

import { randomBytes } from './digest';

/**
 * Custody of the key that protects the local SQLite database, and of the
 * per-device key the backend uses to sign remote configuration.
 *
 * Both live in the platform keystore (iOS Keychain / Android Keystore) via
 * `expo-secure-store`, never in SQLite, `AsyncStorage`, or a bundled constant.
 * `WHEN_UNLOCKED_THIS_DEVICE_ONLY` keeps them off iCloud/Android backups: a key
 * restored onto a different handset would let a restored backup be decrypted on
 * a device the user never consented from.
 */

const LOCAL_STORE_KEY_ALIAS = 'familylocation.localStoreKey.v1';
const CONFIG_SIGNING_KEY_ALIAS = 'familylocation.remoteConfigSigningKey.v1';
const CONFIG_SIGNING_KEY_ID_ALIAS = 'familylocation.remoteConfigSigningKeyId.v1';

const MASTER_KEY_BYTES = 32;

const SECURE_STORE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

/**
 * Reads the local-storage master key, generating one on first launch.
 *
 * @throws LocationFeatureError ENCRYPTION_KEY_UNAVAILABLE when the keystore is
 * unreadable. Callers must treat that as "do not persist anything" rather than
 * falling back to plaintext.
 */
export async function loadOrCreateLocalStoreKey(): Promise<Uint8Array> {
  let existing: string | null;
  try {
    existing = await SecureStore.getItemAsync(LOCAL_STORE_KEY_ALIAS, SECURE_STORE_OPTIONS);
  } catch {
    throw new LocationFeatureError('ENCRYPTION_KEY_UNAVAILABLE', 'read');
  }

  if (existing) {
    try {
      const decoded = fromBase64(existing);
      if (decoded.length >= MASTER_KEY_BYTES) {
        return decoded;
      }
    } catch {
      // Fall through and re-key: a truncated value is unusable either way.
    }
  }

  const generated = randomBytes(MASTER_KEY_BYTES);
  try {
    await SecureStore.setItemAsync(
      LOCAL_STORE_KEY_ALIAS,
      toBase64(generated),
      SECURE_STORE_OPTIONS,
    );
  } catch {
    throw new LocationFeatureError('ENCRYPTION_KEY_UNAVAILABLE', 'write');
  }
  return generated;
}

/**
 * Crypto-shredding used on sign-out and account deletion.
 *
 * The SQLite file is dropped separately, but destroying the key first means
 * that any page the filesystem has not yet reclaimed is already unreadable.
 */
export async function destroyLocalStoreKey(): Promise<void> {
  await SecureStore.deleteItemAsync(LOCAL_STORE_KEY_ALIAS, SECURE_STORE_OPTIONS);
}

export type DeviceConfigSigningKey = {
  keyId: string;
  key: Uint8Array;
};

/**
 * The key the backend issues to this device (over TLS, at device registration)
 * and then uses to sign remote configuration.
 *
 * It is per-device on purpose. A single signing secret compiled into the binary
 * would be extractable from any handset and would let an attacker forge
 * configuration for every user.
 */
export async function loadDeviceConfigSigningKey(): Promise<DeviceConfigSigningKey | null> {
  const [encodedKey, keyId] = await Promise.all([
    SecureStore.getItemAsync(CONFIG_SIGNING_KEY_ALIAS, SECURE_STORE_OPTIONS),
    SecureStore.getItemAsync(CONFIG_SIGNING_KEY_ID_ALIAS, SECURE_STORE_OPTIONS),
  ]);
  if (!encodedKey || !keyId) {
    return null;
  }
  try {
    return { keyId, key: fromBase64(encodedKey) };
  } catch {
    return null;
  }
}

export async function storeDeviceConfigSigningKey(input: {
  keyId: string;
  keyBase64: string;
}): Promise<void> {
  await Promise.all([
    SecureStore.setItemAsync(CONFIG_SIGNING_KEY_ALIAS, input.keyBase64, SECURE_STORE_OPTIONS),
    SecureStore.setItemAsync(CONFIG_SIGNING_KEY_ID_ALIAS, input.keyId, SECURE_STORE_OPTIONS),
  ]);
}

export async function destroyDeviceConfigSigningKey(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(CONFIG_SIGNING_KEY_ALIAS, SECURE_STORE_OPTIONS),
    SecureStore.deleteItemAsync(CONFIG_SIGNING_KEY_ID_ALIAS, SECURE_STORE_OPTIONS),
  ]);
}
