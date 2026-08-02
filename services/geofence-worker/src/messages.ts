import { z } from 'zod';

import {
  DeviceIdSchema,
  EventIdSchema,
  FamilyIdSchema,
  GeofenceTransitionSchema,
  PlaceIdSchema,
  UserIdSchema,
} from '@family/contracts';
import { EncryptedCoordinateRecordSchema, KeyContextSchema } from '@family/crypto';
import { IsoDateTimeSchema, NotificationKindSchema } from '@family/schemas';

/**
 * The two message shapes this worker touches.
 *
 * INBOUND — an accepted-location event published by services/location-ingestion
 * onto the location event bus and routed to this worker's SQS queue. The
 * coordinate travels ENCRYPTED: the queue is durable storage, and a plaintext
 * fix sitting in a redrive queue would be exactly the leak the encryption at
 * rest exists to prevent. The worker holds the CMK decrypt grant and unseals it
 * in memory only.
 *
 * OUTBOUND — a notification command. It carries opaque identifiers and nothing
 * else: no coordinate, no distance, no place name, no display name. Rendering
 * is the notification worker's job, and it re-authorises every recipient before
 * it renders anything.
 */

export const AcceptedLocationEventSchema = z.strictObject({
  eventId: EventIdSchema,
  userId: UserIdSchema,
  deviceId: DeviceIdSchema,
  capturedAt: IsoDateTimeSchema,
  horizontalAccuracy: z.number().nonnegative(),
  /** Context the coordinate was sealed under; also the AAD binding. */
  keyContext: z.strictObject(KeyContextSchema.shape),
  encryptedCoordinate: z.strictObject(EncryptedCoordinateRecordSchema.shape),
});
export type AcceptedLocationEvent = z.infer<typeof AcceptedLocationEventSchema>;

/**
 * EventBridge wraps a detail payload; a direct SQS producer does not. Accepting
 * both means the worker keeps functioning if the routing is ever simplified.
 */
export const AcceptedLocationEnvelopeSchema = z.union([
  z.looseObject({ detail: AcceptedLocationEventSchema }).transform((body) => body.detail),
  AcceptedLocationEventSchema,
]);

export function parseAcceptedLocationEvent(body: unknown): AcceptedLocationEvent {
  return AcceptedLocationEnvelopeSchema.parse(body);
}

/** Only the two kinds this worker is allowed to raise. */
export const GeofenceNotificationKindSchema = NotificationKindSchema.extract([
  'ARRIVAL',
  'DEPARTURE',
]);

export const GeofenceNotificationCommandSchema = z.strictObject({
  commandId: z.string().uuid(),
  kind: GeofenceNotificationKindSchema,
  familyId: FamilyIdSchema,
  /** Who the notification is about. */
  subjectUserId: UserIdSchema,
  /**
   * Null means "fan out to the family". The notification worker resolves and
   * re-authorises recipients itself; this worker never decides who may see it.
   */
  recipientUserIds: z.array(UserIdSchema).nullable(),
  placeId: PlaceIdSchema,
  transition: GeofenceTransitionSchema,
  occurredAt: IsoDateTimeSchema,
  /** Deduplication key for the notification worker. */
  sourceEventId: EventIdSchema,
});
export type GeofenceNotificationCommand = z.infer<typeof GeofenceNotificationCommandSchema>;
