import { describe, expect, it } from 'vitest';

import type { Plan } from '@family/contracts';

import { DEFAULT_PRODUCT_PLAN_MAP } from '../src/env.js';
import {
  normalizeAppleNotification,
  normalizeGoogleNotification,
  normalizeRevenueCatWebhook,
  type NormalizeContext,
} from '../src/normalize.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-06-01T12:00:00.000Z');

const context: NormalizeContext = {
  productPlanMap: DEFAULT_PRODUCT_PLAN_MAP as Readonly<Record<string, Plan>>,
  now: () => NOW,
};

/** Builds a JWS-shaped token whose payload segment carries `payload`. */
function nestedJws(payload: Record<string, unknown>): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'ES256' })}.${encode(payload)}.signature`;
}

describe('RevenueCat normalisation', () => {
  it('maps an initial purchase onto an ACTIVE FAMILY plan', () => {
    const normalized = normalizeRevenueCatWebhook(
      {
        api_version: '1.0',
        event: {
          id: 'rc-1',
          type: 'INITIAL_PURCHASE',
          event_timestamp_ms: Date.parse('2026-06-01T11:00:00.000Z'),
          app_user_id: USER_ID,
          product_id: 'kinmap.family.monthly',
          expiration_at_ms: Date.parse('2026-07-01T11:00:00.000Z'),
          store: 'APP_STORE',
          environment: 'PRODUCTION',
        },
      },
      context,
    );

    expect(normalized?.type).toBe('PURCHASE');
    expect(normalized?.plan).toBe('FAMILY_MONTHLY');
    expect(normalized?.status).toBe('ACTIVE');
    expect(normalized?.userId).toBe(USER_ID);
    expect(normalized?.source).toBe('APP_STORE');
    expect(normalized?.willRenew).toBe(true);
  });

  it('treats a cancellation as "will not renew", not as "access ends now"', () => {
    const normalized = normalizeRevenueCatWebhook(
      {
        api_version: '1.0',
        event: {
          id: 'rc-2',
          type: 'CANCELLATION',
          event_timestamp_ms: Date.parse('2026-06-01T11:00:00.000Z'),
          app_user_id: USER_ID,
          product_id: 'kinmap.family.monthly',
          expiration_at_ms: Date.parse('2026-07-01T11:00:00.000Z'),
        },
      },
      context,
    );

    expect(normalized?.type).toBe('CANCELLATION');
    expect(normalized?.status).toBe('ACTIVE');
    expect(normalized?.willRenew).toBe(false);
  });

  it('separates a support-issued refund from a plain cancellation', () => {
    const normalized = normalizeRevenueCatWebhook(
      {
        api_version: '1.0',
        event: {
          id: 'rc-3',
          type: 'CANCELLATION',
          cancel_reason: 'CUSTOMER_SUPPORT',
          event_timestamp_ms: Date.parse('2026-06-01T11:00:00.000Z'),
          app_user_id: USER_ID,
          product_id: 'kinmap.family.monthly',
        },
      },
      context,
    );

    expect(normalized?.type).toBe('REFUND');
    expect(normalized?.status).toBe('REFUNDED');
  });

  it('recognises a product change as an upgrade or a downgrade', () => {
    const downgrade = normalizeRevenueCatWebhook(
      {
        api_version: '1.0',
        event: {
          id: 'rc-4',
          type: 'PRODUCT_CHANGE',
          event_timestamp_ms: Date.parse('2026-06-01T11:00:00.000Z'),
          app_user_id: USER_ID,
          product_id: 'kinmap.familyplus.annual',
          new_product_id: 'kinmap.family.monthly',
        },
      },
      context,
    );
    expect(downgrade?.type).toBe('DOWNGRADE');
    expect(downgrade?.plan).toBe('FAMILY_MONTHLY');
    // A downgrade still renews — into the cheaper plan.
    expect(downgrade?.willRenew).toBe(true);

    const upgrade = normalizeRevenueCatWebhook(
      {
        api_version: '1.0',
        event: {
          id: 'rc-5',
          type: 'PRODUCT_CHANGE',
          event_timestamp_ms: Date.parse('2026-06-01T11:00:00.000Z'),
          app_user_id: USER_ID,
          product_id: 'kinmap.family.monthly',
          new_product_id: 'kinmap.familyplus.annual',
        },
      },
      context,
    );
    expect(upgrade?.type).toBe('UPGRADE');
  });

  it('does not throw on an unrecognised notification type', () => {
    const normalized = normalizeRevenueCatWebhook(
      {
        api_version: '1.0',
        event: {
          id: 'rc-6',
          type: 'SOMETHING_NEW_APPLE_INVENTED',
          event_timestamp_ms: Date.parse('2026-06-01T11:00:00.000Z'),
          app_user_id: USER_ID,
        },
      },
      context,
    );

    expect(normalized?.type).toBe('UNHANDLED');
  });

  it('rejects a body with no event object', () => {
    expect(normalizeRevenueCatWebhook({ api_version: '1.0' }, context)).toBeNull();
  });
});

describe('Apple normalisation', () => {
  function applePayload(
    notificationType: string,
    subtype: string | null,
    overrides: { transaction?: Record<string, unknown>; renewal?: Record<string, unknown> } = {},
  ): Record<string, unknown> {
    return {
      notificationType,
      subtype: subtype ?? undefined,
      notificationUUID: `apple-${notificationType}-${subtype ?? 'none'}`,
      signedDate: Date.parse('2026-06-01T11:00:00.000Z'),
      data: {
        environment: 'Production',
        bundleId: 'com.kinmap.app',
        signedTransactionInfo: nestedJws({
          productId: 'kinmap.familyplus.monthly',
          originalTransactionId: 'apple-txn-1',
          appAccountToken: USER_ID,
          expiresDate: Date.parse('2026-07-01T11:00:00.000Z'),
          ...overrides.transaction,
        }),
        signedRenewalInfo: nestedJws({
          autoRenewProductId: 'kinmap.familyplus.monthly',
          autoRenewStatus: 1,
          ...overrides.renewal,
        }),
      },
    };
  }

  it('maps a subscription onto a purchase and resolves the account token', () => {
    const normalized = normalizeAppleNotification(
      applePayload('SUBSCRIBED', 'INITIAL_BUY'),
      context,
    );

    expect(normalized?.type).toBe('PURCHASE');
    expect(normalized?.plan).toBe('FAMILY_PLUS_MONTHLY');
    expect(normalized?.userId).toBe(USER_ID);
    expect(normalized?.originalTransactionId).toBe('apple-txn-1');
    expect(normalized?.expiresAt).toBe('2026-07-01T11:00:00.000Z');
  });

  it('turns auto-renew off without ending the subscription', () => {
    const normalized = normalizeAppleNotification(
      applePayload('DID_CHANGE_RENEWAL_STATUS', 'AUTO_RENEW_DISABLED', {
        renewal: { autoRenewStatus: 0 },
      }),
      context,
    );

    expect(normalized?.type).toBe('CANCELLATION');
    expect(normalized?.status).toBe('ACTIVE');
    expect(normalized?.willRenew).toBe(false);
  });

  it('distinguishes a grace period from a billing retry', () => {
    expect(
      normalizeAppleNotification(applePayload('DID_FAIL_TO_RENEW', 'GRACE_PERIOD'), context)
        ?.status,
    ).toBe('IN_GRACE_PERIOD');
    expect(
      normalizeAppleNotification(applePayload('DID_FAIL_TO_RENEW', null), context)?.status,
    ).toBe('IN_BILLING_RETRY');
  });

  it('maps expiry, refund and revocation onto their terminal statuses', () => {
    expect(normalizeAppleNotification(applePayload('EXPIRED', null), context)?.status).toBe(
      'EXPIRED',
    );
    expect(normalizeAppleNotification(applePayload('REFUND', null), context)?.status).toBe(
      'REFUNDED',
    );
    expect(normalizeAppleNotification(applePayload('REVOKE', null), context)?.status).toBe(
      'REVOKED',
    );
  });

  it('reads a downgrade from the renewal preference subtype', () => {
    expect(
      normalizeAppleNotification(applePayload('DID_CHANGE_RENEWAL_PREF', 'DOWNGRADE'), context)
        ?.type,
    ).toBe('DOWNGRADE');
  });

  it('marks the sandbox environment so test purchases stay distinguishable', () => {
    const payload = applePayload('SUBSCRIBED', 'INITIAL_BUY');
    const data = payload.data as Record<string, unknown>;
    data.environment = 'Sandbox';

    expect(normalizeAppleNotification(payload, context)?.environment).toBe('SANDBOX');
  });
});

describe('Google normalisation', () => {
  it('maps a purchase notification and keeps the purchase token as the join key', () => {
    const normalized = normalizeGoogleNotification(
      {
        version: '1.0',
        packageName: 'com.kinmap.app',
        eventTimeMillis: String(Date.parse('2026-06-01T11:00:00.000Z')),
        subscriptionNotification: {
          version: '1.0',
          notificationType: 4,
          purchaseToken: 'play-token-1',
          subscriptionId: 'kinmap.family.annual',
        },
      },
      context,
      'pubsub-message-1',
    );

    expect(normalized?.type).toBe('PURCHASE');
    expect(normalized?.plan).toBe('FAMILY_ANNUAL');
    expect(normalized?.originalTransactionId).toBe('play-token-1');
    // Play never tells us who the user is; the account is resolved server-side.
    expect(normalized?.userId).toBeNull();
    expect(normalized?.eventId).toBe('pubsub-message-1');
  });

  it('maps the lifecycle numbers onto the right statuses', () => {
    const cases: Array<[number, string]> = [
      [2, 'ACTIVE'],
      [3, 'ACTIVE'],
      [5, 'IN_BILLING_RETRY'],
      [6, 'IN_GRACE_PERIOD'],
      [10, 'PAUSED'],
      [12, 'REVOKED'],
      [13, 'EXPIRED'],
    ];

    for (const [notificationType, expected] of cases) {
      const normalized = normalizeGoogleNotification(
        {
          packageName: 'com.kinmap.app',
          eventTimeMillis: String(Date.parse('2026-06-01T11:00:00.000Z')),
          subscriptionNotification: {
            notificationType,
            purchaseToken: 'play-token-1',
            subscriptionId: 'kinmap.family.annual',
          },
        },
        context,
        `msg-${String(notificationType)}`,
      );
      expect(normalized?.status).toBe(expected);
    }
  });

  it('treats a voided purchase as a refund', () => {
    const normalized = normalizeGoogleNotification(
      {
        packageName: 'com.kinmap.app',
        eventTimeMillis: String(Date.parse('2026-06-01T11:00:00.000Z')),
        voidedPurchaseNotification: { purchaseToken: 'play-token-1', orderId: 'order-1' },
      },
      context,
      'msg-void',
    );

    expect(normalized?.type).toBe('REFUND');
    expect(normalized?.status).toBe('REFUNDED');
    expect(normalized?.willRenew).toBe(false);
  });

  it('returns null for an envelope with neither notification kind', () => {
    expect(
      normalizeGoogleNotification({ packageName: 'com.kinmap.app' }, context, 'msg-empty'),
    ).toBeNull();
  });
});
