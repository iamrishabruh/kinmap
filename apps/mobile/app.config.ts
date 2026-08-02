import type { ConfigContext, ExpoConfig } from 'expo/config';

/**
 * Dynamic Expo configuration. Every environment-specific value is read from the
 * process environment (populated by EAS environment variables or a local
 * untracked .env) so that no identifier, key, or domain is hardcoded in Git.
 *
 * Only PUBLIC values belong here — anything in this file is embedded in the
 * shipped binary and must be treated as readable by anyone (spec §29).
 */

type Variant = 'development' | 'staging' | 'production';

const VARIANT = (process.env.APP_VARIANT ?? 'development') as Variant;

/** Fail closed: a missing required public value must break the build, not ship blank. */
function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. ` +
        `Set it in EAS environment variables or apps/mobile/.env.local before building.`,
    );
  }
  return value;
}

function optional(name: string): string | undefined {
  return process.env[name] || undefined;
}

const BASE_BUNDLE_ID = process.env.APP_BUNDLE_ID ?? 'com.example.familylocation';

/**
 * Production identifiers are never reused in non-production environments
 * (spec §6), so development and staging get their own suffixed identifiers and
 * can be installed side by side on one device.
 */
const VARIANT_CONFIG: Record<Variant, { suffix: string; name: string; scheme: string }> = {
  development: {
    suffix: '.dev',
    name: `${process.env.APP_NAME ?? 'Family Location'} (Dev)`,
    scheme: 'familylocation-dev',
  },
  staging: {
    suffix: '.staging',
    name: `${process.env.APP_NAME ?? 'Family Location'} (Staging)`,
    scheme: 'familylocation-staging',
  },
  production: {
    suffix: '',
    name: process.env.APP_NAME ?? 'Family Location',
    scheme: 'familylocation',
  },
};

const variant = VARIANT_CONFIG[VARIANT];
const bundleIdentifier = `${BASE_BUNDLE_ID}${variant.suffix}`;

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: variant.name,
  slug: process.env.EXPO_PROJECT_SLUG ?? 'family-location',
  version: '0.1.0',
  orientation: 'portrait',
  icon: './assets/images/icon.png',
  scheme: variant.scheme,
  userInterfaceStyle: 'automatic',
  // The New Architecture is the default and no longer a config flag in SDK 57.
  assetBundlePatterns: ['**/*'],

  ios: {
    bundleIdentifier,
    supportsTablet: false,
    // Build number is auto-incremented by EAS (spec §33).
    associatedDomains: process.env.APP_DOMAIN
      ? [`applinks:${process.env.APP_DOMAIN}`, `webcredentials:${process.env.APP_DOMAIN}`]
      : [],
    config: {
      usesNonExemptEncryption: false,
    },
    infoPlist: {
      // Deliberately specific language — vague permission copy is rejected by
      // App Review and is dishonest to the user (spec §25).
      NSLocationWhenInUseUsageDescription:
        'Family Location shows your place on your family map while you have the app open, and only while you have location sharing turned on.',
      NSLocationAlwaysAndWhenInUseUsageDescription:
        'Family Location shares your location with the family members you have chosen, even when the app is closed, so they can see you have arrived safely. You can pause or stop sharing at any time in the app, and you will always see when sharing is active.',
      NSLocationTemporaryUsageDescriptionDictionary: {
        LiveSession:
          'Precise location is used for the next few minutes so your family can follow your live trip. It turns off automatically when the session ends.',
      },
      NSUserTrackingUsageDescription:
        'Family Location does not track you across other apps or websites.',
      UIBackgroundModes: ['location', 'fetch', 'processing', 'remote-notification'],
      ITSAppUsesNonExemptEncryption: false,
    },
    entitlements: {
      'aps-environment': VARIANT === 'production' ? 'production' : 'development',
    },
  },

  android: {
    package: bundleIdentifier,
    adaptiveIcon: {
      backgroundColor: '#E6F4FE',
      foregroundImage: './assets/images/android-icon-foreground.png',
      backgroundImage: './assets/images/android-icon-background.png',
      monochromeImage: './assets/images/android-icon-monochrome.png',
    },
    predictiveBackGestureEnabled: false,
    permissions: [
      'ACCESS_COARSE_LOCATION',
      'ACCESS_FINE_LOCATION',
      'ACCESS_BACKGROUND_LOCATION',
      'FOREGROUND_SERVICE',
      'FOREGROUND_SERVICE_LOCATION',
      'POST_NOTIFICATIONS',
      'RECEIVE_BOOT_COMPLETED',
      'WAKE_LOCK',
    ],
    intentFilters: process.env.APP_DOMAIN
      ? [
          {
            action: 'VIEW',
            autoVerify: true,
            data: [{ scheme: 'https', host: process.env.APP_DOMAIN }],
            category: ['BROWSABLE', 'DEFAULT'],
          },
        ]
      : [],
  },

  web: {
    output: 'static',
    favicon: './assets/images/favicon.png',
  },

  plugins: [
    'expo-router',
    'expo-secure-store',
    'expo-localization',
    [
      'expo-splash-screen',
      {
        backgroundColor: '#208AEF',
        image: './assets/images/splash-icon.png',
        imageWidth: 76,
      },
    ],
    [
      'expo-location',
      {
        isIosBackgroundLocationEnabled: true,
        isAndroidBackgroundLocationEnabled: true,
        isAndroidForegroundServiceEnabled: true,
      },
    ],
    [
      'expo-notifications',
      {
        color: '#208AEF',
      },
    ],
    'expo-apple-authentication',
    [
      'expo-build-properties',
      {
        ios: { deploymentTarget: '16.4', useFrameworks: 'static' },
        android: { compileSdkVersion: 36, targetSdkVersion: 36, minSdkVersion: 24 },
      },
    ],
    './plugins/withLocationEngine',
    './plugins/withAndroidLocationEngine',
  ],

  experiments: {
    typedRoutes: true,
    reactCompiler: true,
  },

  extra: {
    router: {},
    eas: {
      projectId: optional('EAS_PROJECT_ID'),
    },
    // Public runtime configuration, validated at startup by src/config/env.ts.
    appEnv: VARIANT,
    apiBaseUrl: optional('API_BASE_URL'),
    cognitoUserPoolId: optional('COGNITO_USER_POOL_ID'),
    cognitoClientId: optional('COGNITO_CLIENT_ID'),
    cognitoDomain: optional('COGNITO_DOMAIN'),
    awsRegion: optional('AWS_REGION'),
    sentryDsn: optional('SENTRY_DSN'),
    revenueCatIosKey: optional('REVENUECAT_PUBLIC_IOS_KEY'),
    revenueCatAndroidKey: optional('REVENUECAT_PUBLIC_ANDROID_KEY'),
    googleMapsPublicKey: optional('GOOGLE_MAPS_PUBLIC_KEY'),
    googleIosClientId: optional('GOOGLE_IOS_CLIENT_ID'),
    googleWebClientId: optional('GOOGLE_WEB_CLIENT_ID'),
    supportEmail: optional('SUPPORT_EMAIL'),
    privacyUrl: optional('PRIVACY_URL'),
    termsUrl: optional('TERMS_URL'),
  },

  updates: {
    // OTA updates must never alter permission, billing, or safety-critical
    // location behaviour (spec §24) — those require a store release.
    fallbackToCacheTimeout: 0,
  },
  runtimeVersion: { policy: 'appVersion' },
});

// Referenced so `required` participates in typechecking even while the public
// config is still fully optional during bootstrap.
export { required };
