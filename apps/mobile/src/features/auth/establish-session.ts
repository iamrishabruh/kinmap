import type { AuthSession } from '@family/schemas';

import { setObservabilityUser } from '@/lib/observability';

import { readOnboardingCompleted } from './onboarding-progress';
import { saveStoredSession } from './secure-token-storage';
import { useSessionStore } from './session-store';
import type { StoredSession } from './types';

/**
 * Turns a server `AuthSession` into a live, persisted client session.
 *
 * The keychain write happens BEFORE the store update so there is no window in
 * which the app believes it is signed in but a crash would lose the
 * credentials — the reverse order produces an account the user has to sign in
 * to again for no visible reason.
 *
 * `isNewUser` and `termsAcceptanceRequired` from the response are deliberately
 * not persisted: both are re-derived from `GET /v1/account` on every launch, so
 * a stale device can never talk its way past the consent gate.
 */
export async function establishSession(authSession: AuthSession): Promise<void> {
  const stored: StoredSession = {
    userId: authSession.userId,
    accessToken: authSession.accessToken,
    accessTokenExpiresAt: authSession.accessTokenExpiresAt,
    refreshToken: authSession.refreshToken,
    refreshTokenExpiresAt: authSession.refreshTokenExpiresAt,
  };

  await saveStoredSession(stored);

  const store = useSessionStore.getState();
  store.setSession(stored);
  store.setOnboardingCompleted(await readOnboardingCompleted(stored.userId));

  setObservabilityUser(stored.userId);
}
