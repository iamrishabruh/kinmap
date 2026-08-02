import type { FamilyMembershipRecord } from '@family/auth';
import type { DeviceId, FamilyId, UserId } from '@family/contracts';
import type { NotificationPreferences, Platform, PushPayload } from '@family/schemas';

import type { NotificationCommand } from './messages.js';

/**
 * Every external dependency of the delivery pipeline, expressed as an
 * interface. `pipeline.ts` imports nothing else, so the ordering guarantees it
 * makes — re-authorise before rendering, deduplicate before sending, retire a
 * dead endpoint after a rejection — are all unit-testable.
 */

/** Step 1: the event behind the command, hydrated with the names it references. */
export type NotificationEvent = {
  readonly command: NotificationCommand;
  readonly subjectDisplayName: string | null;
  readonly placeName: string | null;
};

export interface EventLoader {
  /**
   * Returns null when the triggering event no longer exists — a live session
   * that already ended, a place that was deleted. Sending a notification about
   * something that is gone is worse than sending nothing.
   */
  load(command: NotificationCommand): Promise<NotificationEvent | null>;
}

/** A device that can receive a push. `pushToken` is credential-grade. */
export type RecipientDevice = {
  readonly deviceId: DeviceId;
  readonly platform: Platform;
  readonly status: 'ACTIVE' | 'PENDING' | 'REVOKED';
  /** SNS platform endpoint ARN when the device is registered with SNS. */
  readonly endpointArn: string | null;
  /** Direct FCM registration token. Never logged, never echoed. */
  readonly pushToken: string | null;
};

/** Step 2: the recipient's own settings. */
export type RecipientProfile = {
  readonly userId: UserId;
  readonly preferences: NotificationPreferences;
  /** IANA identifier; null falls back to UTC for quiet-hours evaluation. */
  readonly timeZone: string | null;
  readonly devices: readonly RecipientDevice[];
};

export interface PreferencesReader {
  load(input: { userId: UserId; familyId: FamilyId | null }): Promise<RecipientProfile | null>;
}

/** Step 3: authorisation, re-read at send time and never cached. */
export interface MembershipReader {
  getMembership(input: {
    familyId: FamilyId;
    userId: UserId;
  }): Promise<FamilyMembershipRecord | null>;
  /** Active members of a family, used to fan a family-wide command out. */
  listActiveMembers(input: { familyId: FamilyId }): Promise<FamilyMembershipRecord[]>;
}

/** Step 5. */
export interface DeduplicationStore {
  /** True when this caller claimed the key; false when it was already taken. */
  claim(input: { key: string; ttlSeconds: number }): Promise<boolean>;
}

/** Step 6. Mirrors the @family/auth rate-limiter seam. */
export interface RateLimiter {
  consume(input: { key: string; limitPerMinute: number }): Promise<{ allowed: boolean }>;
}

/** Step 7. */
export type PushTarget = {
  readonly deviceId: DeviceId;
  readonly platform: Platform;
  readonly endpointArn: string | null;
  readonly pushToken: string | null;
};

export type PushSendOutcome =
  | { readonly status: 'DELIVERED'; readonly providerMessageId: string | null }
  /** The token or endpoint is dead. Retiring it is mandatory, not optional. */
  | { readonly status: 'INVALID_ENDPOINT'; readonly reason: string }
  | { readonly status: 'RETRYABLE'; readonly reason: string };

export interface PushSender {
  send(input: {
    target: PushTarget;
    payload: PushPayload;
    title: string;
    body: string;
  }): Promise<PushSendOutcome>;
}

/** Step 9. */
export interface EndpointRegistry {
  disableEndpoint(input: { endpointArn: string }): Promise<void>;
  removeToken(input: { userId: UserId; deviceId: DeviceId }): Promise<void>;
}

/** Step 8: the sanitised, durable record of what happened. */
export type DeliveryRecord = {
  readonly commandId: string;
  readonly recipientUserId: UserId;
  readonly deviceId: DeviceId | null;
  readonly kind: string;
  readonly disposition: string;
  readonly stage: string;
  /** Provider reason code only — never a token, endpoint ARN or message body. */
  readonly reasonCode: string | null;
  readonly occurredAt: string;
  readonly recordedAt: string;
};

export interface DeliveryRecorder {
  record(result: DeliveryRecord): Promise<void>;
}
