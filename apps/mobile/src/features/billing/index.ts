export {
  canUnlockPaidFeature,
  compareTiers,
  configureEntitlementMapping,
  describeStatus,
  describeTierBenefits,
  getEntitlementMapping,
  isDowngrade,
  isUpgrade,
  resolveEntitlementView,
  tierFromEntitlementIds,
  TIER_LABELS,
  type ClientEntitlementHint,
  type EntitlementSource,
  type EntitlementView,
} from './entitlement';

export {
  useClientEntitlementHint,
  useEntitlementView,
  useOfferings,
  usePurchasePlan,
  useRestorePurchases,
  useServerEntitlements,
  type UseEntitlementResult,
} from './hooks';

export {
  openSubscriptionManagement,
  refundGuidance,
  subscriptionManagementTarget,
  type ManagementTarget,
} from './management-links';

export {
  configureProductTiers,
  DEFAULT_PRODUCT_TIERS,
  getProductTiers,
  TIER_DISPLAY_ORDER,
} from './plans';

export {
  addCustomerInfoListener,
  configurePurchases,
  describePurchaseError,
  fetchCustomerInfo,
  fetchOfferings,
  identifyPurchasesUser,
  isPurchasesConfigured,
  isPurchasesSupported,
  isUserCancelled,
  purchasePlan,
  resetPurchasesConfiguration,
  restorePurchases,
  signOutPurchasesUser,
  toClientEntitlementHint,
  toPlanOptions,
  type PlanOption,
  type PurchaseOutcome,
} from './purchases';
