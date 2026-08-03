import { describe, expect, it } from 'vitest';

import { parseNotificationCommand } from '../src/messages.js';
import { buildMessage } from '../src/push/sns.js';

/** A rendered payload, coordinate-free by construction. */
const BASE_PAYLOAD = {
  kind: 'ARRIVAL',
  notificationId: '018f3a2b-4c5d-7e8f-9a0b-1c2d3e4f8888',
  familyId: '018f3a2b-4c5d-7e8f-9a0b-1c2d3e4f2222',
  subjectUserId: '018f3a2b-4c5d-7e8f-9a0b-1c2d3e4f5a6b',
  subjectDisplayName: 'Ada',
  placeId: '018f3a2b-4c5d-7e8f-9a0b-1c2d3e4f7777',
  placeName: 'School',
  transition: 'ARRIVAL',
  liveSessionId: null,
  occurredAt: '2026-08-03T12:00:00.000Z',
  deepLinkPath: '/map',
} as const;

/**
 * The live-session refresh command is not built by any TypeScript this repo
 * compiles. It is assembled by an EventBridge rule in
 * `infrastructure/stacks/location-stack.ts`, as a literal object of `EventField`
 * paths, and delivered straight to this worker's queue. Nothing type-checks
 * across that boundary.
 *
 * It had drifted completely: the rule sent four fields with a `kind` that was
 * not in the vocabulary at all, and this worker parses with a strict schema, so
 * every refresh ever raised was rejected on arrival and dead-lettered.
 *
 * The literal below mirrors what that rule emits, with the `EventField` paths
 * resolved. Duplication is the point — a shared import would make the test pass
 * while the two sides drifted again.
 */
const EMITTED_BY_THE_LIVE_REFRESH_RULE = {
  commandId: '018f3a2b-4c5d-7e8f-9a0b-1c2d3e4f9999',
  kind: 'LIVE_SESSION_REFRESH',
  familyId: '018f3a2b-4c5d-7e8f-9a0b-1c2d3e4f2222',
  subjectUserId: '018f3a2b-4c5d-7e8f-9a0b-1c2d3e4f5a6b',
  recipientUserIds: null,
  placeId: null,
  transition: null,
  liveSessionId: null,
  occurredAt: '2026-08-03T12:00:00.000Z',
  sourceEventId: '018f3a2b-4c5d-7e8f-9a0b-1c2d3e4f1111',
} as const;

describe('the live-session refresh wire contract', () => {
  it('parses the command the EventBridge rule emits', () => {
    const command = parseNotificationCommand(EMITTED_BY_THE_LIVE_REFRESH_RULE);

    expect(command.kind).toBe('LIVE_SESSION_REFRESH');
    expect(command.subjectUserId).toBe(EMITTED_BY_THE_LIVE_REFRESH_RULE.subjectUserId);
    expect(command.recipientUserIds).toBeNull();
  });

  it('carries no place, transition or session — only a nudge to refetch', () => {
    // The whole point of the transform on that rule is that the event detail
    // holds coordinate ciphertext and this queue feeds APNs and FCM. A refresh
    // says "something moved, ask the API"; it never says where.
    const command = parseNotificationCommand(EMITTED_BY_THE_LIVE_REFRESH_RULE);

    expect(command.placeId).toBeNull();
    expect(command.transition).toBeNull();
    expect(command.liveSessionId).toBeNull();
  });

  it('rejects the fragment the rule used to send', () => {
    // Four fields, and a kind that was not in the vocabulary. Kept as a test so
    // that reverting to it fails here rather than in a dead-letter queue nobody
    // is reading.
    expect(() =>
      parseNotificationCommand({
        kind: 'LIVE_SESSION_REFRESH',
        subjectUserId: EMITTED_BY_THE_LIVE_REFRESH_RULE.subjectUserId,
        deviceId: '018f3a2b-4c5d-7e8f-9a0b-1c2d3e4f0000',
        capturedAt: '2026-08-03T12:00:00.000Z',
      }),
    ).toThrow();
  });

  it('is delivered silently, so a live session does not buzz a pocket', () => {
    // Raised for every accepted fix while a session runs. Delivered as an alert
    // that is a notification every few seconds carrying nothing the app had not
    // already fetched.
    const message = JSON.parse(
      buildMessage(
        'IOS',
        'unused',
        'unused',
        { ...BASE_PAYLOAD, kind: 'LIVE_SESSION_REFRESH' },
        false,
      ),
    ) as Record<string, string>;
    const apns = JSON.parse(message['APNS'] ?? '{}') as { aps: Record<string, unknown> };

    expect(apns.aps['content-available']).toBe(1);
    expect(apns.aps['alert']).toBeUndefined();
    expect(apns.aps['sound']).toBeUndefined();
  });

  it('delivers every other kind as a visible alert', () => {
    const message = JSON.parse(
      buildMessage('IOS', 'Ada arrived', 'Ada arrived at School.', BASE_PAYLOAD, false),
    ) as Record<string, string>;
    const apns = JSON.parse(message['APNS'] ?? '{}') as {
      aps: { alert?: { title?: string }; sound?: string };
    };

    expect(apns.aps.alert?.title).toBe('Ada arrived');
    expect(apns.aps.sound).toBe('default');
  });

  it('rejects a command carrying anything coordinate-shaped', () => {
    expect(() =>
      parseNotificationCommand({ ...EMITTED_BY_THE_LIVE_REFRESH_RULE, latitude: 51.5 }),
    ).toThrow();
  });
});
