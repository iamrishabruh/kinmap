/**
 * Every React Query key used by the settings, privacy and billing surface.
 *
 * Centralised for two reasons that both matter to this product:
 *   1. Optimistic updates need the *exact* key the reader used, or the cancel
 *      / snapshot / rollback dance in `sharing-mutations.ts` silently no-ops.
 *   2. Sign-out and account deletion must be able to evict everything derived
 *      from the previous identity. `settingsQueryKeys.root` is the single
 *      prefix `@/features/privacy` removes.
 */

const ROOT = 'settings' as const;

export const settingsQueryKeys = {
  root: [ROOT] as const,

  sharing: () => [ROOT, 'sharing'] as const,
  privacyAudit: (filter: { familyId: string | null }) =>
    [ROOT, 'privacy-audit', filter.familyId ?? 'all'] as const,
  devices: () => [ROOT, 'devices'] as const,
  notificationPreferences: () => [ROOT, 'notifications'] as const,
  deviceHealth: () => [ROOT, 'device-health'] as const,
  retention: () => [ROOT, 'retention'] as const,
  dataExport: (exportId: string) => [ROOT, 'data-export', exportId] as const,
  accountDeletionPreview: () => [ROOT, 'account-deletion-preview'] as const,

  /** Server entitlements. The RevenueCat value is never cached under this key. */
  serverEntitlements: () => [ROOT, 'entitlements', 'server'] as const,
  /** The client-side hint, kept separate so the two can never be confused. */
  purchasesOfferings: () => [ROOT, 'entitlements', 'offerings'] as const,
  purchasesCustomerInfo: () => [ROOT, 'entitlements', 'customer-info'] as const,
} as const;
