import {
  AndroidConfig,
  type ConfigPlugin,
  withAndroidManifest,
} from 'expo/config-plugins';

/**
 * Android configuration for the native location engine (spec §9).
 *
 * Permissions themselves are declared in app.config.ts. This plugin registers
 * the components the engine needs — the user-visible foreground service, the
 * geofence receiver, and the boot receiver — plus the Maps API key placeholder.
 *
 * The foreground service is declared with `foregroundServiceType="location"`
 * and is used ONLY for live sessions, which are visible to the person being
 * located. Its notification is never hidden or disguised (spec §9).
 */

const PACKAGE = 'com.familylocation.locationengine';

const withAndroidLocationEngine: ConfigPlugin = (config) => {
  return withAndroidManifest(config, (mod) => {
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(mod.modResults);

    application.service = application.service ?? [];
    application.receiver = application.receiver ?? [];
    application['meta-data'] = application['meta-data'] ?? [];

    const hasService = application.service.some(
      (service) => service.$?.['android:name'] === `${PACKAGE}.LiveSessionService`,
    );
    if (!hasService) {
      application.service.push({
        $: {
          'android:name': `${PACKAGE}.LiveSessionService`,
          'android:exported': 'false',
          'android:foregroundServiceType': 'location',
          // Restarted by the system if killed mid-session so the countdown and
          // the notification stay truthful.
          'android:stopWithTask': 'false',
        } as Record<string, string>,
      });
    }

    const hasGeofenceReceiver = application.receiver.some(
      (receiver) => receiver.$?.['android:name'] === `${PACKAGE}.GeofenceReceiver`,
    );
    if (!hasGeofenceReceiver) {
      application.receiver.push({
        $: {
          'android:name': `${PACKAGE}.GeofenceReceiver`,
          'android:exported': 'false',
        } as Record<string, string>,
      });
    }

    const hasBootReceiver = application.receiver.some(
      (receiver) => receiver.$?.['android:name'] === `${PACKAGE}.BootReceiver`,
    );
    if (!hasBootReceiver) {
      application.receiver.push({
        $: {
          'android:name': `${PACKAGE}.BootReceiver`,
          'android:exported': 'true',
          'android:enabled': 'true',
        } as Record<string, string>,
        'intent-filter': [
          {
            action: [{ $: { 'android:name': 'android.intent.action.BOOT_COMPLETED' } }],
          },
        ],
      } as never);
    }

    // Read from the environment so the key is never committed. Absent in
    // development builds, where the map falls back to the default renderer.
    const mapsKey = process.env.GOOGLE_MAPS_PUBLIC_KEY;
    if (mapsKey) {
      AndroidConfig.Manifest.addMetaDataItemToMainApplication(
        application,
        'com.google.android.geo.API_KEY',
        mapsKey,
      );
    }

    return mod;
  });
};

export default withAndroidLocationEngine;
