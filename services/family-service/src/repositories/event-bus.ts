import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';

import { AppError } from '@family/contracts';

import type { FamilyDomainEvent, FamilyEventPublisher } from '../ports.js';

/**
 * Family lifecycle events.
 *
 * The detail carries ids, roles and statuses only. That is deliberate: a removal
 * event fans out to every client in the family so they can purge cached
 * positions, and a payload that itself contained a position would defeat the
 * purpose of purging.
 */

export const FAMILY_DETAIL_TYPES: Record<FamilyDomainEvent['kind'], string> = {
  FAMILY_CREATED: 'family.created',
  MEMBERSHIP_ENDED: 'family.membership-ended',
  MEMBER_ROLE_CHANGED: 'family.member-role-changed',
  OWNERSHIP_TRANSFERRED: 'family.ownership-transferred',
  USER_BLOCKED: 'family.user-blocked',
  ABUSE_REPORTED: 'family.abuse-reported',
};

export const eventBridgeClient = new EventBridgeClient({});

export function createFamilyEventPublisher(options: {
  eventBusName: string;
  source: string;
}): FamilyEventPublisher {
  return {
    async publish(event: FamilyDomainEvent): Promise<void> {
      const response = await eventBridgeClient.send(
        new PutEventsCommand({
          Entries: [
            {
              EventBusName: options.eventBusName,
              Source: options.source,
              DetailType: FAMILY_DETAIL_TYPES[event.kind],
              Time: new Date(event.occurredAt),
              Detail: JSON.stringify(event),
            },
          ],
        }),
      );

      if ((response.FailedEntryCount ?? 0) > 0) {
        // A membership change that clients never hear about leaves stale
        // location cards on other devices, so this fails loudly.
        throw new AppError('UPSTREAM_UNAVAILABLE', 'A dependency is temporarily unavailable.');
      }
    },
  };
}
