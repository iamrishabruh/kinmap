import { z } from 'zod';

import {
  type Entitlements,
  PlanSchema,
  PlanTierSchema,
  SubscriptionStatusSchema,
  UserIdSchema,
} from '@family/contracts';

import { IsoDateTimeSchema, PlatformSchema } from './common.js';

/**
 * Subscription endpoints.
 *
 * `GET  /v1/subscriptions/entitlements`
 * `POST /v1/webhooks/revenuecat`
 * `POST /v1/webhooks/apple`
 * `POST /v1/webhooks/google`
 *
 * Entitlements are always re-derived from the stored subscription record; the
 * client's cached copy is advisory only and is never trusted for an
 * authorisation decision.
 */

// ---------------------------------------------------------------------------
// GET /v1/subscriptions/entitlements
// ---------------------------------------------------------------------------

/**
 * Mirrors the `Entitlements` contract type. The `satisfies` clause makes a
 * drift between the schema and the contract a compile error.
 */
export const EntitlementsSchema = z.strictObject({
  tier: PlanTierSchema,
  maxFamilies: z.number().int().positive(),
  maxMembersPerFamily: z.number().int().positive(),
  maxSavedPlaces: z.number().int().nonnegative(),
  historyRetentionDays: z.number().int().nonnegative(),
  liveSessionsEnabled: z.boolean(),
  arrivalDepartureAlerts: z.boolean(),
  prioritySupport: z.boolean(),
}) satisfies z.ZodType<Entitlements>;

export const SubscriptionSourceSchema = z.enum(['APP_STORE', 'PLAY_STORE', 'PROMOTIONAL', 'NONE']);
export type SubscriptionSource = z.infer<typeof SubscriptionSourceSchema>;

export const EntitlementsResponseSchema = z.strictObject({
  userId: UserIdSchema,
  plan: PlanSchema,
  tier: PlanTierSchema,
  status: SubscriptionStatusSchema,
  source: SubscriptionSourceSchema,
  entitlements: EntitlementsSchema,
  isTrial: z.boolean(),
  currentPeriodEndsAt: IsoDateTimeSchema.nullable(),
  /** Set while in grace / billing retry so the app can prompt to fix payment. */
  gracePeriodEndsAt: IsoDateTimeSchema.nullable(),
  willRenew: z.boolean(),
  /** Store-managed subscription page. Opaque, store-issued URL. */
  managementUrl: z.string().url().max(2048).nullable(),
  /** When the server last reconciled with the store. */
  refreshedAt: IsoDateTimeSchema,
});
export type EntitlementsResponse = z.infer<typeof EntitlementsResponseSchema>;

// ---------------------------------------------------------------------------
// POST /v1/subscriptions/receipt  — client-initiated reconciliation
// ---------------------------------------------------------------------------

export const SubmitReceiptRequestSchema = z.strictObject({
  platform: PlatformSchema,
  /** Store receipt / purchase token. A credential: verified, never logged. */
  receipt: z.string().min(16).max(65_536),
  productId: z.string().min(1).max(120),
});
export type SubmitReceiptRequest = z.infer<typeof SubmitReceiptRequestSchema>;

export const SubmitReceiptResponseSchema = EntitlementsResponseSchema;
export type SubmitReceiptResponse = z.infer<typeof SubmitReceiptResponseSchema>;

// ---------------------------------------------------------------------------
// Webhooks
//
// DELIBERATE EXCEPTION to this package's strict-object policy: the bodies below
// are owned by third parties that add fields without notice, so rejecting an
// unknown key would drop real billing events. They use `z.looseObject`, which
// validates the fields we consume and preserves the rest for the raw-body
// signature check. Every handler MUST verify the provider signature over the
// raw bytes before trusting anything here.
// ---------------------------------------------------------------------------

export const WebhookProviderSchema = z.enum(['revenuecat', 'apple', 'google']);
export type WebhookProvider = z.infer<typeof WebhookProviderSchema>;

export const WebhookPathSchema = z.strictObject({
  provider: WebhookProviderSchema,
});
export type WebhookPath = z.infer<typeof WebhookPathSchema>;

export const RevenueCatWebhookSchema = z.looseObject({
  api_version: z.string(),
  event: z.looseObject({
    id: z.string().min(1),
    type: z.string().min(1),
    event_timestamp_ms: z.number().int().nonnegative(),
    app_user_id: z.string().min(1),
    original_app_user_id: z.string().min(1).optional(),
    product_id: z.string().min(1).optional(),
    entitlement_ids: z.array(z.string()).nullable().optional(),
    expiration_at_ms: z.number().int().nonnegative().nullable().optional(),
    store: z.string().optional(),
    environment: z.string().optional(),
  }),
});
export type RevenueCatWebhook = z.infer<typeof RevenueCatWebhookSchema>;

/** App Store Server Notifications V2: a signed JWS envelope. */
export const AppleWebhookSchema = z.looseObject({
  signedPayload: z.string().min(1),
});
export type AppleWebhook = z.infer<typeof AppleWebhookSchema>;

/** Google Play RTDN: a Pub/Sub push envelope with a base64 data blob. */
export const GoogleWebhookSchema = z.looseObject({
  message: z.looseObject({
    data: z.string().min(1),
    messageId: z.string().min(1),
    publishTime: z.string().min(1).optional(),
  }),
  subscription: z.string().min(1),
});
export type GoogleWebhook = z.infer<typeof GoogleWebhookSchema>;

export const WebhookBodySchema = z.union([
  RevenueCatWebhookSchema,
  AppleWebhookSchema,
  GoogleWebhookSchema,
]);
export type WebhookBody = z.infer<typeof WebhookBodySchema>;

/**
 * Webhooks always answer 200 with an acknowledgement so a provider never
 * retries because of our own downstream failure, and so the response body can
 * never be used to probe account state.
 */
export const WebhookAckResponseSchema = z.strictObject({
  received: z.literal(true),
});
export type WebhookAckResponse = z.infer<typeof WebhookAckResponseSchema>;
