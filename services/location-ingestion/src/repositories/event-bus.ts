import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';

import { AppError } from '@family/contracts';

import type { AcceptedLocationEvent, AcceptedLocationPublisher } from '../ports.js';

/**
 * Publishes one `location.accepted` event per stored fix.
 *
 * The detail carries ids, timings, the tracking mode and the *sealed* coordinate
 * — never a position. That matters because the bus fans out to a geofence queue
 * and to the notification path, and only the geofence worker holds a decrypt
 * grant; anything else that ever subscribes gets ciphertext it cannot open.
 */

export const ACCEPTED_LOCATION_DETAIL_TYPE = 'location.accepted';

/** EventBridge hard limit per PutEvents call. */
const MAX_ENTRIES_PER_CALL = 10;

export const eventBridgeClient = new EventBridgeClient({});

export function createAcceptedLocationPublisher(options: {
  eventBusName: string;
  source: string;
}): AcceptedLocationPublisher {
  return {
    async publish(events: readonly AcceptedLocationEvent[]): Promise<void> {
      if (events.length === 0) {
        return;
      }
      if (events.length > MAX_ENTRIES_PER_CALL) {
        throw new RangeError('PutEvents accepts at most ten entries per call.');
      }

      const response = await eventBridgeClient.send(
        new PutEventsCommand({
          Entries: events.map((event) => ({
            EventBusName: options.eventBusName,
            Source: options.source,
            DetailType: ACCEPTED_LOCATION_DETAIL_TYPE,
            Time: new Date(event.receivedAt),
            Detail: JSON.stringify(event),
          })),
        }),
      );

      if ((response.FailedEntryCount ?? 0) > 0) {
        // The points are already durable, so the client's retry re-writes
        // identical rows. Failing loudly is better than a silently missed
        // arrival alert.
        throw new AppError('UPSTREAM_UNAVAILABLE', 'A dependency is temporarily unavailable.');
      }
    },
  };
}
