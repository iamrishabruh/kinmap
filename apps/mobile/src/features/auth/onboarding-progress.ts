import * as SecureStore from 'expo-secure-store';

/**
 * Device-local record of who has finished the onboarding flow.
 *
 * Stored per user id so that signing in as a different family member on a
 * shared handset does not inherit the previous person's progress — and so that
 * nobody is silently opted past a consent primer they never saw.
 *
 * Reaching the end of onboarding with sharing switched OFF still counts as
 * complete. Declining is a finished outcome, not an unfinished one; re-running
 * the primer until the user gives in is precisely the pattern this product does
 * not ship.
 */

const KEY = 'family.onboarding.completedForUserId';
const OPTIONS: SecureStore.SecureStoreOptions = { keychainService: 'family-location.app' };

export async function readOnboardingCompleted(userId: string): Promise<boolean> {
  try {
    const stored = await SecureStore.getItemAsync(KEY, OPTIONS);
    return stored === userId;
  } catch {
    // Unreadable state means "not completed": showing the primer again is safe,
    // skipping it is not.
    return false;
  }
}

export async function writeOnboardingCompleted(userId: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(KEY, userId, OPTIONS);
  } catch {
    // Non-fatal: the user simply sees onboarding again next launch.
  }
}

export async function clearOnboardingCompleted(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(KEY, OPTIONS);
  } catch {
    // Nothing actionable.
  }
}
