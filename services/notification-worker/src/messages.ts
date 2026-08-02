import { z } from 'zod';

import {
  EventIdSchema,
  FamilyIdSchema,
  GeofenceTransitionSchema,
  PlaceIdSchema,
  SessionIdSchema,
  UserIdSchema,
} from '@family/contracts';
import { IsoDateTimeSchema, NotificationKindSchema } from '@family/schemas';

/**
 * The notification command envelope.
 *
 * Producers (services/geofence-worker, services/subscription-worker, the API)
 * put ONLY opaque identifiers on the queue. Everything a human reads is
 * rendered here, after this worker has re-authorised the recipient — which is
 * the whole point: a queue message that already contained "Ana arrived at Home"
 * would be a disclosure sitting in a redrive queue, readable by anyone with
 * queue access and no membership check in sight.
 *
 * The schema is strict: a producer that tries to attach a coordinate, an
 * address or a rendered string gets a parse failure rather than a silent leak.
 */
export const NotificationCommandSchema = z.strictObject({
  commandId: z.string().uuid(),
  kind: NotificationKindSchema,
  familyId: FamilyIdSchema.nullable(),
  /** Who the notification is about. Null for account-level notices. */
  subjectUserId: UserIdSchema.nullable(),
  /**
   * Explicit recipients, or null to fan out to the subject's family. Either way
   * every recipient is re-authorised individually before anything is sent.
   */
  recipientUserIds: z.array(UserIdSchema).nullable(),
  placeId: PlaceIdSchema.nullable().default(null),
  transition: GeofenceTransitionSchema.nullable().default(null),
  liveSessionId: SessionIdSchema.nullable().default(null),
  occurredAt: IsoDateTimeSchema,
  /** Stable id of the triggering event; the deduplication key is built on it. */
  sourceEventId: z.union([EventIdSchema, z.string().min(1).max(128)]),
});
export type NotificationCommand = z.infer<typeof NotificationCommandSchema>;

export function parseNotificationCommand(body: unknown): NotificationCommand {
  return NotificationCommandSchema.parse(body);
}
