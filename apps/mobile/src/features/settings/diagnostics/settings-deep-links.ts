import Constants from 'expo-constants';
import { Linking, Platform } from 'react-native';

/**
 * Deep links into the OS settings pages that fix a location problem.
 *
 * iOS deliberately exposes exactly one sanctioned entry point —
 * `UIApplication.openSettingsURLString`, which `Linking.openSettings()` wraps —
 * and opens the app's own settings page. The `App-Prefs:` scheme that appears
 * in blog posts is private API and gets builds rejected, so it is not used
 * here. Instead every iOS remedy pairs the button with the exact tap-by-tap
 * path, because sending a user to a settings screen without telling them what
 * to look for is not a fix.
 *
 * Android does expose per-page intents, so those are used where they exist and
 * fall back to the app detail page when the OEM has removed them.
 */

export type SettingsDeepLink =
  /** The app's own settings page. Available on both platforms. */
  | { kind: 'APP_SETTINGS' }
  /** An Android `android.settings.*` intent action. */
  | { kind: 'ANDROID_INTENT'; action: string; extras?: Array<{ key: string; value: string }> }
  /** A web page, used for help articles only. */
  | { kind: 'URL'; url: string };

/** The Android applicationId, needed as an extra by some settings intents. */
function androidPackageName(): string | null {
  const fromConfig = Constants.expoConfig?.android?.package;
  return typeof fromConfig === 'string' && fromConfig.length > 0 ? fromConfig : null;
}

export const APP_SETTINGS: SettingsDeepLink = { kind: 'APP_SETTINGS' };

/** System-wide Location Services / GPS master toggle. */
export function locationServicesLink(): SettingsDeepLink {
  return Platform.OS === 'android'
    ? { kind: 'ANDROID_INTENT', action: 'android.settings.LOCATION_SOURCE_SETTINGS' }
    : APP_SETTINGS;
}

/** This app's notification settings. */
export function appNotificationSettingsLink(): SettingsDeepLink {
  const packageName = androidPackageName();
  if (Platform.OS === 'android' && packageName) {
    return {
      kind: 'ANDROID_INTENT',
      action: 'android.settings.APP_NOTIFICATION_SETTINGS',
      extras: [{ key: 'android.provider.extra.APP_PACKAGE', value: packageName }],
    };
  }
  return APP_SETTINGS;
}

/** Android battery-optimisation exemption list. */
export function batteryOptimizationLink(): SettingsDeepLink {
  return Platform.OS === 'android'
    ? { kind: 'ANDROID_INTENT', action: 'android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS' }
    : APP_SETTINGS;
}

/** iOS Background App Refresh lives on the app's own settings page. */
export function backgroundRefreshLink(): SettingsDeepLink {
  return APP_SETTINGS;
}

/**
 * Opens a deep link, degrading to the app settings page when the OEM has
 * removed the intent. Returns false when nothing could be opened, so the caller
 * can show the written instructions instead of failing silently.
 */
export async function openSettingsDeepLink(link: SettingsDeepLink): Promise<boolean> {
  try {
    switch (link.kind) {
      case 'APP_SETTINGS':
        await Linking.openSettings();
        return true;

      case 'ANDROID_INTENT': {
        if (Platform.OS !== 'android') {
          await Linking.openSettings();
          return true;
        }
        try {
          await Linking.sendIntent(link.action, link.extras);
          return true;
        } catch {
          // Some OEM builds simply do not have the page. The app detail screen
          // always exists, and the written steps still apply from there.
          await Linking.openSettings();
          return true;
        }
      }

      case 'URL': {
        const supported = await Linking.canOpenURL(link.url);
        if (!supported) return false;
        await Linking.openURL(link.url);
        return true;
      }

      default:
        return false;
    }
  } catch {
    return false;
  }
}
