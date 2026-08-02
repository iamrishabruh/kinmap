import * as SecureStore from 'expo-secure-store';

import { StoredSessionSchema, type StoredSession } from './types';

/**
 * Credential storage.
 *
 * Tokens live in the iOS keychain / Android keystore and nowhere else. They are
 * never written to AsyncStorage, never persisted into the React Query cache,
 * never placed in a route parameter, and never included in a log line, a
 * breadcrumb or a crash report.
 *
 * `WHEN_UNLOCKED_THIS_DEVICE_ONLY` is chosen over the syncing accessibility
 * classes on purpose: a refresh token that rides an encrypted backup to a new
 * handset is a session this user never granted on that device.
 */

const KEYCHAIN_SERVICE = 'family-location.auth';

/**
 * Access and refresh tokens get their own entries. `OpaqueTokenSchema` allows
 * up to 4096 characters, and Android's keystore-backed store warns past ~2 KB
 * per value, so a single JSON blob holding both would sit right on that limit.
 */
const KEYS = {
  accessToken: 'family.auth.accessToken',
  refreshToken: 'family.auth.refreshToken',
  /** Non-secret envelope: user id and expiries. Kept beside the tokens. */
  meta: 'family.auth.meta',
} as const;

const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainService: KEYCHAIN_SERVICE,
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

type StoredMeta = Pick<StoredSession, 'userId' | 'accessTokenExpiresAt' | 'refreshTokenExpiresAt'>;

export async function isSecureStorageAvailable(): Promise<boolean> {
  try {
    return await SecureStore.isAvailableAsync();
  } catch {
    return false;
  }
}

export async function saveStoredSession(session: StoredSession): Promise<void> {
  const meta: StoredMeta = {
    userId: session.userId,
    accessTokenExpiresAt: session.accessTokenExpiresAt,
    refreshTokenExpiresAt: session.refreshTokenExpiresAt,
  };

  // Written newest-secret-first so a crash midway can only ever leave a state
  // that `loadStoredSession` rejects as incomplete, never a valid-looking
  // session pointing at a stale refresh token.
  await SecureStore.setItemAsync(KEYS.refreshToken, session.refreshToken, OPTIONS);
  await SecureStore.setItemAsync(KEYS.accessToken, session.accessToken, OPTIONS);
  await SecureStore.setItemAsync(KEYS.meta, JSON.stringify(meta), OPTIONS);
}

/**
 * Returns the stored session, or null if there is none.
 *
 * Any unreadable, partial or schema-invalid state is treated as "no session"
 * AND wiped, so a corrupt keychain entry can never be retried forever or
 * half-applied. This function never throws: failing to read a credential must
 * degrade to signed-out, not to a crash on launch.
 */
export async function loadStoredSession(): Promise<StoredSession | null> {
  try {
    const [accessToken, refreshToken, rawMeta] = await Promise.all([
      SecureStore.getItemAsync(KEYS.accessToken, OPTIONS),
      SecureStore.getItemAsync(KEYS.refreshToken, OPTIONS),
      SecureStore.getItemAsync(KEYS.meta, OPTIONS),
    ]);

    if (accessToken === null || refreshToken === null || rawMeta === null) {
      if (accessToken !== null || refreshToken !== null || rawMeta !== null) {
        await clearStoredSession();
      }
      return null;
    }

    const meta: unknown = JSON.parse(rawMeta);
    const parsed = StoredSessionSchema.safeParse({
      ...(typeof meta === 'object' && meta !== null ? meta : {}),
      accessToken,
      refreshToken,
    });

    if (!parsed.success) {
      await clearStoredSession();
      return null;
    }

    return parsed.data;
  } catch {
    await clearStoredSession();
    return null;
  }
}

/**
 * Removes every credential entry. Deliberately tolerant of individual failures:
 * a sign-out that gives up halfway is worse than one that tries everything.
 */
export async function clearStoredSession(): Promise<void> {
  await Promise.all(
    Object.values(KEYS).map(async (key) => {
      try {
        await SecureStore.deleteItemAsync(key, OPTIONS);
      } catch {
        // Nothing actionable, and the message could name the key. Swallow.
      }
    }),
  );
}

/** Exposed for tests and diagnostics; never log the values behind these. */
export const SECURE_STORE_KEYS = KEYS;
