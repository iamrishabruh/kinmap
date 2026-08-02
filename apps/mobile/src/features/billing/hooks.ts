import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo } from 'react';

import { fetchServerEntitlements, syncSubscription } from '../settings/api/endpoints';
import { settingsQueryKeys } from '../settings/api/query-keys';

import {
  resolveEntitlementView,
  type ClientEntitlementHint,
  type EntitlementView,
} from './entitlement';
import { getProductTiers } from './plans';
import {
  addCustomerInfoListener,
  fetchCustomerInfo,
  fetchOfferings,
  isPurchasesSupported,
  purchasePlan,
  restorePurchases,
  toClientEntitlementHint,
  toPlanOptions,
  type PlanOption,
  type PurchaseOutcome,
} from './purchases';

/**
 * React Query bindings for billing.
 *
 * The two sources are kept in two separate queries under two separate keys, and
 * only ever combined by `resolveEntitlementView`. Caching them together would
 * make it possible for a refetch of one to overwrite the other, which is
 * exactly the bug that ends with a client value being displayed as if the
 * server had confirmed it.
 */

/** The server value is cheap, authoritative, and worth re-checking often. */
const SERVER_ENTITLEMENT_STALE_MS = 60_000;

export function useServerEntitlements() {
  return useQuery({
    queryKey: settingsQueryKeys.serverEntitlements(),
    queryFn: ({ signal }) => fetchServerEntitlements(signal),
    staleTime: SERVER_ENTITLEMENT_STALE_MS,
  });
}

export function useClientEntitlementHint() {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: settingsQueryKeys.purchasesCustomerInfo(),
    queryFn: async (): Promise<ClientEntitlementHint> =>
      toClientEntitlementHint(await fetchCustomerInfo()),
    enabled: isPurchasesSupported(),
    staleTime: SERVER_ENTITLEMENT_STALE_MS,
  });

  // The store can tell us about a renewal, a lapse or a family-sharing change
  // without the user doing anything. Reflect it in the hint immediately, and
  // let the server confirm it in its own time.
  useEffect(() => {
    if (!isPurchasesSupported()) return undefined;

    return addCustomerInfoListener((info) => {
      queryClient.setQueryData<ClientEntitlementHint>(
        settingsQueryKeys.purchasesCustomerInfo(),
        toClientEntitlementHint(info),
      );
      void queryClient.invalidateQueries({
        queryKey: settingsQueryKeys.serverEntitlements(),
      });
    });
  }, [queryClient]);

  return query;
}

export type UseEntitlementResult = {
  view: EntitlementView;
  isLoading: boolean;
  isRefetching: boolean;
  refetch: () => Promise<void>;
};

/**
 * The hook every screen should use to ask "what does this user have?".
 *
 * It never returns the RevenueCat value without labelling it — see
 * `EntitlementView.isProvisional`.
 */
export function useEntitlementView(): UseEntitlementResult {
  const server = useServerEntitlements();
  const hint = useClientEntitlementHint();
  const queryClient = useQueryClient();

  const view = useMemo(
    () =>
      resolveEntitlementView({
        server: server.data ?? null,
        clientHint: hint.data ?? null,
      }),
    [server.data, hint.data],
  );

  // Disagreement means the server has not seen the receipt yet. Ask it to look
  // again rather than quietly showing the client's more generous answer.
  useEffect(() => {
    if (!view.needsServerSync) return;
    const activeIds = hint.data?.activeEntitlementIds ?? [];
    if (activeIds.length === 0) return;

    void queryClient.invalidateQueries({
      queryKey: settingsQueryKeys.serverEntitlements(),
    });
  }, [view.needsServerSync, hint.data, queryClient]);

  const refetch = useCallback(async () => {
    await Promise.all([server.refetch(), hint.refetch()]);
  }, [server, hint]);

  return {
    view,
    isLoading: server.isLoading || hint.isLoading,
    isRefetching: server.isRefetching || hint.isRefetching,
    refetch,
  };
}

export function useOfferings() {
  return useQuery({
    queryKey: settingsQueryKeys.purchasesOfferings(),
    queryFn: async (): Promise<PlanOption[]> => {
      const offerings = await fetchOfferings();
      return toPlanOptions(offerings.current, getProductTiers());
    },
    enabled: isPurchasesSupported(),
    staleTime: 5 * 60_000,
  });
}

/**
 * Runs a purchase and then makes the server re-read the receipt, so the value
 * the user sees after paying is the authoritative one and not the store's.
 */
export function usePurchasePlan(revenueCatAppUserId: string | null) {
  const queryClient = useQueryClient();

  return useMutation<
    PurchaseOutcome,
    unknown,
    { option: PlanOption; oldProductIdentifier?: string | null }
  >({
    mutationFn: ({ option, oldProductIdentifier }) =>
      purchasePlan(option, { oldProductIdentifier: oldProductIdentifier ?? null }),

    async onSuccess(outcome) {
      if (outcome.kind !== 'PURCHASED') return;

      queryClient.setQueryData(
        settingsQueryKeys.purchasesCustomerInfo(),
        toClientEntitlementHint(outcome.customerInfo),
      );

      if (revenueCatAppUserId) {
        try {
          const authoritative = await syncSubscription(revenueCatAppUserId);
          queryClient.setQueryData(settingsQueryKeys.serverEntitlements(), authoritative);
          return;
        } catch {
          // Fall through to an ordinary invalidation; the webhook will land.
        }
      }
      await queryClient.invalidateQueries({
        queryKey: settingsQueryKeys.serverEntitlements(),
      });
    },
  });
}

export function useRestorePurchases(revenueCatAppUserId: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      const customerInfo = await restorePurchases();
      return toClientEntitlementHint(customerInfo);
    },

    async onSuccess(hint) {
      queryClient.setQueryData(settingsQueryKeys.purchasesCustomerInfo(), hint);

      if (revenueCatAppUserId) {
        try {
          const authoritative = await syncSubscription(revenueCatAppUserId);
          queryClient.setQueryData(settingsQueryKeys.serverEntitlements(), authoritative);
          return;
        } catch {
          // Ignored; the invalidation below still refreshes the server value.
        }
      }
      await queryClient.invalidateQueries({
        queryKey: settingsQueryKeys.serverEntitlements(),
      });
    },
  });
}
