import { AppError } from '@family/contracts';
import { RefreshSessionResponseSchema } from '@family/schemas';

import { isUnauthenticated, request } from '@/lib/api';

import { clearStoredSession, saveStoredSession } from './secure-token-storage';
import { useSessionStore } from './session-store';
import type { StoredSession } from './types';

/**
 * Access-token refresh.
 *
 * Two properties matter here.
 *
 * SINGLE FLIGHT. On cold start the map, the family list and the sharing status
 * all fire at once. If every one of them noticed the same expired token and
 * refreshed independently, a server that rotates refresh tokens would invalidate
 * the winner's token and sign the user out. Concurrent callers therefore share
 * one in-flight promise.
 *
 * TRANSIENT vs DEFINITIVE. Being offline is not being signed out. Only a 401
 * from the refresh endpoint itself — the refresh token is expired, revoked, or
 * belongs to a device an admin removed — ends the session. Everything else
 * propagates as an error and leaves the credentials in place.
 */

/** Refresh this far ahead of expiry so a request never races the boundary. */
const EXPIRY_SKEW_MS = 60_000;

let inFlight: Promise<StoredSession | null> | null = null;

function isExpired(isoTimestamp: string, skewMs: number): boolean {
  const expiresAt = Date.parse(isoTimestamp);
  if (Number.isNaN(expiresAt)) {
    // An unparseable expiry is treated as expired: re-authenticating costs a
    // round trip, trusting a corrupt timestamp costs a wrongly-authorised call.
    return true;
  }
  return expiresAt - skewMs <= Date.now();
}

async function performRefresh(current: StoredSession): Promise<StoredSession | null> {
  // Don't spend a round trip on a refresh token we can already see is dead.
  if (isExpired(current.refreshTokenExpiresAt, 0)) {
    await clearStoredSession();
    return null;
  }

  try {
    const response = await request({
      method: 'POST',
      path: '/v1/auth/refresh',
      body: { refreshToken: current.refreshToken },
      schema: RefreshSessionResponseSchema,
      // Anonymous: the refresh token IS the credential, and routing this
      // through the bridge would recurse into this function.
      anonymous: true,
    });

    const next: StoredSession = {
      userId: response.userId,
      accessToken: response.accessToken,
      accessTokenExpiresAt: response.accessTokenExpiresAt,
      refreshToken: response.refreshToken,
      refreshTokenExpiresAt: response.refreshTokenExpiresAt,
    };

    await saveStoredSession(next);
    useSessionStore.getState().setSession(next);
    return next;
  } catch (cause) {
    if (
      isUnauthenticated(cause) ||
      (cause instanceof AppError && cause.code === 'DEVICE_REVOKED')
    ) {
      // Definitive. Drop the credentials here so that even if the caller
      // mishandles the result, nothing usable is left on the device.
      await clearStoredSession();
      return null;
    }
    throw cause;
  }
}

/**
 * Refreshes the session, collapsing concurrent callers into one request.
 *
 * @returns the new session, or `null` when the session is definitively over.
 * @throws  `AppError` when the refresh could not be completed for a transient
 *          reason; the existing credentials are untouched in that case.
 */
export async function refreshSession(): Promise<StoredSession | null> {
  if (inFlight !== null) return inFlight;

  const current = useSessionStore.getState().session;
  if (current === null) return null;

  inFlight = performRefresh(current).finally(() => {
    inFlight = null;
  });

  return inFlight;
}

/**
 * Returns a token that is valid now, refreshing first if it is at or near
 * expiry. Returns `null` when there is no session at all.
 */
export async function ensureFreshAccessToken(): Promise<string | null> {
  const current = useSessionStore.getState().session;
  if (current === null) return null;

  if (!isExpired(current.accessTokenExpiresAt, EXPIRY_SKEW_MS)) {
    return current.accessToken;
  }

  const refreshed = await refreshSession();
  return refreshed?.accessToken ?? null;
}

/** Test seam: drops any shared in-flight refresh. */
export function resetRefreshState(): void {
  inFlight = null;
}
