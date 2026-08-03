import { z } from 'zod';

import {
  DeviceIdSchema,
  EventIdSchema,
  FamilyIdSchema,
  GeofenceTransitionSchema,
  PlaceIdSchema,
  UserIdSchema,
} from '@family/contracts';
import { EncryptedCoordinateRecordSchema } from '@family/crypto';
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

/**
 * What `services/location-ingestion` actually publishes.
 *
 * This schema and the producer had drifted apart in three ways at once, and
 * because the schema is strict every single message failed to parse and was
 * dead-lettered — so geofence evaluation had never once run. The producer sends
 * `subjectUserId`, not `userId`; it sends the ciphertext under `sealed`, not
 * split into `encryptedCoordinate` and `keyContext`; and it sends five further
 * fields that a strict object rejects outright.
 *
 * The producer is the authority here — it is deployed and its shape is the one
 * on the wire — so the consumer moves. Strictness is kept: an unknown field
 * arriving from the bus should still be a loud failure rather than something
 * that silently flows into a decrypt call.
 */
const PublishedAcceptedLocationSchema = z.strictObject({
  eventId: EventIdSchema,
  subjectUserId: UserIdSchema,
  deviceId: DeviceIdSchema,
  sequenceNumber: z.number(),
  capturedAt: IsoDateTimeSchema,
  receivedAt: IsoDateTimeSchema,
  trackingMode: z.string(),
  motionState: z.string(),
  horizontalAccuracy: z.number().nonnegative(),
  coordinateScopeFamilyId: FamilyIdSchema,
  /** Ciphertext only. The bus, its rules and its targets never see a position. */
  sealed: z.strictObject(EncryptedCoordinateRecordSchema.shape),
});

/**
 * The shape the worker reasons about, normalised from the wire format. The key
 * context is reconstructed from the scope the producer sealed under — the same
 * two values, which is what makes the AAD binding verify on decrypt.
 */
export const AcceptedLocationEventSchema = PublishedAcceptedLocationSchema.transform(
  (published) => ({
    eventId: published.eventId,
    userId: published.subjectUserId,
    deviceId: published.deviceId,
    capturedAt: published.capturedAt,
    horizontalAccuracy: published.horizontalAccuracy,
    keyContext: {
      familyId: published.coordinateScopeFamilyId,
      userId: published.subjectUserId,
    },
    encryptedCoordinate: published.sealed,
  }),
);
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
