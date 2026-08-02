import Constants from 'expo-constants';
import { Platform } from 'react-native';
import Purchases, {
  LOG_LEVEL,
  type CustomerInfo,
  type PurchasesOffering,
  type PurchasesOfferings,
  type PurchasesPackage,
} from 'react-native-purchases';

import type { PlanTier } from '@family/contracts';

import {
  getEntitlementMapping,
  tierFromEntitlementIds,
  type ClientEntitlementHint,
} from './entitlement';

/**
 * The RevenueCat boundary (react-native-purchases 10.6.0).
 *
 * Everything the store SDK produces is treated as a *hint*: it is used to draw
 * plan cards, run the purchase sheet, and prompt the server to re-check a
 * receipt. It is never the source of truth for what the user is entitled to —
 * see `entitlement.ts` for why.
 *
 * Nothing in this module logs a customer id, a receipt, or a token.
 */

type PurchasesExtra = {
  revenueCatIosKey?: string;
  revenueCatAndroidKey?: string;
};

let configured = false;

function publicApiKey(): string | null {
  const extra = (Constants.expoConfig?.extra ?? {}) as PurchasesExtra;
  const key = Platform.OS === 'ios' ? extra.revenueCatIosKey : extra.revenueCatAndroidKey;
  return typeof key === 'string' && key.length > 0 ? key : null;
}

/** True when purchases can run at all on this build and platform. */
export function isPurchasesSupported(): boolean {
  return (Platform.OS === 'ios' || Platform.OS === 'android') && publicApiKey() !== null;
}

/**
 * Configures the SDK once per process.
 *
 * `appUserId` must be the app's own user id so that a subscription follows the
 * account rather than the device — otherwise reinstalling on a new phone looks
 * like a lapsed subscriber. Passing null lets RevenueCat generate an anonymous
 * id, which is correct before sign-in only.
 */
export function configurePurchases(appUserId: string | null): boolean {
  if (configured) return true;
  const apiKey = publicApiKey();
  if (!apiKey) return false;

  Purchases.setLogLevel(__DEV__ ? LOG_LEVEL.WARN : LOG_LEVEL.ERROR);
  Purchases.configure({ apiKey, appUserID: appUserId });
  configured = true;
  return true;
}

export function isPurchasesConfigured(): boolean {
  return configured;
}

/** Test/sign-out helper. Does not talk to the SDK. */
export function resetPurchasesConfiguration(): void {
  configured = false;
}

/** Links the store account to a signed-in user. Safe to call repeatedly. */
export async function identifyPurchasesUser(appUserId: string): Promise<CustomerInfo> {
  const { customerInfo } = await Purchases.logIn(appUserId);
  return customerInfo;
}

/**
 * Detaches the store account on sign-out so the next person to sign in on this
 * phone does not inherit the previous person's subscription state.
 */
export async function signOutPurchasesUser(): Promise<void> {
  try {
    await Purchases.logOut();
  } catch {
    // Already anonymous. Nothing to detach.
  }
}

// ---------------------------------------------------------------------------
// Offerings
// ---------------------------------------------------------------------------

export async function fetchOfferings(): Promise<PurchasesOfferings> {
  return Purchases.getOfferings();
}

export type PlanOption = {
  /** RevenueCat package identifier, used to start the purchase. */
  packageIdentifier: string;
  productIdentifier: string;
  tier: PlanTier;
  title: string;
  /** Localised, store-formatted price. Never format currency ourselves. */
  priceString: string;
  /** 'MONTHLY' | 'ANNUAL' | other package types RevenueCat reports. */
  period: string;
  rcPackage: PurchasesPackage;
};

/**
 * Maps an offering's packages onto our tiers.
 *
 * The mapping is by product identifier suffix so that a dashboard rename does
 * not silently show a user the wrong plan name: an unrecognised product is
 * dropped from the list rather than guessed at.
 */
export function toPlanOptions(
  offering: PurchasesOffering | null,
  productTiers: Readonly<Record<string, PlanTier>>,
): PlanOption[] {
  if (!offering) return [];

  return offering.availablePackages.flatMap<PlanOption>((rcPackage) => {
    const productIdentifier = rcPackage.product.identifier;
    const tier = productTiers[productIdentifier];
    if (!tier) return [];

    return [
      {
        packageIdentifier: rcPackage.identifier,
        productIdentifier,
        tier,
        title: rcPackage.product.title,
        priceString: rcPackage.product.priceString,
        period: rcPackage.packageType,
        rcPackage,
      },
    ];
  });
}

// ---------------------------------------------------------------------------
// Purchase, restore, customer info
// ---------------------------------------------------------------------------

export type PurchaseOutcome =
  | { kind: 'PURCHASED'; customerInfo: CustomerInfo; productIdentifier: string }
  | { kind: 'CANCELLED' }
  | { kind: 'FAILED'; message: string };

/**
 * Starts the store purchase sheet.
 *
 * `oldProductIdentifier` drives Android upgrades and downgrades — Play requires
 * the outgoing product to be named, or it treats the purchase as a second,
 * parallel subscription. iOS handles the change itself as long as both products
 * are in the same subscription group, so the argument is ignored there.
 */
export async function purchasePlan(
  option: PlanOption,
  params: { oldProductIdentifier?: string | null } = {},
): Promise<PurchaseOutcome> {
  try {
    const oldProductIdentifier = params.oldProductIdentifier ?? null;

    // The second parameter is the deprecated UpgradeInfo (oldSKU); product
    // changes go through the third, GoogleProductChangeInfo.
    const result =
      Platform.OS === 'android' && oldProductIdentifier
        ? await Purchases.purchasePackage(option.rcPackage, null, { oldProductIdentifier })
        : await Purchases.purchasePackage(option.rcPackage);

    return {
      kind: 'PURCHASED',
      customerInfo: result.customerInfo,
      productIdentifier: result.productIdentifier,
    };
  } catch (error) {
    if (isUserCancelled(error)) return { kind: 'CANCELLED' };
    return { kind: 'FAILED', message: describePurchaseError(error) };
  }
}

export async function restorePurchases(): Promise<CustomerInfo> {
  return Purchases.restorePurchases();
}

export async function fetchCustomerInfo(): Promise<CustomerInfo> {
  return Purchases.getCustomerInfo();
}

export function addCustomerInfoListener(listener: (info: CustomerInfo) => void): () => void {
  Purchases.addCustomerInfoUpdateListener(listener);
  return () => {
    Purchases.removeCustomerInfoUpdateListener(listener);
  };
}

// ---------------------------------------------------------------------------
// Translating the SDK's view into our hint type
// ---------------------------------------------------------------------------

/**
 * Reduces `CustomerInfo` to the small, explicitly-named hint the rest of the
 * app is allowed to see. Nothing else from the SDK escapes this module, so
 * there is no path by which a screen accidentally renders a store value as if
 * it were authoritative.
 */
export function toClientEntitlementHint(
  customerInfo: CustomerInfo,
  observedAt: Date = new Date(),
): ClientEntitlementHint {
  const active = customerInfo.entitlements.active;
  const activeEntitlementIds = Object.keys(active);
  const tier = tierFromEntitlementIds(activeEntitlementIds);

  // Read renewal detail from the entitlement that actually produced the tier,
  // not merely the first one in the map — a user holding both a legacy and a
  // current entitlement would otherwise be shown the wrong renewal date.
  const mapping = getEntitlementMapping();
  const governingId =
    activeEntitlementIds.find((id) => mapping[id] === tier) ?? activeEntitlementIds[0];
  const governing = governingId === undefined ? undefined : active[governingId];

  return {
    tier,
    activeEntitlementIds,
    willRenew: governing?.willRenew ?? false,
    expiresAt: governing?.expirationDate ?? customerInfo.latestExpirationDate ?? null,
    managementUrl: customerInfo.managementURL ?? null,
    observedAt: observedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

type StoreErrorShape = {
  userCancelled?: boolean;
  code?: string | number;
  message?: string;
  readableErrorCode?: string;
};

function asStoreError(error: unknown): StoreErrorShape | null {
  return typeof error === 'object' && error !== null ? (error as StoreErrorShape) : null;
}

/** A cancelled purchase is not an error and must never surface as one. */
export function isUserCancelled(error: unknown): boolean {
  return asStoreError(error)?.userCancelled === true;
}

/**
 * A user-safe explanation. The SDK's raw message can contain store account
 * detail, so only a small set of recognised conditions is passed through.
 */
export function describePurchaseError(error: unknown): string {
  const store = asStoreError(error);
  const readable = store?.readableErrorCode;

  switch (readable) {
    case 'PurchaseNotAllowedError':
      return 'Purchases are not allowed on this device. Check Screen Time or parental controls.';
    case 'PaymentPendingError':
      return 'Your payment is still being processed. Your plan will update once the store confirms it.';
    case 'ProductAlreadyPurchasedError':
      return 'You already own this plan. Tap Restore purchases to link it to this account.';
    case 'ReceiptAlreadyInUseError':
      return 'This subscription is already linked to a different account. Contact support and we will sort it out.';
    case 'NetworkError':
      return 'We could not reach the store. Check your connection and try again.';
    case 'StoreProblemError':
      return 'The store is having trouble right now. Please try again shortly.';
    case 'IneligibleError':
      return 'This offer is not available for your account.';
    default:
      return 'The purchase did not go through. You have not been charged.';
  }
}
