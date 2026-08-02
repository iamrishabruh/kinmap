import { beforeEach, describe, expect, it } from 'vitest';

import type { FamilyMembershipRecord } from '@family/auth';
import type { DeviceId, FamilyId, UserId } from '@family/contracts';
import type { NotificationPreferences } from '@family/schemas';
import { NotificationPreferencesSchema } from '@family/schemas';

import { NotificationCommandSchema, type NotificationCommand } from '../src/messages.js';
import { deliverNotification, deliverToRecipient, type PipelineDeps } from '../src/pipeline.js';
import type {
  DeduplicationStore,
  DeliveryRecord,
  DeliveryRecorder,
  EndpointRegistry,
  EventLoader,
  MembershipReader,
  NotificationEvent,
  PreferencesReader,
  PushSendOutcome,
  PushSender,
  RateLimiter,
  RecipientDevice,
  RecipientProfile,
} from '../src/ports.js';

const FAMILY_ID = '33333333-3333-4333-8333-333333333333' as FamilyId;
const SUBJECT_ID = '11111111-1111-4111-8111-111111111111' as UserId;
const RECIPIENT_ID = '55555555-5555-4555-8555-555555555555' as UserId;
const OTHER_RECIPIENT_ID = '66666666-6666-4666-8666-666666666666' as UserId;
const PLACE_ID = '22222222-2222-4222-8222-222222222222' as PlaceIdLike;
const DEVICE_ID = '77777777-7777-4777-8777-777777777777' as DeviceId;
const EVENT_ID = '99999999-9999-4999-8999-999999999999';

type PlaceIdLike = string & { readonly __brand?: 'PlaceId' };

const NOW = new Date('2026-06-01T12:00:00.000Z');

function makeCommand(overrides: Partial<NotificationCommand> = {}): NotificationCommand {
  return NotificationCommandSchema.parse({
    commandId: '44444444-4444-4444-8444-444444444444',
    kind: 'ARRIVAL',
    familyId: FAMILY_ID,
    subjectUserId: SUBJECT_ID,
    recipientUserIds: null,
    placeId: PLACE_ID,
    transition: 'ARRIVAL',
    liveSessionId: null,
    occurredAt: '2026-06-01T11:59:00.000Z',
    sourceEventId: EVENT_ID,
    ...overrides,
  });
}

function membership(overrides: Partial<FamilyMembershipRecord> = {}): FamilyMembershipRecord {
  return {
    familyId: FAMILY_ID,
    userId: RECIPIENT_ID,
    role: 'MEMBER',
    status: 'ACTIVE',
    sharingStatus: 'SHARING',
    visibleToUserIds: null,
    hiddenFromUserIds: [],
    ...overrides,
  };
}

function preferences(overrides: Partial<NotificationPreferences> = {}): NotificationPreferences {
  const on = { push: true, inApp: true };
  return NotificationPreferencesSchema.parse({
    userId: RECIPIENT_ID,
    arrivals: on,
    departures: on,
    liveSessions: on,
    membership: on,
    sharingChanges: on,
    deviceHealth: on,
    billing: on,
    quietHours: { enabled: false, startMinuteOfDay: 0, endMinuteOfDay: 0 },
    mutedFamilyIds: [],
    mutedUserIds: [],
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  });
}

const activeDevice: RecipientDevice = {
  deviceId: DEVICE_ID,
  platform: 'IOS',
  status: 'ACTIVE',
  endpointArn: 'arn:aws:sns:us-east-1:000000000000:endpoint/APNS/kinmap/abc',
  pushToken: null,
};

class FakeEvents implements EventLoader {
  missing = false;
  calls = 0;
  load(command: NotificationCommand): Promise<NotificationEvent | null> {
    this.calls += 1;
    if (this.missing) return Promise.resolve(null);
    return Promise.resolve({ command, subjectDisplayName: 'Ana', placeName: 'Home' });
  }
}

class FakePreferences implements PreferencesReader {
  profile: RecipientProfile | null = {
    userId: RECIPIENT_ID,
    preferences: preferences(),
    timeZone: 'UTC',
    devices: [activeDevice],
  };
  load(): Promise<RecipientProfile | null> {
    return Promise.resolve(this.profile);
  }
}

class FakeMemberships implements MembershipReader {
  rows = new Map<string, FamilyMembershipRecord>();
  activeMembers: FamilyMembershipRecord[] = [];

  set(record: FamilyMembershipRecord): void {
    this.rows.set(`${record.familyId}#${record.userId}`, record);
  }

  getMembership(input: {
    familyId: FamilyId;
    userId: UserId;
  }): Promise<FamilyMembershipRecord | null> {
    return Promise.resolve(this.rows.get(`${input.familyId}#${input.userId}`) ?? null);
  }

  listActiveMembers(): Promise<FamilyMembershipRecord[]> {
    return Promise.resolve(this.activeMembers);
  }
}

class FakeDeduplication implements DeduplicationStore {
  readonly claimed = new Set<string>();
  claim(input: { key: string; ttlSeconds: number }): Promise<boolean> {
    if (this.claimed.has(input.key)) return Promise.resolve(false);
    this.claimed.add(input.key);
    return Promise.resolve(true);
  }
}

class FakeRateLimiter implements RateLimiter {
  allowed = true;
  consumed: string[] = [];
  consume(input: { key: string; limitPerMinute: number }): Promise<{ allowed: boolean }> {
    this.consumed.push(input.key);
    return Promise.resolve({ allowed: this.allowed });
  }
}

class FakeSender implements PushSender {
  outcome: PushSendOutcome = { status: 'DELIVERED', providerMessageId: 'mid-1' };
  sends = 0;
  send(): Promise<PushSendOutcome> {
    this.sends += 1;
    return Promise.resolve(this.outcome);
  }
}

class FakeEndpoints implements EndpointRegistry {
  disabled: string[] = [];
  removed: Array<{ userId: UserId; deviceId: DeviceId }> = [];
  disableEndpoint(input: { endpointArn: string }): Promise<void> {
    this.disabled.push(input.endpointArn);
    return Promise.resolve();
  }
  removeToken(input: { userId: UserId; deviceId: DeviceId }): Promise<void> {
    this.removed.push(input);
    return Promise.resolve();
  }
}

class FakeRecorder implements DeliveryRecorder {
  readonly records: DeliveryRecord[] = [];
  record(result: DeliveryRecord): Promise<void> {
    this.records.push(result);
    return Promise.resolve();
  }
}

describe('notification delivery pipeline', () => {
  let events: FakeEvents;
  let prefs: FakePreferences;
  let memberships: FakeMemberships;
  let deduplication: FakeDeduplication;
  let rateLimiter: FakeRateLimiter;
  let sender: FakeSender;
  let endpoints: FakeEndpoints;
  let recorder: FakeRecorder;
  let deps: PipelineDeps;

  beforeEach(() => {
    events = new FakeEvents();
    prefs = new FakePreferences();
    memberships = new FakeMemberships();
    deduplication = new FakeDeduplication();
    rateLimiter = new FakeRateLimiter();
    sender = new FakeSender();
    endpoints = new FakeEndpoints();
    recorder = new FakeRecorder();

    memberships.set(membership({ userId: RECIPIENT_ID }));
    memberships.set(membership({ userId: SUBJECT_ID }));

    deps = {
      events,
      preferences: prefs,
      memberships,
      deduplication,
      rateLimiter,
      sender,
      endpoints,
      recorder,
      deduplicationTtlSeconds: 3600,
      rateLimitPerMinute: 20,
      newNotificationId: () => '88888888-8888-4888-8888-888888888888',
      now: () => NOW,
    };
  });

  it('delivers to an authorised, unmuted, awake recipient and records the result', async () => {
    const outcome = await deliverToRecipient(makeCommand(), RECIPIENT_ID, deps);

    expect(outcome.disposition).toBe('DELIVERED');
    expect(sender.sends).toBe(1);
    expect(recorder.records).toHaveLength(1);

    const record = recorder.records[0];
    expect(record?.recipientUserId).toBe(RECIPIENT_ID);
    expect(record?.deviceId).toBe(DEVICE_ID);
    // Sanitised: no token, no endpoint ARN, no rendered copy.
    expect(JSON.stringify(record)).not.toContain('arn:aws:sns');
    expect(JSON.stringify(record)).not.toContain('Ana');
  });

  describe('step 3 — re-verification at send time', () => {
    it('does NOT deliver to a member removed after the command was queued', async () => {
      memberships.set(membership({ userId: RECIPIENT_ID, status: 'REMOVED' }));

      const outcome = await deliverToRecipient(makeCommand(), RECIPIENT_ID, deps);

      expect(outcome.stage).toBe('AUTHORIZE');
      expect(outcome.disposition).toBe('NOT_AUTHORIZED');
      expect(sender.sends).toBe(0);
      // Nothing was rendered, so nothing about the subject reached the record.
      expect(recorder.records[0]?.disposition).toBe('NOT_AUTHORIZED');
    });

    it('does not deliver to someone whose membership row has vanished', async () => {
      memberships.rows.delete(`${FAMILY_ID}#${RECIPIENT_ID}`);

      const outcome = await deliverToRecipient(makeCommand(), RECIPIENT_ID, deps);

      expect(outcome.disposition).toBe('NOT_AUTHORIZED');
      expect(sender.sends).toBe(0);
    });

    it('suppresses a location disclosure once the subject pauses sharing', async () => {
      memberships.set(membership({ userId: SUBJECT_ID, sharingStatus: 'PAUSED' }));

      const outcome = await deliverToRecipient(makeCommand(), RECIPIENT_ID, deps);

      expect(outcome.disposition).toBe('NOT_AUTHORIZED');
      expect(sender.sends).toBe(0);
    });

    it('honours the subject´s per-member visibility choice', async () => {
      memberships.set(membership({ userId: SUBJECT_ID, hiddenFromUserIds: [RECIPIENT_ID] }));

      const outcome = await deliverToRecipient(makeCommand(), RECIPIENT_ID, deps);

      expect(outcome.disposition).toBe('NOT_AUTHORIZED');
    });

    it('still delivers a sharing-paused notice, which is not a location disclosure', async () => {
      memberships.set(membership({ userId: SUBJECT_ID, sharingStatus: 'PAUSED' }));

      const outcome = await deliverToRecipient(
        makeCommand({ kind: 'SHARING_PAUSED', placeId: null, transition: null }),
        RECIPIENT_ID,
        deps,
      );

      expect(outcome.disposition).toBe('DELIVERED');
    });

    it('runs before quiet hours, deduplication, rate limiting and sending', async () => {
      memberships.set(membership({ userId: RECIPIENT_ID, status: 'LEFT' }));

      await deliverToRecipient(makeCommand(), RECIPIENT_ID, deps);

      expect(deduplication.claimed.size).toBe(0);
      expect(rateLimiter.consumed).toHaveLength(0);
      expect(sender.sends).toBe(0);
    });
  });

  describe('step 1 — the event must still exist', () => {
    it('sends nothing when the underlying event is gone', async () => {
      events.missing = true;

      const outcome = await deliverToRecipient(makeCommand(), RECIPIENT_ID, deps);

      expect(outcome.stage).toBe('LOAD_EVENT');
      expect(outcome.disposition).toBe('EVENT_GONE');
      expect(sender.sends).toBe(0);
    });
  });

  describe('step 2/3b — the recipient´s own switches', () => {
    it('respects a muted family', async () => {
      prefs.profile = {
        userId: RECIPIENT_ID,
        preferences: preferences({ mutedFamilyIds: [FAMILY_ID] }),
        timeZone: 'UTC',
        devices: [activeDevice],
      };

      const outcome = await deliverToRecipient(makeCommand(), RECIPIENT_ID, deps);

      expect(outcome.disposition).toBe('MUTED');
      expect(sender.sends).toBe(0);
    });

    it('respects a muted individual', async () => {
      prefs.profile = {
        userId: RECIPIENT_ID,
        preferences: preferences({ mutedUserIds: [SUBJECT_ID] }),
        timeZone: 'UTC',
        devices: [activeDevice],
      };

      expect((await deliverToRecipient(makeCommand(), RECIPIENT_ID, deps)).disposition).toBe(
        'MUTED',
      );
    });

    it('respects a disabled channel for that kind only', async () => {
      prefs.profile = {
        userId: RECIPIENT_ID,
        preferences: preferences({ arrivals: { push: false, inApp: true } }),
        timeZone: 'UTC',
        devices: [activeDevice],
      };

      expect((await deliverToRecipient(makeCommand(), RECIPIENT_ID, deps)).disposition).toBe(
        'CHANNEL_DISABLED',
      );
      expect(
        (
          await deliverToRecipient(
            makeCommand({ kind: 'DEPARTURE', transition: 'DEPARTURE' }),
            RECIPIENT_ID,
            deps,
          )
        ).disposition,
      ).toBe('DELIVERED');
    });
  });

  describe('step 4 — quiet hours', () => {
    it('suppresses during the recipient´s local quiet window', async () => {
      prefs.profile = {
        userId: RECIPIENT_ID,
        preferences: preferences({
          quietHours: { enabled: true, startMinuteOfDay: 11 * 60, endMinuteOfDay: 13 * 60 },
        }),
        timeZone: 'UTC',
        devices: [activeDevice],
      };

      const outcome = await deliverToRecipient(makeCommand(), RECIPIENT_ID, deps);

      expect(outcome.stage).toBe('QUIET_HOURS');
      expect(sender.sends).toBe(0);
    });

    it('delivers when the same window falls outside the recipient´s zone', async () => {
      prefs.profile = {
        userId: RECIPIENT_ID,
        preferences: preferences({
          quietHours: { enabled: true, startMinuteOfDay: 11 * 60, endMinuteOfDay: 13 * 60 },
        }),
        // 12:00Z is 05:00 in Los Angeles: outside the 11:00-13:00 local window.
        timeZone: 'America/Los_Angeles',
        devices: [activeDevice],
      };

      expect((await deliverToRecipient(makeCommand(), RECIPIENT_ID, deps)).disposition).toBe(
        'DELIVERED',
      );
    });
  });

  describe('step 5 — deduplication per event and recipient', () => {
    it('sends once for a redelivered command', async () => {
      const command = makeCommand();

      expect((await deliverToRecipient(command, RECIPIENT_ID, deps)).disposition).toBe('DELIVERED');
      const replay = await deliverToRecipient(command, RECIPIENT_ID, deps);

      expect(replay.stage).toBe('DEDUPLICATE');
      expect(replay.disposition).toBe('DUPLICATE');
      expect(sender.sends).toBe(1);
    });

    it('scopes the claim to the recipient, so a second member still gets theirs', async () => {
      const command = makeCommand();
      await deliverToRecipient(command, RECIPIENT_ID, deps);

      memberships.set(membership({ userId: OTHER_RECIPIENT_ID }));
      const outcome = await deliverToRecipient(command, OTHER_RECIPIENT_ID, deps);

      expect(outcome.disposition).toBe('DELIVERED');
      expect(sender.sends).toBe(2);
    });
  });

  describe('step 6 — rate limiting', () => {
    it('drops the notification without retrying when the recipient is over quota', async () => {
      rateLimiter.allowed = false;

      const outcome = await deliverToRecipient(makeCommand(), RECIPIENT_ID, deps);

      expect(outcome.stage).toBe('RATE_LIMIT');
      expect(outcome.retryable).toBe(false);
      expect(sender.sends).toBe(0);
    });
  });

  describe('steps 7-9 — sending and endpoint hygiene', () => {
    it('retires the endpoint and removes the token when the provider rejects it', async () => {
      sender.outcome = { status: 'INVALID_ENDPOINT', reason: 'EndpointDisabledException' };

      const outcome = await deliverToRecipient(makeCommand(), RECIPIENT_ID, deps);

      expect(outcome.disposition).toBe('ENDPOINT_RETIRED');
      expect(outcome.retryable).toBe(false);
      expect(endpoints.disabled).toEqual([activeDevice.endpointArn]);
      expect(endpoints.removed).toEqual([{ userId: RECIPIENT_ID, deviceId: DEVICE_ID }]);
      // Recorded before the retirement, so the trail survives a failed teardown.
      expect(recorder.records[0]?.disposition).toBe('ENDPOINT_RETIRED');
      expect(recorder.records[0]?.reasonCode).toBe('EndpointDisabledException');
    });

    it('asks for a retry on a transient provider failure', async () => {
      sender.outcome = { status: 'RETRYABLE', reason: 'ThrottlingException' };

      const outcome = await deliverToRecipient(makeCommand(), RECIPIENT_ID, deps);

      expect(outcome.disposition).toBe('RETRYABLE_FAILURE');
      expect(outcome.retryable).toBe(true);
      expect(endpoints.disabled).toHaveLength(0);
    });

    it('does not attempt delivery to a revoked device', async () => {
      prefs.profile = {
        userId: RECIPIENT_ID,
        preferences: preferences(),
        timeZone: 'UTC',
        devices: [{ ...activeDevice, status: 'REVOKED' }],
      };

      const outcome = await deliverToRecipient(makeCommand(), RECIPIENT_ID, deps);

      expect(outcome.disposition).toBe('NO_DEVICE');
      expect(sender.sends).toBe(0);
    });
  });

  describe('fan-out', () => {
    it('addresses every active member except the subject', async () => {
      memberships.activeMembers = [
        membership({ userId: RECIPIENT_ID }),
        membership({ userId: OTHER_RECIPIENT_ID }),
        membership({ userId: SUBJECT_ID }),
      ];
      memberships.set(membership({ userId: OTHER_RECIPIENT_ID }));

      const outcomes = await deliverNotification(makeCommand(), deps);

      expect(outcomes.map((outcome) => outcome.recipientUserId).sort()).toEqual(
        [RECIPIENT_ID, OTHER_RECIPIENT_ID].sort(),
      );
      expect(outcomes.every((outcome) => outcome.disposition === 'DELIVERED')).toBe(true);
    });

    it('requires an account-level command to name its recipients explicitly', async () => {
      const accountCommand = makeCommand({
        kind: 'SUBSCRIPTION_EXPIRING',
        familyId: null,
        subjectUserId: null,
        placeId: null,
        transition: null,
        recipientUserIds: [RECIPIENT_ID],
      });

      const outcomes = await deliverNotification(accountCommand, deps);

      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]?.disposition).toBe('DELIVERED');
    });

    it('sends nothing for a family-wide command with no family', async () => {
      const orphan = makeCommand({ familyId: null, placeId: null, recipientUserIds: null });
      expect(await deliverNotification(orphan, deps)).toHaveLength(0);
    });
  });
});
