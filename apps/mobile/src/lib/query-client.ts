import { QueryClient } from '@tanstack/react-query';
import { AppError } from '@family/contracts';

/**
 * The single React Query client.
 *
 * NOT PERSISTED, AND NEVER TO BE. This cache holds family membership, sharing
 * status and — once the map features land — positions. Persisting it would put
 * that on disk in plaintext, outside the keychain, and would survive a sign-out
 * that failed halfway. In-memory only; a cold start refetches.
 */

/** Retrying a 4xx just replays a rejected request; only 5xx/transport retry. */
function shouldRetry(failureCount: number, error: unknown): boolean {
  if (failureCount >= 2) return false;
  if (error instanceof AppError) {
    return error.status >= 500 || error.code === 'UPSTREAM_UNAVAILABLE';
  }
  return true;
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Location freshness is handled explicitly by the map feature; general
      // resources tolerate a short window.
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      retry: shouldRetry,
      refetchOnWindowFocus: false,
      refetchOnReconnect: true,
    },
    mutations: {
      retry: false,
    },
  },
});

/**
 * Drops every cached response and every recorded mutation.
 *
 * Called on sign-out. `clear()` alone leaves in-flight requests running, so
 * they are cancelled first — otherwise a family list requested by the previous
 * user can land in the cache moments after they signed out.
 */
export async function purgeCachedData(): Promise<void> {
  await queryClient.cancelQueries();
  queryClient.getMutationCache().clear();
  queryClient.clear();
}
