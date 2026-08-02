import type { UserId } from '@family/contracts';

import type { SubscriptionEvent } from './events.js';
import type {
  EffectiveSubscription,
  ReadOnlyPlan,
  SubscriptionInventory,
  SubscriptionState,
} from './reconcile.js';

/** Data-access seams, so the reconciliation flow is unit-testable end to end. */

export interface SubscriptionStore {
  getByUser(input: { userId: UserId }): Promise<SubscriptionState | null>;
  /**
   * Play Store notifications carry no account identifier, only a purchase
   * token, so the account is resolved from the stored record rather than from
   * anything the webhook claims.
   */
  findByOriginalTransactionId(input: {
    originalTransactionId: string;
  }): Promise<SubscriptionState | null>;
  save(input: { state: SubscriptionState; effective: EffectiveSubscription }): Promise<void>;
}

export interface InventoryReader {
  load(input: { userId: UserId }): Promise<SubscriptionInventory>;
}

export interface ReadOnlyMarker {
  apply(plan: ReadOnlyPlan): Promise<void>;
}

export interface IdempotencyStore {
  claim(input: { key: string; ttlSeconds: number }): Promise<boolean>;
}

export interface SubscriptionEventPublisher {
  publish(events: readonly SubscriptionEvent[]): Promise<void>;
}

export interface NotificationCommandPublisher {
  publish(commands: readonly unknown[]): Promise<void>;
}
