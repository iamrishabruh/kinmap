import { setAuthBridge } from '@/lib/api';

import { ensureFreshAccessToken, refreshSession } from './refresh';
import { signOut } from './sign-out';

/**
 * Connects the transport to the session.
 *
 * `@/lib/api` owns "how a request is sent" and knows nothing about auth; this
 * module hands it the three callbacks it needs. Installing the bridge is the
 * first thing the root layout does, before any provider mounts, so that no
 * request can ever be made anonymously by accident.
 */

let installed = false;

export function installAuthBridge(): void {
  if (installed) return;
  installed = true;

  setAuthBridge({
    getAccessToken: ensureFreshAccessToken,

    /**
     * Returns null only when the session is definitively over; a transient
     * failure throws and is surfaced to the caller with the session intact.
     */
    refreshAccessToken: async () => {
      const session = await refreshSession();
      return session?.accessToken ?? null;
    },

    onAuthenticationLost: () => {
      // Fire-and-forget: this is called from inside a failing request, and the
      // request's own error still has to propagate to its caller.
      void signOut('SESSION_EXPIRED');
    },
  });
}
