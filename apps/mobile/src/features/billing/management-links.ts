import Constants from 'expo-constants';
import { Linking, Platform } from 'react-native';

/**
 * Where a user goes to change or cancel a subscription.
 *
 * Both stores require cancellation to happen in the store, not in the app, and
 * both require the app to tell the user where that is. Hiding it, or making the
 * user email support to cancel, is a review rejection on iOS and a dark pattern
 * everywhere — so this is a first-class, always-visible row on the subscription
 * screen, including while a subscription is active.
 */

const APP_STORE_SUBSCRIPTIONS = 'https://apps.apple.com/account/subscriptions';
const PLAY_STORE_SUBSCRIPTIONS = 'https://play.google.com/store/account/subscriptions';

export type ManagementTarget = {
  url: string;
  label: string;
  /** What the user will be able to do once they get there. */
  detail: string;
};

/**
 * Prefers the URL RevenueCat reports, because it deep-links to the specific
 * subscription rather than the account's whole list. Falls back to the store's
 * generic page, which always exists.
 */
export function subscriptionManagementTarget(params: {
  managementUrl?: string | null;
  productIdentifier?: string | null;
}): ManagementTarget {
  const storeLabel = Platform.OS === 'ios' ? 'the App Store' : 'Google Play';

  if (params.managementUrl) {
    return {
      url: params.managementUrl,
      label: `Manage subscription in ${storeLabel}`,
      detail: `Change plan, update payment details or cancel. Cancelling is done in ${storeLabel}, not here.`,
    };
  }

  if (Platform.OS === 'android') {
    const packageName = Constants.expoConfig?.android?.package;
    const url =
      params.productIdentifier && packageName
        ? `${PLAY_STORE_SUBSCRIPTIONS}?sku=${encodeURIComponent(params.productIdentifier)}&package=${encodeURIComponent(packageName)}`
        : PLAY_STORE_SUBSCRIPTIONS;

    return {
      url,
      label: 'Manage subscription in Google Play',
      detail:
        'Change plan, update payment details or cancel. Cancelling is done in Google Play, not here.',
    };
  }

  return {
    url: APP_STORE_SUBSCRIPTIONS,
    label: 'Manage subscription in the App Store',
    detail:
      'Change plan, update payment details or cancel. Cancelling is done in the App Store, not here.',
  };
}

export async function openSubscriptionManagement(target: ManagementTarget): Promise<boolean> {
  try {
    await Linking.openURL(target.url);
    return true;
  } catch {
    return false;
  }
}

/** Store-specific refund guidance, shown on the support screen. */
export function refundGuidance(): { title: string; body: string; url: string } {
  if (Platform.OS === 'ios') {
    return {
      title: 'Refunds are handled by Apple',
      body: 'We cannot issue refunds for App Store purchases. Apple reviews refund requests directly, usually within 48 hours.',
      url: 'https://reportaproblem.apple.com',
    };
  }
  return {
    title: 'Refunds are handled by Google',
    body: 'We cannot issue refunds for Google Play purchases. Google reviews refund requests directly. If Google declines and you think that is wrong, contact us and we will look at it.',
    url: 'https://support.google.com/googleplay/answer/2479637',
  };
}
