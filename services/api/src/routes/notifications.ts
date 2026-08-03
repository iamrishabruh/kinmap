import { AppError, type UserId } from '@family/contracts';
import {
  MarkNotificationsReadRequestSchema,
  UpdateNotificationPreferencesRequestSchema,
  type GetNotificationPreferencesResponse,
  type ListNotificationsResponse,
  type MarkNotificationsReadResponse,
  type Notification,
  type NotificationChannelPreference,
  type NotificationPreferences,
  type UpdateNotificationPreferencesRequest,
  type UpdateNotificationPreferencesResponse,
} from '@family/schemas';

import { projectEntitlements } from '../domain/entitlements.js';
import { validateBody } from '../middleware/validation.js';
import {
  defaultNotificationPreferences,
  MAX_NOTIFICATIONS_LISTED,
  type NotificationRecord,
  type NotificationServices,
} from '../repositories/notifications.js';
import { defineRoute, ENTITLEMENT_GATES, type RegisteredRoute } from '../router.js';
import type { ApiServices } from '../services.js';
import type { AnyRouteContext } from '../types.js';

import { requireAuth } from './shared.js';

/**
 * Notification endpoints: the in-app list, and the delivery preferences behind
 * it.
 *
 * Nothing here reaches a position. A notification is a pointer — a kind, a few
 * ids, and copy the notification worker already rendered from a person's name
 * and a saved place's name — and everything richer than that is an authorised
 * read the app makes after the tap.
 *
 * Every route here is scoped to the caller's own partition by the user id on
 * the verified token, so no request parameter exists that could point one at
 * somebody else. Marking an unknown id as read is not an error either: it
 * matches nothing and is reported as nothing, so this endpoint cannot be used
 * to learn that a notification — or the person it is about — exists.
 *
 * No route here writes an audit row. The audit trail answers "who looked at
 * me", and a user reading their own notifications is not that.
 */

/**
 * The repositories this area owns, read off the service container.
 *
 * The assertion is the single place the two views of `ApiServices` meet while
 * the composition root is being wired up; it is a no-op once the container
 * names these members itself.
 */
function notificationServices(context: AnyRouteContext): NotificationServices {
  return context.services as ApiServices & NotificationServices;
}

/**
 * Field by field, never a spread: an attribute that appears on a stored row
 * later must not be able to reach a client by accident.
 */
function projectNotification(record: NotificationRecord): Notification {
  return {
    notificationId: record.notificationId,
    kind: record.kind,
    familyId: record.familyId,
    subjectUserId: record.subjectUserId,
    placeId: record.placeId,
    title: record.title,
    body: record.body,
    occurredAt: record.occurredAt,
    readAt: record.readAt,
  };
}

/**
 * The stored row, or the defaults the user is on until they change something.
 * The defaults are the notification worker's own, so this screen never promises
 * behaviour the delivery path would not produce.
 */
async function loadPreferences(
  context: AnyRouteContext,
  userId: UserId,
): Promise<NotificationPreferences> {
  const stored = await notificationServices(context).notificationPreferences.get(userId);
  return stored ?? defaultNotificationPreferences(userId, context.now.toISOString());
}

/**
 * Applies the patch. Only the categories the caller named move; `userId` comes
 * from the token rather than from the stored row, because that value is the
 * partition the merged preferences are about to be written to.
 */
function mergePreferences(input: {
  userId: UserId;
  current: NotificationPreferences;
  patch: UpdateNotificationPreferencesRequest;
  now: Date;
}): NotificationPreferences {
  const { current, patch } = input;
  return {
    userId: input.userId,
    arrivals: patch.arrivals ?? current.arrivals,
    departures: patch.departures ?? current.departures,
    liveSessions: patch.liveSessions ?? current.liveSessions,
    membership: patch.membership ?? current.membership,
    sharingChanges: patch.sharingChanges ?? current.sharingChanges,
    deviceHealth: patch.deviceHealth ?? current.deviceHealth,
    billing: patch.billing ?? current.billing,
    quietHours: patch.quietHours ?? current.quietHours,
    // A mute list is not checked against family membership on purpose: an
    // error for "you are not in that family" would answer a question this
    // endpoint has no business answering, and muting a family the caller is
    // not in costs nobody anything.
    mutedFamilyIds: patch.mutedFamilyIds ?? current.mutedFamilyIds,
    mutedUserIds: patch.mutedUserIds ?? current.mutedUserIds,
    updatedAt: input.now.toISOString(),
  };
}

function asksForDelivery(channel: NotificationChannelPreference | undefined): boolean {
  return channel !== undefined && (channel.push || channel.inApp);
}

/**
 * Arrival and departure alerts are a paid feature, so a request that asserts
 * one is on is checked against the entitlement snapshot derived from the stored
 * subscription row — never against a plan, a tier or a receipt in the request.
 *
 * What is gated is the state the caller asks for, not the transition into it.
 * Delivery defaults are opt-in, so an unentitled user already has these
 * categories nominally on and a transition test would never fire for the very
 * people it exists to stop. Switching one *off* is always allowed: a
 * notification control may not be held hostage to a lapsed subscription.
 *
 * The predicate is the same one the pipeline applies to a fully gated route, so
 * the two cannot drift. It is applied here rather than as route metadata
 * because every other category on this endpoint — quiet hours, mutes, device
 * health, billing — is free.
 */
/**
 * Applies the arrival/departure entitlement to the preferences being stored.
 *
 * The check is on the RESULT, not on the patch. Inspecting only the patch left
 * the gate trivially bypassable: `defaultNotificationPreferences` turns arrivals
 * and departures on, `mergePreferences` re-persists whatever is currently set,
 * and a caller who has never stored preferences would have both written as
 * enabled by any unrelated patch — a quiet-hours change, say — without the gate
 * ever being consulted.
 *
 * Two different outcomes, deliberately. Explicitly asking to switch an alert on
 * without the entitlement is an error, because silently ignoring what someone
 * asked for is worse than telling them. Carrying an already-on value forward is
 * clamped instead: the user did not ask for it in this request, and failing
 * their unrelated edit would be baffling.
 */
async function applyAlertEntitlement(input: {
  context: AnyRouteContext;
  userId: UserId;
  patch: UpdateNotificationPreferencesRequest;
  merged: NotificationPreferences;
}): Promise<NotificationPreferences> {
  const { context, patch, merged } = input;

  const wantsOn = asksForDelivery(merged.arrivals) || asksForDelivery(merged.departures);
  if (!wantsOn) {
    return merged;
  }

  const subscription = await context.services.subscriptions.getForUser(input.userId);
  const entitlements = projectEntitlements({
    userId: input.userId,
    subscription,
    now: context.now,
  }).entitlements;

  if (ENTITLEMENT_GATES.ARRIVAL_DEPARTURE_ALERTS(entitlements)) {
    return merged;
  }

  if (asksForDelivery(patch.arrivals) || asksForDelivery(patch.departures)) {
    throw new AppError('ENTITLEMENT_REQUIRED', 'This feature requires a subscription.');
  }

  return {
    ...merged,
    arrivals: { push: false, inApp: false },
    departures: { push: false, inApp: false },
  };
}

export const notificationRoutes: RegisteredRoute[] = [
  defineRoute({
    method: 'GET',
    path: '/v1/notifications',
    authRequired: true,
    entitlement: null,
    rateLimit: 'GENERAL_READ',
    idempotencyRequired: false,
    async handler(context) {
      const auth = requireAuth(context);
      const page = await notificationServices(context).notifications.list({
        userId: auth.userId,
        limit: MAX_NOTIFICATIONS_LISTED,
      });

      const response: ListNotificationsResponse = {
        notifications: page.notifications.map(projectNotification),
        unreadCount: page.unreadCount,
      };
      return { statusCode: 200, body: response };
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/v1/notifications/read',
    authRequired: true,
    entitlement: null,
    rateLimit: 'ACCOUNT_MUTATION',
    // A key is honoured when supplied but not demanded: marking as read is a
    // flip rather than a creation, and it already converges — a replay writes
    // nothing and reports nothing read, exactly as the deletion-cancel route
    // does. Requiring a key would tax the one call a client makes on scroll.
    idempotencyRequired: false,
    async handler(context) {
      const auth = requireAuth(context);
      const request = validateBody(MarkNotificationsReadRequestSchema, context.body);

      const result = await notificationServices(context).notifications.markRead({
        userId: auth.userId,
        notificationIds: request.notificationIds,
        now: context.now,
      });

      const response: MarkNotificationsReadResponse = {
        readCount: result.readCount,
        unreadCount: result.unreadCount,
      };
      return { statusCode: 200, body: response };
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/v1/notifications/preferences',
    authRequired: true,
    entitlement: null,
    rateLimit: 'GENERAL_READ',
    idempotencyRequired: false,
    async handler(context) {
      const auth = requireAuth(context);
      const response: GetNotificationPreferencesResponse = {
        preferences: await loadPreferences(context, auth.userId),
      };
      return { statusCode: 200, body: response };
    },
  }),

  defineRoute({
    method: 'PATCH',
    path: '/v1/notifications/preferences',
    authRequired: true,
    // Null because the endpoint as a whole is free; the one paid category is
    // gated inside the handler, and only in the direction that grants it.
    entitlement: null,
    rateLimit: 'ACCOUNT_MUTATION',
    idempotencyRequired: false,
    async handler(context) {
      const auth = requireAuth(context);
      const request = validateBody(UpdateNotificationPreferencesRequestSchema, context.body);

      const merged = mergePreferences({
        userId: auth.userId,
        current: await loadPreferences(context, auth.userId),
        patch: request,
        now: context.now,
      });

      // Applied to the result, before anything is written, so a refusal leaves
      // the stored row exactly as it was.
      const next = await applyAlertEntitlement({
        context,
        userId: auth.userId,
        patch: request,
        merged,
      });

      await notificationServices(context).notificationPreferences.put(next);

      const response: UpdateNotificationPreferencesResponse = { preferences: next };
      return { statusCode: 200, body: response };
    },
  }),
];
