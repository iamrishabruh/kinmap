import { setObservabilityUser } from '@/lib/observability';
import { purgeCachedData } from '@/lib/query-client';

import { revokeSession } from './api';
import { signOutFromGoogle } from './google-sign-in';
import { clearOnboardingCompleted } from './onboarding-progress';
import { resetRefreshState } from './refresh';
import { clearStoredSession } from './secure-token-storage';
import { useSessionStore } from './session-store';
import type { SignOutReason } from './types';

/**
 * Sign-out.
 *
 * In a location product, signing out is a safety action, not a housekeeping
 * one: the person may be handing the phone to someone else, or getting away
 * from someone. So the order is deliberate.
 *
 *   1. Local state and credentials go FIRST, unconditionally. Nothing about the
 *      teardown may depend on the network succeeding.
 *   2. Registered teardown tasks run next — this is how the location feature
 *      stops sharing and the push feature drops the device token. If sharing
 *      kept running after sign-out, the app would be reporting a location for
 *      an account nobody is signed in to.
 *   3. Server revocation is best-effort, time-boxed, and never blocks the UI.
 *
 * `signOut` never throws. A sign-out that can fail is a sign-out that can leave
 * someone visible.
 */

export type SignOutTask = {
  /** Used only in the dev warning when a task throws. Never user data. */
  name: string;
  run: (reason: SignOutReason) => Promise<void>;
};

const tasks = new Map<string, SignOutTask>();

/**
 * Registers work that must happen on sign-out. Features register themselves at
 * startup, which keeps this module from importing half the app (and from
 * creating an import cycle with the features that need to sign out).
 */
export function registerSignOutTask(task: SignOutTask): () => void {
  tasks.set(task.name, task);
  return () => {
    tasks.delete(task.name);
  };
}

/** Test seam. */
export function clearSignOutTasks(): void {
  tasks.clear();
}

const REVOKE_TIMEOUT_MS = 5000;

function withTimeout(promise: Promise<unknown>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    promise
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(timer);
        resolve();
      });
  });
}

export type SignOutOptions = {
  /** Revoke every session for this account, not just this device. */
  allDevices?: boolean;
};

export async function signOut(reason: SignOutReason, options: SignOutOptions = {}): Promise<void> {
  const store = useSessionStore.getState();
  const session = store.session;
  const userId = session?.userId ?? null;

  // 1. Local teardown first. From this line on, no screen can read a token and
  //    no query can be issued with one.
  resetRefreshState();
  store.reset(reason);
  await clearStoredSession();
  if (userId !== null) {
    await clearOnboardingCompleted();
  }

  // 2. Feature teardown: stop sharing, unregister push, drop billing identity.
  await Promise.allSettled(
    Array.from(tasks.values()).map(async (task) => {
      try {
        await task.run(reason);
      } catch (cause) {
        if (__DEV__) {
          console.warn(`[sign-out] task "${task.name}" failed`, cause);
        }
      }
    }),
  );

  // 3. Cached family data. Done after the feature tasks so a task that needs to
  //    read, say, the current family id still can.
  await purgeCachedData();

  await signOutFromGoogle();
  setObservabilityUser(null);

  // 4. Tell the server, but never wait on it. If the device is offline the
  //    refresh token stays valid until it expires; the local credential is
  //    already gone either way.
  if (session !== null) {
    await withTimeout(
      revokeSession(session.refreshToken, options.allDevices ?? false),
      REVOKE_TIMEOUT_MS,
    );
  }
}
