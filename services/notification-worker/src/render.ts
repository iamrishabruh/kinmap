import { PushPayloadSchema, type NotificationKind, type PushPayload } from '@family/schemas';

import type { NotificationCommand } from './messages.js';

/**
 * Human-readable copy, rendered server-side at delivery time.
 *
 * Two rules govern everything here:
 *
 *  1. NO COORDINATES. Not in the title, not in the body, not in the deep link.
 *     A push leaves our infrastructure and crosses APNs/FCM; the most a payload
 *     may say about a position is the name of a place the recipient's own
 *     family authored. The final `PushPayloadSchema.parse` is the enforcement:
 *     it is a strict object, so a latitude added here fails the unit tests.
 *  2. NO NEW DISCLOSURE. Every name in a payload is one the recipient can
 *     already see through the API, which is why rendering happens after the
 *     authorization re-check rather than before it.
 */

export type RenderInput = {
  readonly command: NotificationCommand;
  readonly notificationId: string;
  readonly subjectDisplayName: string | null;
  readonly placeName: string | null;
};

export type RenderedNotification = {
  readonly title: string;
  readonly body: string;
  readonly payload: PushPayload;
};

const MAX_TITLE = 120;
const MAX_BODY = 300;

/** Used when the recipient cannot be shown a name, so copy never reads "null". */
const ANONYMOUS_SUBJECT = 'A family member';
const ANONYMOUS_PLACE = 'a saved place';

function clamp(text: string, limit: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit - 1)}…`;
}

type Copy = { title: string; body: string };

function copyFor(kind: NotificationKind, subject: string, place: string): Copy {
  switch (kind) {
    case 'ARRIVAL':
      return { title: `${subject} arrived`, body: `${subject} arrived at ${place}.` };
    case 'DEPARTURE':
      return { title: `${subject} left`, body: `${subject} left ${place}.` };
    case 'LIVE_SESSION_REQUESTED':
      return {
        title: 'Live location requested',
        body: `${subject} asked to see your live location.`,
      };
    case 'LIVE_SESSION_ACCEPTED':
      return { title: 'Live location started', body: `${subject} is sharing live location.` };
    case 'LIVE_SESSION_REJECTED':
      return { title: 'Live location declined', body: `${subject} declined the live request.` };
    case 'LIVE_SESSION_ENDED':
      return { title: 'Live location ended', body: `${subject} stopped sharing live location.` };
    case 'LIVE_SESSION_REFRESH':
      // Never surfaced. A refresh is a silent nudge telling the watcher's app to
      // refetch; copy exists only because the renderer is total, and showing it
      // would mean a buzz in someone's pocket for every fix during a session.
      return { title: 'Live location updated', body: `${subject} moved.` };
    case 'MEMBER_JOINED':
      return { title: 'New family member', body: `${subject} joined your family.` };
    case 'MEMBER_LEFT':
      return { title: 'Family member left', body: `${subject} left your family.` };
    case 'INVITATION_ACCEPTED':
      return { title: 'Invitation accepted', body: `${subject} accepted your invitation.` };
    case 'SHARING_PAUSED':
      return { title: 'Sharing paused', body: `${subject} paused location sharing.` };
    case 'SHARING_RESUMED':
      return { title: 'Sharing resumed', body: `${subject} resumed location sharing.` };
    case 'LOCATION_STALE':
      return {
        title: 'Location out of date',
        body: `We have not had an update from ${subject} in a while.`,
      };
    case 'PERMISSION_LOST':
      return {
        title: 'Location permission needed',
        body: `${subject} needs to re-enable location permission.`,
      };
    case 'BATTERY_CRITICAL':
      return { title: 'Battery critical', body: `${subject}'s phone battery is critically low.` };
    case 'SUBSCRIPTION_EXPIRING':
      return {
        title: 'Subscription expiring',
        body: 'Your family plan is about to expire. Update billing to keep premium features.',
      };
  }
}

function deepLinkFor(command: NotificationCommand): string | null {
  switch (command.kind) {
    case 'ARRIVAL':
    case 'DEPARTURE':
      return command.placeId === null ? '/map' : `/places/${command.placeId}`;
    case 'LIVE_SESSION_REQUESTED':
    case 'LIVE_SESSION_ACCEPTED':
    case 'LIVE_SESSION_REJECTED':
    case 'LIVE_SESSION_ENDED':
    case 'LIVE_SESSION_REFRESH':
      return command.liveSessionId === null ? '/map' : `/live/${command.liveSessionId}`;
    case 'MEMBER_JOINED':
    case 'MEMBER_LEFT':
    case 'INVITATION_ACCEPTED':
      return command.familyId === null ? '/family' : `/family/${command.familyId}`;
    case 'SHARING_PAUSED':
    case 'SHARING_RESUMED':
    case 'LOCATION_STALE':
    case 'PERMISSION_LOST':
    case 'BATTERY_CRITICAL':
      return command.subjectUserId === null ? '/map' : `/member/${command.subjectUserId}`;
    case 'SUBSCRIPTION_EXPIRING':
      return '/settings/subscription';
  }
}

export function renderNotification(input: RenderInput): RenderedNotification {
  const subject = input.subjectDisplayName ?? ANONYMOUS_SUBJECT;
  const place = input.placeName ?? ANONYMOUS_PLACE;
  const { title, body } = copyFor(input.command.kind, subject, place);

  const payload = PushPayloadSchema.parse({
    kind: input.command.kind,
    notificationId: input.notificationId,
    familyId: input.command.familyId,
    subjectUserId: input.command.subjectUserId,
    subjectDisplayName: input.subjectDisplayName,
    placeId: input.command.placeId,
    placeName: input.placeName,
    transition: input.command.transition,
    liveSessionId: input.command.liveSessionId,
    occurredAt: input.command.occurredAt,
    deepLinkPath: deepLinkFor(input.command),
  } satisfies PushPayload);

  return { title: clamp(title, MAX_TITLE), body: clamp(body, MAX_BODY), payload };
}
