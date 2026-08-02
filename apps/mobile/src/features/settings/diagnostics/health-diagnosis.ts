import { BATTERY, LIMITS, type DeviceLocationHealth } from '@family/contracts';

import {
  APP_SETTINGS,
  appNotificationSettingsLink,
  backgroundRefreshLink,
  batteryOptimizationLink,
  locationServicesLink,
  type SettingsDeepLink,
} from './settings-deep-links';

/**
 * Turns `DeviceLocationHealth` from the native engine into a list of specific,
 * named problems — each with what is wrong, why it matters, and the exact OS
 * setting that fixes it.
 *
 * This module is deliberately pure and platform-parameterised: it takes the
 * platform as an argument rather than reading `Platform.OS`, and it names a
 * deep-link *target* rather than building a link. That keeps the whole
 * symptom → remedy table unit-testable for both platforms in one process, which
 * matters because a wrong remedy here means a user follows instructions that do
 * not fix their problem and concludes the product is broken.
 */

export type DiagnosisPlatform = 'ios' | 'android';

export type DiagnosisSeverity =
  /** Nothing is being shared. The user's family sees a stale or empty card. */
  | 'BLOCKING'
  /** Sharing works, but less accurately, less often, or less visibly. */
  | 'DEGRADED'
  /** Worth knowing, nothing to fix. */
  | 'INFO';

export type DeepLinkTarget =
  | 'APP_SETTINGS'
  | 'LOCATION_SERVICES'
  | 'APP_NOTIFICATIONS'
  | 'BATTERY_OPTIMIZATION'
  | 'BACKGROUND_REFRESH'
  /** Fixed inside the app, not in OS settings. */
  | 'IN_APP'
  | 'NONE';

export type DiagnosisId =
  | 'LOCATION_SERVICES_OFF'
  | 'LOCATION_PERMISSION_NOT_DETERMINED'
  | 'LOCATION_PERMISSION_DENIED'
  | 'LOCATION_PERMISSION_RESTRICTED'
  | 'WHEN_IN_USE_ONLY'
  | 'BACKGROUND_LOCATION_MISSING'
  | 'FOREGROUND_SERVICE_PERMISSION_MISSING'
  | 'NOTIFICATIONS_OFF'
  | 'BACKGROUND_REFRESH_OFF'
  | 'BATTERY_OPTIMIZATION_ACTIVE'
  | 'PRECISE_LOCATION_OFF'
  | 'QUEUE_FULL'
  | 'STALE_QUEUE'
  | 'DEVICE_OFFLINE'
  | 'UPLOAD_FAILING'
  | 'CRITICAL_BATTERY'
  | 'LOW_POWER_MODE'
  | 'SHARING_TURNED_OFF';

export type Diagnosis = {
  id: DiagnosisId;
  severity: DiagnosisSeverity;
  /** Short label for the row. */
  title: string;
  /** What is actually wrong, in the user's terms. */
  explanation: string;
  /** What it costs them right now. */
  consequence: string;
  /** Tap-by-tap path in the OS settings app, exactly as it is labelled there. */
  steps: readonly string[];
  actionLabel: string;
  deepLinkTarget: DeepLinkTarget;
};

/**
 * Points sitting in the on-device queue for longer than this mean uploads are
 * not happening, whatever the reported tracking state says. Well under
 * `LIMITS.MAX_QUEUE_AGE_HOURS`, so the user is told before anything is dropped.
 */
export const STALE_QUEUE_AFTER_MINUTES = 60;

/** The queue is treated as at risk before it is literally full. */
export const QUEUE_FULL_RATIO = 0.9;

const SEVERITY_RANK: Record<DiagnosisSeverity, number> = {
  BLOCKING: 0,
  DEGRADED: 1,
  INFO: 2,
};

export type DiagnosisContext = {
  platform: DiagnosisPlatform;
  now?: Date;
};

/**
 * Evaluates every known symptom against one health snapshot.
 *
 * Order of the returned list is stable: blocking problems first, and within a
 * severity the order of the checks below, which runs from "nothing works at
 * all" to "this is only a detail".
 */
export function diagnoseLocationHealth(
  health: DeviceLocationHealth,
  context: DiagnosisContext,
): Diagnosis[] {
  const { platform } = context;
  const now = context.now ?? new Date();
  const isIos = platform === 'ios';
  const { permission } = health;
  const found: Diagnosis[] = [];

  // -- Nothing can work: the OS location stack is off ----------------------
  if (!permission.locationServicesEnabled) {
    found.push({
      id: 'LOCATION_SERVICES_OFF',
      severity: 'BLOCKING',
      title: 'Location Services are turned off',
      explanation:
        'Location is switched off for the whole device, not just for this app. No app can determine where this phone is.',
      consequence: 'Your family sees your last known position, and it will not update.',
      steps: isIos
        ? [
            'Open the Settings app.',
            'Tap Privacy & Security.',
            'Tap Location Services.',
            'Turn Location Services on.',
          ]
        : [
            'Open Location settings.',
            'Turn Use location on.',
            'Under Location services, make sure Google Location Accuracy is on.',
          ],
      actionLabel: isIos ? 'Open Settings' : 'Open location settings',
      deepLinkTarget: 'LOCATION_SERVICES',
    });
  }

  // -- Permission ----------------------------------------------------------
  switch (permission.authorization) {
    case 'NOT_DETERMINED':
      found.push({
        id: 'LOCATION_PERMISSION_NOT_DETERMINED',
        severity: 'BLOCKING',
        title: 'We have not asked for location permission yet',
        explanation:
          'This app has never been granted access to your location, so nothing is being collected.',
        consequence: 'You are not sharing with anyone, and no location is stored.',
        steps: ['Tap the button below and choose Allow when the system asks.'],
        actionLabel: 'Ask for permission',
        deepLinkTarget: 'IN_APP',
      });
      break;

    case 'DENIED':
      found.push({
        id: 'LOCATION_PERMISSION_DENIED',
        severity: 'BLOCKING',
        title: 'Location access is denied for this app',
        explanation:
          'You previously declined location access. The system will not ask again, so it has to be changed in Settings.',
        consequence: 'Nothing is collected and nothing is shared.',
        steps: isIos
          ? [
              'Open the Settings app.',
              'Find this app in the list and tap it.',
              'Tap Location.',
              'Choose Always.',
            ]
          : ['Open App info.', 'Tap Permissions, then Location.', 'Choose Allow all the time.'],
        actionLabel: 'Open app settings',
        deepLinkTarget: 'APP_SETTINGS',
      });
      break;

    case 'RESTRICTED':
      found.push({
        id: 'LOCATION_PERMISSION_RESTRICTED',
        severity: 'BLOCKING',
        title: 'Location access is blocked by a device restriction',
        explanation: isIos
          ? 'Screen Time or a device management profile is preventing location access. This is set outside the app and we cannot change it.'
          : 'A device management policy or a restricted profile is preventing location access. This is set outside the app and we cannot change it.',
        consequence: 'Nothing is collected and nothing is shared.',
        steps: isIos
          ? [
              'Open the Settings app.',
              'Tap Screen Time, then Content & Privacy Restrictions.',
              'Tap Location Services and allow changes.',
              'If your device is managed by an organisation, ask whoever manages it.',
            ]
          : [
              'Open Settings.',
              'Check Digital Wellbeing or your work profile settings.',
              'If your device is managed by an organisation, ask whoever manages it.',
            ],
        actionLabel: 'Open Settings',
        deepLinkTarget: 'APP_SETTINGS',
      });
      break;

    case 'WHEN_IN_USE':
      found.push({
        id: 'WHEN_IN_USE_ONLY',
        severity: 'BLOCKING',
        title: 'Location is only allowed while the app is open',
        explanation: isIos
          ? 'This app is set to "While Using the App". Background sharing needs "Always", which iOS only offers once you have used the app for a while.'
          : 'This app is set to "Allow only while using the app". Background sharing needs "Allow all the time".',
        consequence:
          'Your position updates only while you have this app open on screen. The moment you switch away, your family stops seeing you move.',
        steps: isIos
          ? [
              'Open the Settings app.',
              'Find this app in the list and tap it.',
              'Tap Location.',
              'Choose Always.',
            ]
          : ['Open App info.', 'Tap Permissions, then Location.', 'Choose Allow all the time.'],
        actionLabel: 'Open app settings',
        deepLinkTarget: 'APP_SETTINGS',
      });
      break;

    case 'ALWAYS':
      break;

    default:
      break;
  }

  // -- Background execution ------------------------------------------------
  // The same contract field means different things per platform: iOS Background
  // App Refresh, Android's separate background-location grant.
  if (!permission.backgroundRefreshEnabled) {
    if (isIos) {
      found.push({
        id: 'BACKGROUND_REFRESH_OFF',
        severity: 'DEGRADED',
        title: 'Background App Refresh is off',
        explanation:
          'iOS will not let this app do scheduled work in the background, so queued updates are only sent when you open the app.',
        consequence:
          'Your position still updates when you move a long way, but it can lag by a long time, and anything waiting to upload sits on the phone.',
        steps: [
          'Open the Settings app.',
          'Find this app in the list and tap it.',
          'Turn Background App Refresh on.',
          'If it is greyed out, go to Settings > General > Background App Refresh and turn it on there first.',
        ],
        actionLabel: 'Open app settings',
        deepLinkTarget: 'BACKGROUND_REFRESH',
      });
    } else {
      found.push({
        id: 'BACKGROUND_LOCATION_MISSING',
        severity: 'BLOCKING',
        title: 'Background location is not allowed',
        explanation:
          'Android grants background location separately from foreground location. This app has the foreground grant but not the background one.',
        consequence:
          'Your position updates only while the app is on screen. Nothing is shared once you switch away or lock the phone.',
        steps: ['Open App info.', 'Tap Permissions, then Location.', 'Choose Allow all the time.'],
        actionLabel: 'Open app settings',
        deepLinkTarget: 'APP_SETTINGS',
      });
    }
  }

  // -- Android foreground service -----------------------------------------
  if (!isIos && permission.foregroundServicePermissionGranted === false) {
    found.push({
      id: 'FOREGROUND_SERVICE_PERMISSION_MISSING',
      severity: 'BLOCKING',
      title: 'The location service cannot start',
      explanation:
        'Android requires a foreground-service permission to keep a location service running, and this app does not currently have it.',
      consequence:
        'Background sharing cannot start at all. Android stops the service as soon as the app leaves the screen.',
      steps: [
        'Open App info.',
        'Tap Permissions and allow everything listed under Location.',
        'If the problem stays, reinstalling the app re-requests the permission.',
      ],
      actionLabel: 'Open app settings',
      deepLinkTarget: 'APP_SETTINGS',
    });
  }

  // -- Notifications -------------------------------------------------------
  // On Android this is a consent problem, not a convenience one: the ongoing
  // notification is how the person being located can SEE that sharing is on.
  // Without it we would be running a hidden background service, which this
  // product does not do.
  if (!permission.notificationsEnabled) {
    found.push({
      id: 'NOTIFICATIONS_OFF',
      severity: isIos ? 'DEGRADED' : 'BLOCKING',
      title: 'Notifications are turned off',
      explanation: isIos
        ? 'This app cannot send you notifications, so arrival alerts and requests to follow you live will not reach you.'
        : 'Android shows an ongoing notification whenever this app is using your location in the background. With notifications off, that notice cannot be shown — so background sharing stays off. We do not run location tracking you cannot see.',
      consequence: isIos
        ? 'You will miss arrival and departure alerts, live-location requests, and warnings that sharing has stopped.'
        : 'Background sharing will not run, and you will miss arrival alerts and live-location requests.',
      steps: isIos
        ? [
            'Open the Settings app.',
            'Find this app in the list and tap it.',
            'Tap Notifications.',
            'Turn Allow Notifications on.',
          ]
        : [
            'Open notification settings for this app.',
            'Turn All notifications on.',
            'Make sure the Location sharing channel is on — that is the ongoing notice.',
          ],
      actionLabel: 'Open notification settings',
      deepLinkTarget: 'APP_NOTIFICATIONS',
    });
  }

  // -- Android battery optimisation ---------------------------------------
  if (!isIos && permission.batteryOptimizationIgnored === false) {
    found.push({
      id: 'BATTERY_OPTIMIZATION_ACTIVE',
      severity: 'DEGRADED',
      title: 'Battery optimisation is restricting this app',
      explanation:
        'Your phone is allowed to put this app to sleep to save battery. Many manufacturers do this aggressively, and it is the single most common reason location stops updating on Android.',
      consequence:
        'Your position can freeze for hours at a time, and updates arrive in a burst when you next open the app.',
      steps: [
        'Open battery optimisation settings.',
        'Find this app in the list.',
        "Choose Don't optimise (or Unrestricted).",
        'On Samsung, Xiaomi, OPPO, OnePlus and Huawei devices, also add this app to the protected or auto-start list in the manufacturer battery settings.',
      ],
      actionLabel: 'Open battery settings',
      deepLinkTarget: 'BATTERY_OPTIMIZATION',
    });
  }

  // -- Accuracy ------------------------------------------------------------
  if (!permission.preciseLocationEnabled) {
    found.push({
      id: 'PRECISE_LOCATION_OFF',
      severity: 'DEGRADED',
      title: 'Precise location is off',
      explanation: isIos
        ? 'iOS is giving this app an approximate area instead of an exact position.'
        : 'Android is giving this app an approximate area instead of an exact position.',
      consequence:
        'Your family sees roughly the right neighbourhood, not where you actually are, and arrival alerts for saved places will be unreliable.',
      steps: isIos
        ? [
            'Open the Settings app.',
            'Find this app in the list and tap it.',
            'Tap Location.',
            'Turn Precise Location on.',
          ]
        : ['Open App info.', 'Tap Permissions, then Location.', 'Turn Use precise location on.'],
      actionLabel: 'Open app settings',
      deepLinkTarget: 'APP_SETTINGS',
    });
  }

  // -- The upload queue ----------------------------------------------------
  const queueCeiling = Math.floor(LIMITS.MAX_QUEUED_EVENTS * QUEUE_FULL_RATIO);
  if (health.pendingEventCount >= queueCeiling) {
    found.push({
      id: 'QUEUE_FULL',
      severity: 'BLOCKING',
      title: 'This phone has run out of room to store updates',
      explanation: `There are ${health.pendingEventCount} updates waiting to be sent, which is at this device's limit of ${LIMITS.MAX_QUEUED_EVENTS}.`,
      consequence:
        'The oldest updates are being discarded to make room, and your family is seeing an out-of-date position.',
      steps: [
        'Connect to Wi-Fi or mobile data.',
        'Tap Try sending now below.',
        'If this keeps happening, sign out and back in on this device.',
      ],
      actionLabel: 'Try sending now',
      deepLinkTarget: 'IN_APP',
    });
  } else if (isQueueStale(health, now)) {
    found.push({
      id: 'STALE_QUEUE',
      severity: 'DEGRADED',
      title: 'Updates are waiting to be sent',
      explanation: `${health.pendingEventCount} update${health.pendingEventCount === 1 ? '' : 's'} recorded on this phone ${health.pendingEventCount === 1 ? 'has' : 'have'} not reached our servers yet.`,
      consequence: 'Your family is seeing an older position than the one this phone has recorded.',
      steps: [
        'Check that you have a working connection.',
        'Tap Try sending now below.',
        `Updates older than ${LIMITS.MAX_QUEUE_AGE_HOURS} hours are discarded rather than sent late.`,
      ],
      actionLabel: 'Try sending now',
      deepLinkTarget: 'IN_APP',
    });
  }

  // -- Connectivity --------------------------------------------------------
  if (health.trackingState === 'OFFLINE') {
    found.push({
      id: 'DEVICE_OFFLINE',
      severity: 'DEGRADED',
      title: 'This phone is offline',
      explanation:
        'The app cannot reach our servers. Your position is still being recorded on the phone and will be sent when the connection comes back.',
      consequence: 'Your family sees your last position from before you went offline.',
      steps: [
        'Turn off Airplane Mode if it is on.',
        'Connect to Wi-Fi or turn mobile data on.',
        'If you are on a restricted network, check that it is not blocking the app.',
      ],
      actionLabel: 'Try sending now',
      deepLinkTarget: 'IN_APP',
    });
  } else if (health.lastUploadError !== null) {
    found.push({
      id: 'UPLOAD_FAILING',
      severity: 'DEGRADED',
      title: 'The last upload did not go through',
      explanation:
        'The phone reached the network but the update was not accepted. This usually clears by itself on the next attempt.',
      consequence: 'Your position may be a few minutes behind.',
      steps: [
        'Tap Try sending now below.',
        'If it keeps failing, check for an app update.',
        'If it still fails, contact support and quote the reason shown below.',
      ],
      actionLabel: 'Try sending now',
      deepLinkTarget: 'IN_APP',
    });
  }

  // -- Battery -------------------------------------------------------------
  const battery = health.batteryLevel;
  if (
    health.trackingState === 'CRITICAL_BATTERY' ||
    (battery !== null && battery <= BATTERY.CRITICAL_THRESHOLD)
  ) {
    found.push({
      id: 'CRITICAL_BATTERY',
      severity: 'DEGRADED',
      title: 'Battery is critically low',
      explanation:
        'To avoid being the reason your phone dies, the app has cut location updates back to the bare minimum.',
      consequence: 'Your position updates far less often until the phone is charged.',
      steps: ['Charge the phone. Normal updates resume automatically.'],
      actionLabel: 'Dismiss',
      deepLinkTarget: 'NONE',
    });
  } else if (health.isLowPowerMode) {
    found.push({
      id: 'LOW_POWER_MODE',
      severity: 'INFO',
      title: isIos ? 'Low Power Mode is on' : 'Battery Saver is on',
      explanation:
        'The system is limiting background work across the whole phone, including this app.',
      consequence: 'Your position updates less often than usual.',
      steps: isIos
        ? ['Open Settings > Battery and turn Low Power Mode off.']
        : ['Open Settings > Battery and turn Battery Saver off.'],
      actionLabel: 'Open Settings',
      deepLinkTarget: 'APP_SETTINGS',
    });
  }

  // -- The user's own choice ----------------------------------------------
  if (health.trackingState === 'DISABLED') {
    found.push({
      id: 'SHARING_TURNED_OFF',
      severity: 'INFO',
      title: 'You have turned sharing off',
      explanation:
        'This is your setting, not a problem. Nothing is being collected on this phone and nobody can see where you are.',
      consequence: 'No location is recorded, stored or shared.',
      steps: ['Turn sharing back on from the Location sharing screen whenever you want to.'],
      actionLabel: 'Go to Location sharing',
      deepLinkTarget: 'IN_APP',
    });
  }

  return found.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

/** True when points have been sitting in the on-device queue too long. */
export function isQueueStale(health: DeviceLocationHealth, now: Date = new Date()): boolean {
  if (health.pendingEventCount <= 0) return false;
  if (!health.oldestPendingEventAt) return false;

  const oldest = Date.parse(health.oldestPendingEventAt);
  if (Number.isNaN(oldest)) return false;

  return now.getTime() - oldest >= STALE_QUEUE_AFTER_MINUTES * 60_000;
}

export type HealthSummary = {
  status: 'HEALTHY' | 'DEGRADED' | 'BLOCKED';
  headline: string;
  detail: string;
};

/** One-line verdict for the top of the troubleshooting screen. */
export function summariseHealth(diagnoses: readonly Diagnosis[]): HealthSummary {
  const blocking = diagnoses.filter((item) => item.severity === 'BLOCKING');
  if (blocking.length > 0) {
    return {
      status: 'BLOCKED',
      headline: 'Sharing is not working',
      detail:
        blocking.length === 1
          ? 'One setting on this phone is stopping location sharing.'
          : `${blocking.length} settings on this phone are stopping location sharing.`,
    };
  }

  const degraded = diagnoses.filter((item) => item.severity === 'DEGRADED');
  if (degraded.length > 0) {
    return {
      status: 'DEGRADED',
      headline: 'Sharing is working, but not well',
      detail:
        degraded.length === 1
          ? 'One setting is making your position less accurate or less current.'
          : `${degraded.length} settings are making your position less accurate or less current.`,
    };
  }

  return {
    status: 'HEALTHY',
    headline: 'Everything is set up correctly',
    detail: 'This phone can share your location as you have asked it to.',
  };
}

/** Resolves a platform-neutral target into a concrete OS deep link. */
export function resolveDeepLink(target: DeepLinkTarget): SettingsDeepLink | null {
  switch (target) {
    case 'APP_SETTINGS':
      return APP_SETTINGS;
    case 'LOCATION_SERVICES':
      return locationServicesLink();
    case 'APP_NOTIFICATIONS':
      return appNotificationSettingsLink();
    case 'BATTERY_OPTIMIZATION':
      return batteryOptimizationLink();
    case 'BACKGROUND_REFRESH':
      return backgroundRefreshLink();
    case 'IN_APP':
    case 'NONE':
      return null;
    default:
      return null;
  }
}
