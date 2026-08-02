import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, type ReactNode } from 'react';

import { ApiProvider, type FamilyApi } from '@/features/query/api';
import {
  onAuthorizationLost,
  reasonForErrorCode,
  type PurgeSummary,
} from '@/features/query/authorization';
import { errorCodeOf, isRetryable } from '@/features/query/errors';
import { QUERY_CACHE_IS_PERSISTED } from '@/features/query/policies';

/**
 * The app's QueryClient.
 *
 * Two behaviours are wired in globally rather than left to call sites:
 *
 *   - RETRIES stop at anything a retry cannot fix (403, 404, 422, entitlement,
 *     invitation state). Hammering a 403 is how you turn one authorization
 *     failure into a rate-limit ban.
 *
 *   - AUTHORIZATION LOSS is detected once, in the cache-level error handlers,
 *     so every query and every mutation is covered — including ones written
 *     later by someone who did not read this file.
 */

const MAX_RETRIES = 2;

export type CreateQueryClientOptions = {
  onAuthorizationPurged?: (summary: PurgeSummary) => void | Promise<void>;
};

export function createAppQueryClient(options: CreateQueryClientOptions = {}): QueryClient {
  // Assigned immediately after construction; the cache handlers below only run
  // once a query has been observed, which cannot happen before then.
  let client: QueryClient | null = null;
  let purging = false;

  const handleError = (error: unknown): void => {
    const code = errorCodeOf(error);
    if (code === null) return;
    const reason = reasonForErrorCode(code);
    if (reason === null || client === null || purging) return;
    purging = true;
    const purgeOptions = {
      queryClient: client,
      reason,
      ...(options.onAuthorizationPurged === undefined
        ? {}
        : { onPurged: options.onAuthorizationPurged }),
    };
    void onAuthorizationLost(purgeOptions).finally(() => {
      purging = false;
    });
  };

  client = new QueryClient({
    queryCache: new QueryCache({ onError: handleError }),
    mutationCache: new MutationCache({ onError: handleError }),
    defaultOptions: {
      queries: {
        retry: (failureCount, error) => failureCount < MAX_RETRIES && isRetryable(error),
        retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
        // Overridden per-query by CACHE_POLICIES; these are the safe floors.
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: true,
        networkMode: 'online',
      },
      mutations: {
        retry: 0,
        networkMode: 'online',
      },
    },
  });

  return client;
}

/**
 * Wraps the tree in the API transport and the QueryClient.
 *
 * The QueryClient is created once per provider instance and is never handed to
 * a persister — see `QUERY_CACHE_IS_PERSISTED`. On unmount the cache is cleared
 * so a backgrounded-and-torn-down app leaves nothing positional behind.
 */
export function AppQueryProvider({
  api,
  children,
  onAuthorizationPurged,
}: {
  api: FamilyApi;
  children: ReactNode;
  onAuthorizationPurged?: (summary: PurgeSummary) => void | Promise<void>;
}) {
  const purgedRef = useRef(onAuthorizationPurged);
  purgedRef.current = onAuthorizationPurged;

  const client = useMemo(
    () =>
      createAppQueryClient({
        onAuthorizationPurged: (summary) => purgedRef.current?.(summary),
      }),
    [],
  );

  useEffect(() => {
    return () => {
      client.clear();
    };
  }, [client]);

  if (QUERY_CACHE_IS_PERSISTED) {
    throw new Error('The query cache must remain memory-only.');
  }

  return (
    <QueryClientProvider client={client}>
      <ApiProvider api={api}>{children}</ApiProvider>
    </QueryClientProvider>
  );
}
