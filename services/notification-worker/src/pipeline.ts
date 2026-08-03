import { isVisibleTo, type FamilyMembershipRecord } from '@family/auth';
import type { DeviceId, UserId } from '@family/contracts';
import type { NotificationKind, NotificationPreferences } from '@family/schemas';

import type { NotificationCommand } from './messages.js';
import type {
  DeduplicationStore,
  DeliveryRecord,
  DeliveryRecorder,
  EndpointRegistry,
  EventLoader,
  MembershipReader,
  PreferencesReader,
  PushSender,
  PushTarget,
  RateLimiter,
  RecipientDevice,
} from './ports.js';
import { isWithinQuietHours } from './quiet-hours.js';
import { renderNotification } from './render.js';

/**
 * The delivery pipeline, in the order the spec mandates:
 *
 *   1. load the event
 *   2. load the recipient's preferences
 *   3. RE-VERIFY authorization and membership at send time
 *   4. quiet hours, in the recipient's time zone
 *   5. deduplicate per event + recipient
 *   6. rate limit
 *   7. send
 *   8. record a sanitised delivery result
 *   9. retire a dead endpoint and remove its token
 *
 * Step 3 is the one that cannot move. A notification command is produced by a
 * different Lambda, at a different time, and sits on a queue in between. If
 * membership were checked only at trigger time, a member removed in that window
 * would still receive a push describing where someone is — the exact failure a
 * removal is meant to prevent. So the membership row, the subject's sharing
 * status and the subject's per-member visibility are re-read here, from the
 * table, immediately before anything is rendered.
 *
 * Rendering deliberately happens AFTER step 3 for the same reason: no name, no
 * place, no copy is produced for a recipient who turns out not to be entitled
 * to it.
 */

export type DeliveryStage =
  | 'LOAD_EVENT'
  | 'LOAD_PREFERENCES'
  | 'AUTHORIZE'
  | 'PREFERENCES'
  | 'QUIET_HOURS'
  | 'DEDUPLICATE'
  | 'RATE_LIMIT'
  | 'SEND';

export type DeliveryDisposition =
  | 'DELIVERED'
  | 'EVENT_GONE'
  | 'NO_PROFILE'
  | 'NOT_AUTHORIZED'
  | 'MUTED'
  | 'CHANNEL_DISABLED'
  | 'QUIET_HOURS'
  | 'DUPLICATE'
  | 'RATE_LIMITED'
  | 'NO_DEVICE'
  | 'ENDPOINT_RETIRED'
  | 'RETRYABLE_FAILURE';

export type DeviceDeliveryOutcome = {
  readonly deviceId: DeviceId;
  readonly disposition: 'DELIVERED' | 'ENDPOINT_RETIRED' | 'RETRYABLE_FAILURE';
  readonly reasonCode: string | null;
};

export type DeliveryOutcome = {
  readonly recipientUserId: UserId;
  readonly stage: DeliveryStage;
  readonly disposition: DeliveryDisposition;
  readonly reasonCode: string | null;
  /** True when redelivering the SQS message could still succeed. */
  readonly retryable: boolean;
  readonly devices: readonly DeviceDeliveryOutcome[];
};

export type PipelineDeps = {
  readonly events: EventLoader;
  readonly preferences: PreferencesReader;
  readonly memberships: MembershipReader;
  readonly deduplication: DeduplicationStore;
  readonly rateLimiter: RateLimiter;
  readonly sender: PushSender;
  readonly endpoints: EndpointRegistry;
  readonly recorder: DeliveryRecorder;
  readonly deduplicationTtlSeconds: number;
  readonly rateLimitPerMinute: number;
  readonly newNotificationId: () => string;
  readonly now: () => Date;
};

/**
 * Kinds whose delivery discloses something about where the subject is. These
 * additionally require the subject to be actively sharing and to have not
 * hidden themselves from this particular recipient.
 *
 * SHARING_PAUSED is deliberately absent: telling a family that someone paused
 * is the opposite of a location disclosure, and gating it on SHARING would mean
 * the notice could never be sent.
 */
const LOCATION_DISCLOSING_KINDS: ReadonlySet<NotificationKind> = new Set<NotificationKind>([
  'ARRIVAL',
  'DEPARTURE',
  'LOCATION_STALE',
  'LIVE_SESSION_ACCEPTED',
]);

/** Which preference switch governs each kind. Total, so a new kind will not compile. */
const PREFERENCE_CATEGORY: Record<
  NotificationKind,
  keyof Pick<
    NotificationPreferences,
    | 'arrivals'
    | 'departures'
    | 'liveSessions'
    | 'membership'
    | 'sharingChanges'
    | 'deviceHealth'
    | 'billing'
  >
> = {
  ARRIVAL: 'arrivals',
  DEPARTURE: 'departures',
  LIVE_SESSION_REQUESTED: 'liveSessions',
  LIVE_SESSION_ACCEPTED: 'liveSessions',
  LIVE_SESSION_REJECTED: 'liveSessions',
  LIVE_SESSION_ENDED: 'liveSessions',
  LIVE_SESSION_REFRESH: 'liveSessions',
  MEMBER_JOINED: 'membership',
  MEMBER_LEFT: 'membership',
  INVITATION_ACCEPTED: 'membership',
  SHARING_PAUSED: 'sharingChanges',
  SHARING_RESUMED: 'sharingChanges',
  LOCATION_STALE: 'deviceHealth',
  PERMISSION_LOST: 'deviceHealth',
  BATTERY_CRITICAL: 'deviceHealth',
  SUBSCRIPTION_EXPIRING: 'billing',
};

/**
 * Recipients for a command. An explicit list is honoured as-is; a family-wide
 * command fans out to every ACTIVE member except the subject, who does not need
 * telling where they themselves are.
 *
 * This is a *candidate* list only. Each candidate is independently re-authorised
 * in step 3, so a stale membership read here cannot leak anything.
 */
export async function resolveRecipients(
  command: NotificationCommand,
  memberships: MembershipReader,
): Promise<UserId[]> {
  if (command.recipientUserIds !== null) {
    return [...new Set(command.recipientUserIds)];
  }
  if (command.familyId === null) {
    return [];
  }
  const members = await memberships.listActiveMembers({ familyId: command.familyId });
  const recipients = members
    .filter((member) => member.userId !== command.subjectUserId)
    .map((member) => member.userId);
  return [...new Set(recipients)];
}

export async function deliverNotification(
  command: NotificationCommand,
  deps: PipelineDeps,
): Promise<DeliveryOutcome[]> {
  const recipients = await resolveRecipients(command, deps.memberships);
  const outcomes: DeliveryOutcome[] = [];
  for (const recipientUserId of recipients) {
    outcomes.push(await deliverToRecipient(command, recipientUserId, deps));
  }
  return outcomes;
}

export async function deliverToRecipient(
  command: NotificationCommand,
  recipientUserId: UserId,
  deps: PipelineDeps,
): Promise<DeliveryOutcome> {
  const now = deps.now();

  // --- 1. Load the event -------------------------------------------------
  const event = await deps.events.load(command);
  if (event === null) {
    return await finish(command, recipientUserId, deps, {
      stage: 'LOAD_EVENT',
      disposition: 'EVENT_GONE',
      reasonCode: null,
      retryable: false,
      devices: [],
    });
  }

  // --- 2. Load the recipient's preferences -------------------------------
  const profile = await deps.preferences.load({
    userId: recipientUserId,
    familyId: command.familyId,
  });
  if (profile === null) {
    return await finish(command, recipientUserId, deps, {
      stage: 'LOAD_PREFERENCES',
      disposition: 'NO_PROFILE',
      reasonCode: null,
      retryable: false,
      devices: [],
    });
  }

  // --- 3. Re-verify authorization and membership AT SEND TIME ------------
  const authorized = await isStillAuthorized(command, recipientUserId, deps.memberships);
  if (!authorized) {
    return await finish(command, recipientUserId, deps, {
      stage: 'AUTHORIZE',
      disposition: 'NOT_AUTHORIZED',
      reasonCode: null,
      retryable: false,
      devices: [],
    });
  }

  // --- 3b. The recipient's own switches ----------------------------------
  const preferenceOutcome = evaluatePreferences(command, profile.preferences);
  if (preferenceOutcome !== null) {
    return await finish(command, recipientUserId, deps, {
      stage: 'PREFERENCES',
      disposition: preferenceOutcome,
      reasonCode: null,
      retryable: false,
      devices: [],
    });
  }

  // --- 4. Quiet hours, in the recipient's own time zone ------------------
  if (isWithinQuietHours(profile.preferences.quietHours, now, profile.timeZone)) {
    return await finish(command, recipientUserId, deps, {
      stage: 'QUIET_HOURS',
      disposition: 'QUIET_HOURS',
      reasonCode: null,
      retryable: false,
      devices: [],
    });
  }

  // --- 5. Deduplicate per event + recipient ------------------------------
  const claimed = await deps.deduplication.claim({
    key: deduplicationKey(command, recipientUserId),
    ttlSeconds: deps.deduplicationTtlSeconds,
  });
  if (!claimed) {
    return await finish(command, recipientUserId, deps, {
      stage: 'DEDUPLICATE',
      disposition: 'DUPLICATE',
      reasonCode: null,
      retryable: false,
      devices: [],
    });
  }

  // --- 6. Rate limit -----------------------------------------------------
  const rateLimit = await deps.rateLimiter.consume({
    key: `notification:user:${recipientUserId}`,
    limitPerMinute: deps.rateLimitPerMinute,
  });
  if (!rateLimit.allowed) {
    return await finish(command, recipientUserId, deps, {
      stage: 'RATE_LIMIT',
      disposition: 'RATE_LIMITED',
      reasonCode: null,
      // Dropped, not retried: replaying would burn the deduplication claim and
      // deliver a stale notification minutes later.
      retryable: false,
      devices: [],
    });
  }

  // --- 7. Send -----------------------------------------------------------
  const targets = deliverableDevices(profile.devices);
  if (targets.length === 0) {
    return await finish(command, recipientUserId, deps, {
      stage: 'SEND',
      disposition: 'NO_DEVICE',
      reasonCode: null,
      retryable: false,
      devices: [],
    });
  }

  const rendered = renderNotification({
    command,
    notificationId: deps.newNotificationId(),
    subjectDisplayName: event.subjectDisplayName,
    placeName: event.placeName,
  });

  const deviceOutcomes: DeviceDeliveryOutcome[] = [];
  const retirements: RecipientDevice[] = [];

  for (const device of targets) {
    const target: PushTarget = {
      deviceId: device.deviceId,
      platform: device.platform,
      endpointArn: device.endpointArn,
      pushToken: device.pushToken,
    };

    const outcome = await deps.sender.send({
      target,
      payload: rendered.payload,
      title: rendered.title,
      body: rendered.body,
    });

    if (outcome.status === 'DELIVERED') {
      deviceOutcomes.push({
        deviceId: device.deviceId,
        disposition: 'DELIVERED',
        reasonCode: null,
      });
      continue;
    }
    if (outcome.status === 'INVALID_ENDPOINT') {
      deviceOutcomes.push({
        deviceId: device.deviceId,
        disposition: 'ENDPOINT_RETIRED',
        reasonCode: outcome.reason,
      });
      retirements.push(device);
      continue;
    }
    deviceOutcomes.push({
      deviceId: device.deviceId,
      disposition: 'RETRYABLE_FAILURE',
      reasonCode: outcome.reason,
    });
  }

  const delivered = deviceOutcomes.some((outcome) => outcome.disposition === 'DELIVERED');
  const retryable =
    !delivered && deviceOutcomes.some((outcome) => outcome.disposition === 'RETRYABLE_FAILURE');

  const summary: Omit<DeliveryOutcome, 'recipientUserId'> = {
    stage: 'SEND',
    disposition: delivered ? 'DELIVERED' : retryable ? 'RETRYABLE_FAILURE' : 'ENDPOINT_RETIRED',
    reasonCode: null,
    retryable,
    devices: deviceOutcomes,
  };

  // --- 8. Record the sanitised result ------------------------------------
  const result = await finish(command, recipientUserId, deps, summary);

  // --- 9. Retire dead endpoints and remove their tokens -------------------
  // After recording, so the audit of what happened survives even if the
  // retirement call itself fails.
  for (const device of retirements) {
    if (device.endpointArn !== null) {
      await deps.endpoints.disableEndpoint({ endpointArn: device.endpointArn });
    }
    await deps.endpoints.removeToken({ userId: recipientUserId, deviceId: device.deviceId });
  }

  return result;
}

export function deduplicationKey(command: NotificationCommand, recipientUserId: UserId): string {
  return `notification:${command.kind}:${command.sourceEventId}:${recipientUserId}`;
}

function deliverableDevices(devices: readonly RecipientDevice[]): RecipientDevice[] {
  return devices.filter(
    (device) =>
      device.status === 'ACTIVE' && (device.endpointArn !== null || device.pushToken !== null),
  );
}

function evaluatePreferences(
  command: NotificationCommand,
  preferences: NotificationPreferences,
): 'MUTED' | 'CHANNEL_DISABLED' | null {
  if (command.familyId !== null && preferences.mutedFamilyIds.includes(command.familyId)) {
    return 'MUTED';
  }
  if (command.subjectUserId !== null && preferences.mutedUserIds.includes(command.subjectUserId)) {
    return 'MUTED';
  }
  const category = PREFERENCE_CATEGORY[command.kind];
  return preferences[category].push ? null : 'CHANNEL_DISABLED';
}

/**
 * The send-time authorization check. Reads the membership table directly; no
 * claim from the queue message is trusted, and there is no cache to go stale.
 */
async function isStillAuthorized(
  command: NotificationCommand,
  recipientUserId: UserId,
  memberships: MembershipReader,
): Promise<boolean> {
  if (command.familyId === null) {
    // Account-level notice: only ever sent to an explicitly named recipient.
    return command.recipientUserIds?.includes(recipientUserId) === true;
  }

  const recipientMembership = await memberships.getMembership({
    familyId: command.familyId,
    userId: recipientUserId,
  });
  if (recipientMembership === null || recipientMembership.status !== 'ACTIVE') {
    // Removed, left, blocked or still pending: no notification, no exception,
    // no signal back to the producer about which of those it was.
    return false;
  }

  const subjectUserId = command.subjectUserId;
  if (subjectUserId === null || subjectUserId === recipientUserId) {
    return true;
  }

  const subjectMembership = await memberships.getMembership({
    familyId: command.familyId,
    userId: subjectUserId,
  });
  if (subjectMembership === null || subjectMembership.status !== 'ACTIVE') {
    return false;
  }

  if (!LOCATION_DISCLOSING_KINDS.has(command.kind)) {
    return true;
  }

  return isSharing(subjectMembership) && isVisibleTo(subjectMembership, recipientUserId);
}

function isSharing(membership: FamilyMembershipRecord): boolean {
  return membership.sharingStatus === 'SHARING';
}

/**
 * Step 8. The recorded row is ids, enums and a provider reason code — never a
 * token, an endpoint ARN, a rendered body, or anything derived from a position.
 */
async function finish(
  command: NotificationCommand,
  recipientUserId: UserId,
  deps: PipelineDeps,
  summary: Omit<DeliveryOutcome, 'recipientUserId'>,
): Promise<DeliveryOutcome> {
  const recordedAt = deps.now().toISOString();
  const base = {
    commandId: command.commandId,
    recipientUserId,
    kind: command.kind,
    disposition: summary.disposition,
    stage: summary.stage,
    occurredAt: command.occurredAt,
    recordedAt,
  } as const;

  if (summary.devices.length === 0) {
    const record: DeliveryRecord = { ...base, deviceId: null, reasonCode: summary.reasonCode };
    await deps.recorder.record(record);
  } else {
    for (const device of summary.devices) {
      const record: DeliveryRecord = {
        ...base,
        deviceId: device.deviceId,
        disposition: device.disposition,
        reasonCode: device.reasonCode,
      };
      await deps.recorder.record(record);
    }
  }

  return { recipientUserId, ...summary };
}
