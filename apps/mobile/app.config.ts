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

/**
 * The app's identity. Fixed here, with no environment fallback.
 *
 * These used to read `process.env.APP_BUNDLE_ID ?? 'com.example.familylocation'`
 * and `process.env.APP_NAME ?? 'Family Location'`, which meant that anywhere
 * `.env.local` is not loaded — CI, and EAS Build — this file described a
 * different app from the one committed under `ios/` and `android/`. The native
 * projects say `app.kinmap.dev`; a config evaluated without the environment
 * said `com.example.familylocation.dev`.
 *
 * That is not a variable with a default. A bundle identifier is registered with
 * Apple, baked into provisioning profiles, and is what an installed app IS.
 * Sourcing it from an untracked file is how the wrong one reaches a build, and
 * it already had: it is the same failure that created a stray EAS project.
 *
 * Public information, so nothing is lost by committing it.
 */
const BASE_BUNDLE_ID = 'app.kinmap';
const APP_NAME = 'Kinmap';

/**
 * Production identifiers are never reused in non-production environments
 * (spec §6), so development and staging get their own suffixed identifiers and
 * can be installed side by side on one device.
 *
 * The `familylocation-*` schemes are kept alongside the reverse-DNS ones in the
 * committed native projects, so they are not removed here: a scheme that
 * disappears breaks any link already sent to somebody.
 */
const VARIANT_CONFIG: Record<Variant, { suffix: string; name: string; scheme: string }> = {
  development: {
    suffix: '.dev',
    name: `${APP_NAME} (Dev)`,
    scheme: 'familylocation-dev',
  },
  staging: {
    suffix: '.staging',
    name: `${APP_NAME} (Staging)`,
    scheme: 'familylocation-staging',
  },
  production: {
    suffix: '',
    name: APP_NAME,
    scheme: 'familylocation',
  },
};

const variant = VARIANT_CONFIG[VARIANT];
const bundleIdentifier = `${BASE_BUNDLE_ID}${variant.suffix}`;

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: variant.name,
  // Defaulted to the real values rather than left to the environment.
  //
  // The EAS CLI does not load .env.local the way the Expo CLI does, so running
  // `eas build` in an ordinary shell resolved neither of these. The slug fell
  // back to a placeholder, EAS could not find the linked project, and it
  // silently created a second one under the wrong name. The identity of this
  // app is not configuration — it is a fact — and it is public, so there is
  // nothing gained by sourcing it from an untracked file.
  owner: process.env.EXPO_ACCOUNT_OWNER ?? 'rishabruh',
  slug: process.env.EXPO_PROJECT_SLUG ?? 'kinmap',
  version: '0.1.0',
  orientation: 'portrait',
  icon: './assets/images/icon.png',
  // Two schemes. The variant's own is what deep links use; `kinmap` is what the
  // Cognito app client's CallbackURLs are built from in identity-stack.ts, and
  // the binary has to register it or the hosted UI's redirect is delivered to
  // nothing and Sign in with Apple hangs on a browser that never closes.
  scheme: [variant.scheme, 'kinmap'],
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
      projectId: optional('EAS_PROJECT_ID') ?? '7cfe193d-e29a-404d-a2f2-20f858aa9c32',
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
  // A literal, not { policy: 'appVersion' }.
  //
  // Runtime version policies are only supported in the managed workflow. This
  // project commits ios/ and android/, which makes it bare, and EAS refuses the
  // build outright:
  //
  //   You're currently using the bare workflow, where runtime version policies
  //   are not supported.
  //
  // It tracks `version` above by hand. Both must move together: the runtime
  // version is what decides whether an over-the-air update is compatible with
  // an installed binary, so letting them drift would ship JS to a native build
  // that cannot run it.
  runtimeVersion: '0.1.0',
});

// Referenced so `required` participates in typechecking even while the public
// config is still fully optional during bootstrap.
export { required };
