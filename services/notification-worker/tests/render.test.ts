import { describe, expect, it } from 'vitest';

import { PushPayloadSchema, type NotificationKind } from '@family/schemas';

import { NotificationCommandSchema, type NotificationCommand } from '../src/messages.js';
import { renderNotification } from '../src/render.js';

const FAMILY_ID = '33333333-3333-4333-8333-333333333333';
const SUBJECT_ID = '11111111-1111-4111-8111-111111111111';
const PLACE_ID = '22222222-2222-4222-8222-222222222222';
const SESSION_ID = '77777777-7777-4777-8777-777777777777';
const NOTIFICATION_ID = '88888888-8888-4888-8888-888888888888';
const EVENT_ID = '99999999-9999-4999-8999-999999999999';

function command(overrides: Partial<NotificationCommand> = {}): NotificationCommand {
  return NotificationCommandSchema.parse({
    commandId: '44444444-4444-4444-8444-444444444444',
    kind: 'ARRIVAL',
    familyId: FAMILY_ID,
    subjectUserId: SUBJECT_ID,
    recipientUserIds: null,
    placeId: PLACE_ID,
    transition: 'ARRIVAL',
    liveSessionId: null,
    occurredAt: '2026-06-01T12:00:00.000Z',
    sourceEventId: EVENT_ID,
    ...overrides,
  });
}

const ALL_KINDS: NotificationKind[] = [
  'ARRIVAL',
  'DEPARTURE',
  'LIVE_SESSION_REQUESTED',
  'LIVE_SESSION_ACCEPTED',
  'LIVE_SESSION_REJECTED',
  'LIVE_SESSION_ENDED',
  'MEMBER_JOINED',
  'MEMBER_LEFT',
  'INVITATION_ACCEPTED',
  'SHARING_PAUSED',
  'SHARING_RESUMED',
  'LOCATION_STALE',
  'PERMISSION_LOST',
  'BATTERY_CRITICAL',
  'SUBSCRIPTION_EXPIRING',
];

describe('renderNotification', () => {
  it('renders arrival copy from names the recipient already knows', () => {
    const rendered = renderNotification({
      command: command(),
      notificationId: NOTIFICATION_ID,
      subjectDisplayName: 'Ana',
      placeName: 'Home',
    });

    expect(rendered.title).toBe('Ana arrived');
    expect(rendered.body).toBe('Ana arrived at Home.');
    expect(rendered.payload.deepLinkPath).toBe(`/places/${PLACE_ID}`);
  });

  it('never emits "null" when a name is unavailable', () => {
    const rendered = renderNotification({
      command: command({ kind: 'DEPARTURE', transition: 'DEPARTURE' }),
      notificationId: NOTIFICATION_ID,
      subjectDisplayName: null,
      placeName: null,
    });

    expect(rendered.title).not.toContain('null');
    expect(rendered.body).not.toContain('null');
    expect(rendered.body).toBe('A family member left a saved place.');
  });

  it('produces a schema-valid, coordinate-free payload for every kind', () => {
    for (const kind of ALL_KINDS) {
      const rendered = renderNotification({
        command: command({
          kind,
          liveSessionId: kind.startsWith('LIVE_SESSION') ? SESSION_ID : null,
          transition: kind === 'ARRIVAL' || kind === 'DEPARTURE' ? 'ARRIVAL' : null,
        }),
        notificationId: NOTIFICATION_ID,
        subjectDisplayName: 'Ana',
        placeName: 'Home',
      });

      // Strict schema: an added latitude/longitude would throw here.
      expect(() => PushPayloadSchema.parse(rendered.payload)).not.toThrow();

      const serialized = JSON.stringify(rendered);
      for (const banned of ['latitude', 'longitude', 'coords', 'geohash', 'address']) {
        expect(serialized.toLowerCase()).not.toContain(banned);
      }
      expect(rendered.title.length).toBeGreaterThan(0);
      expect(rendered.title.length).toBeLessThanOrEqual(120);
      expect(rendered.body.length).toBeLessThanOrEqual(300);
    }
  });

  it('produces deep links with no query string, so nothing can be smuggled in one', () => {
    for (const kind of ALL_KINDS) {
      const rendered = renderNotification({
        command: command({
          kind,
          liveSessionId: kind.startsWith('LIVE_SESSION') ? SESSION_ID : null,
          transition: null,
        }),
        notificationId: NOTIFICATION_ID,
        subjectDisplayName: 'Ana',
        placeName: 'Home',
      });
      const link = rendered.payload.deepLinkPath;
      expect(link).not.toBeNull();
      expect(link).toMatch(/^\/[A-Za-z0-9/_-]*$/);
    }
  });
});
