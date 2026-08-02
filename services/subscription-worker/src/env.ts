import { AppEnvSchema, PlanSchema, type AppEnv, type Plan } from '@family/contracts';

/**
 * Typed configuration for services/subscription-worker.
 *
 * Fails closed. A missing table name or queue URL is a hard cold-start failure;
 * a missing provider secret disables only that provider's webhook, which is
 * reported as an unverified request rather than an accepted one.
 */

export type EnvSource = Readonly<Record<string, string | undefined>>;

export class ConfigurationError extends Error {
  constructor(readonly variable: string) {
    super(`Required environment variable ${variable} is missing or empty.`);
    this.name = 'ConfigurationError';
  }
}

export function requireString(source: EnvSource, name: string): string {
  const raw = source[name];
  if (raw === undefined) throw new ConfigurationError(name);
  const trimmed = raw.trim();
  if (trimmed.length === 0) throw new ConfigurationError(name);
  return trimmed;
}

export function optionalString(source: EnvSource, name: string): string | undefined {
  const raw = source[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function optionalNumber(source: EnvSource, name: string, fallback: number): number {
  const raw = optionalString(source, name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function readAppEnv(source: EnvSource): AppEnv {
  const parsed = AppEnvSchema.safeParse(optionalString(source, 'APP_ENV') ?? 'development');
  return parsed.success ? parsed.data : 'development';
}

/**
 * Store product identifiers mapped onto the platform's own plan vocabulary.
 * The default covers the shipped catalogue; `PRODUCT_PLAN_MAP` (a JSON object)
 * lets a new SKU be onboarded without a deployment.
 */
export const DEFAULT_PRODUCT_PLAN_MAP: Readonly<Record<string, Plan>> = {
  'kinmap.family.monthly': 'FAMILY_MONTHLY',
  'kinmap.family.annual': 'FAMILY_ANNUAL',
  'kinmap.familyplus.monthly': 'FAMILY_PLUS_MONTHLY',
  'kinmap.familyplus.annual': 'FAMILY_PLUS_ANNUAL',
};

export function readProductPlanMap(source: EnvSource): Record<string, Plan> {
  const raw = optionalString(source, 'PRODUCT_PLAN_MAP');
  const map: Record<string, Plan> = { ...DEFAULT_PRODUCT_PLAN_MAP };
  if (raw === undefined) return map;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A malformed override must not silently unmap the whole catalogue.
    return map;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return map;

  for (const [productId, planName] of Object.entries(parsed as Record<string, unknown>)) {
    const plan = PlanSchema.safeParse(planName);
    if (plan.success) map[productId] = plan.data;
  }
  return map;
}

export type SubscriptionWorkerConfig = {
  readonly appEnv: AppEnv;
  readonly serviceName: string;
  readonly metricsNamespace: string;
  readonly subscriptionsTable: string;
  readonly familyMembershipsTable: string;
  readonly savedPlacesTable: string;
  readonly idempotencyTable: string;
  readonly subscriptionEventsQueueUrl: string;
  readonly notificationCommandsQueueUrl: string;
  readonly reconciliationTaskName: string;
  readonly productPlanMap: Record<string, Plan>;
  /** Secrets Manager ARNs; absent means that provider's webhook is disabled. */
  readonly revenueCatSecretArn: string | undefined;
  readonly appleSecretArn: string | undefined;
  readonly googleSecretArn: string | undefined;
  /** Expected `aud` on the Pub/Sub OIDC token, and the pusher's service account. */
  readonly googlePubSubAudience: string | undefined;
  readonly googlePubSubServiceAccountEmail: string | undefined;
  readonly appleBundleId: string | undefined;
  readonly idempotencyTtlSeconds: number;
};

export function loadConfig(source: EnvSource = process.env): SubscriptionWorkerConfig {
  const appEnv = readAppEnv(source);
  return {
    appEnv,
    serviceName: optionalString(source, 'SERVICE_NAME') ?? 'subscription-worker',
    metricsNamespace: optionalString(source, 'METRICS_NAMESPACE') ?? `Kinmap/${appEnv}`,
    subscriptionsTable: requireString(source, 'SUBSCRIPTIONS_TABLE'),
    familyMembershipsTable: requireString(source, 'FAMILY_MEMBERSHIPS_TABLE'),
    savedPlacesTable: requireString(source, 'SAVED_PLACES_TABLE'),
    idempotencyTable: requireString(source, 'IDEMPOTENCY_TABLE'),
    subscriptionEventsQueueUrl: requireString(source, 'SUBSCRIPTION_EVENTS_QUEUE_URL'),
    notificationCommandsQueueUrl: requireString(source, 'NOTIFICATION_COMMANDS_QUEUE_URL'),
    reconciliationTaskName:
      optionalString(source, 'RECONCILIATION_TASK_NAME') ?? 'ENTITLEMENT_RECONCILIATION',
    productPlanMap: readProductPlanMap(source),
    revenueCatSecretArn: optionalString(source, 'REVENUECAT_WEBHOOK_SECRET_ARN'),
    appleSecretArn: optionalString(source, 'APPLE_WEBHOOK_SECRET_ARN'),
    googleSecretArn: optionalString(source, 'GOOGLE_WEBHOOK_SECRET_ARN'),
    googlePubSubAudience: optionalString(source, 'GOOGLE_PUBSUB_AUDIENCE'),
    googlePubSubServiceAccountEmail: optionalString(source, 'GOOGLE_PUBSUB_SERVICE_ACCOUNT_EMAIL'),
    appleBundleId: optionalString(source, 'APPLE_BUNDLE_ID'),
    idempotencyTtlSeconds: optionalNumber(
      source,
      'SUBSCRIPTION_IDEMPOTENCY_TTL_SECONDS',
      7 * 86_400,
    ),
  };
}
