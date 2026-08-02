/**
 * Billing stack — subscription webhooks, the subscription event pipeline and
 * periodic entitlement reconciliation.
 *
 * Design notes that matter for correctness:
 *
 *  - Signature verification is deliberately NOT here. RevenueCat's shared
 *    secret, Apple's JWS certificate chain and Google's Pub/Sub OIDC token are
 *    all verified over the raw request bytes inside the service code, because
 *    only the handler ever sees those bytes. This stack's job is to hand each
 *    service the one secret ARN it needs, and nothing else.
 *
 *  - Webhook handlers do no domain work. They verify, deduplicate on the
 *    provider's own event id via the idempotency table, enqueue, and answer 200
 *    so a provider never retries because of one of our downstream failures and
 *    so the response body cannot be used to probe account state (see
 *    `WebhookAckResponseSchema` in @family/schemas). That is why they hold no
 *    grant at all on the subscriptions table.
 *
 *  - Entitlements are server-authoritative (`ENTITLEMENTS` in
 *    @family/contracts). A store can and does drop notifications, so the worker
 *    is also invoked on a schedule to re-derive entitlements from the store of
 *    record rather than trusting the event stream alone.
 *
 *  - The subscription queue is a standard queue, so events can arrive out of
 *    order. The worker resolves that by ignoring any event older than the
 *    subscription record it is updating, keyed on the provider's own timestamp.
 */
import { CfnOutput, Duration, Stack } from 'aws-cdk-lib';
import { type ITable } from 'aws-cdk-lib/aws-dynamodb';
import { Rule, RuleTargetInput, Schedule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction as LambdaFunctionTarget } from 'aws-cdk-lib/aws-events-targets';
import { Effect, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { type IFunction } from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { type IQueue } from 'aws-cdk-lib/aws-sqs';
import { type Construct } from 'constructs';

import { applyStandardTags, cdkEnvironment } from '../config/index.js';
import { type DataConsumerStackProps, type EnvironmentConfig } from '../config/types.js';
import { NodeService, serviceEntry } from '../constructs/node-service.js';
import { QueueWithDlq } from '../constructs/queue-with-dlq.js';

/** Payload delivered by the reconciliation schedule; the worker branches on it. */
const RECONCILIATION_TASK = 'ENTITLEMENT_RECONCILIATION';

const WEBHOOK_TIMEOUT = Duration.seconds(15);
const WORKER_TIMEOUT = Duration.seconds(60);
const VISIBILITY_TIMEOUT_FACTOR = 6;

/**
 * Secrets Manager ARNs for the billing providers. All optional, for the same
 * reason as the push credentials in NotificationStack: the environment has to
 * be deployable before the store accounts exist. A handler whose secret is
 * absent fails closed at cold start rather than accepting an unverified
 * webhook — an unverified billing webhook is an entitlement forgery.
 */
export interface BillingProviderSecrets {
  /** RevenueCat webhook `Authorization` shared secret. */
  readonly revenueCatSecretArn?: string;
  /** App Store Server API key, also used to pin Apple's root certificates. */
  readonly appleSecretArn?: string;
  /** Google Play service account and the expected Pub/Sub audience. */
  readonly googleSecretArn?: string;
}

export interface BillingStackProps extends DataConsumerStackProps {
  readonly providerSecrets?: BillingProviderSecrets;

  /** Owned by NotificationStack; used for expiry and billing-retry notices. */
  readonly notificationCommandsQueue: IQueue;
}

/** Everything one provider's webhook handler needs. */
interface WebhookServiceOptions {
  readonly config: EnvironmentConfig;
  readonly constructId: string;
  readonly serviceName: string;
  readonly description: string;
  readonly secretEnvironmentVariable: string;
  readonly secretArn: string | undefined;
  readonly idempotencyTable: ITable;
  readonly queue: IQueue;
}

export class BillingStack extends Stack {
  public readonly revenueCatWebhookFunction: IFunction;
  public readonly appleWebhookFunction: IFunction;
  public readonly googleWebhookFunction: IFunction;

  public readonly subscriptionEventsQueue: IQueue;
  public readonly subscriptionWorkerFunction: IFunction;

  constructor(scope: Construct, id: string, props: BillingStackProps) {
    super(scope, id, {
      ...props,
      env: props.env ?? cdkEnvironment(props.config),
      terminationProtection: props.terminationProtection ?? props.config.isProduction,
      description:
        props.description ?? 'Kinmap subscription webhooks and entitlement reconciliation.',
    });

    const { config, tables } = props;
    const secrets: BillingProviderSecrets = props.providerSecrets ?? {};

    applyStandardTags(this, config);

    // -----------------------------------------------------------------------
    // Subscription event queue
    // -----------------------------------------------------------------------

    const subscriptionEvents = new QueueWithDlq(this, 'SubscriptionEventsQueue', {
      config,
      queueName: `${config.resourcePrefix}-subscription-events`,
      visibilityTimeout: Duration.seconds(WORKER_TIMEOUT.toSeconds() * VISIBILITY_TIMEOUT_FACTOR),
      maxReceiveCount: 5,
    });
    this.subscriptionEventsQueue = subscriptionEvents.queue;

    // -----------------------------------------------------------------------
    // Webhook handlers
    //
    // One function per provider: the three verification schemes share nothing,
    // and a flood or an outage at one store must not consume the concurrency
    // the other two need to keep entitlements correct.
    // -----------------------------------------------------------------------

    this.revenueCatWebhookFunction = this.addWebhookService({
      config,
      constructId: 'RevenueCatWebhookService',
      serviceName: 'revenuecat-webhook',
      description: 'Verifies and enqueues RevenueCat subscription webhooks.',
      secretEnvironmentVariable: 'REVENUECAT_WEBHOOK_SECRET_ARN',
      secretArn: secrets.revenueCatSecretArn,
      idempotencyTable: tables.idempotency,
      queue: this.subscriptionEventsQueue,
    });

    this.appleWebhookFunction = this.addWebhookService({
      config,
      constructId: 'AppleWebhookService',
      serviceName: 'apple-webhook',
      description: 'Verifies and enqueues App Store Server Notifications V2.',
      secretEnvironmentVariable: 'APPLE_WEBHOOK_SECRET_ARN',
      secretArn: secrets.appleSecretArn,
      idempotencyTable: tables.idempotency,
      queue: this.subscriptionEventsQueue,
    });

    this.googleWebhookFunction = this.addWebhookService({
      config,
      constructId: 'GoogleWebhookService',
      serviceName: 'google-webhook',
      description: 'Verifies and enqueues Google Play real-time developer notifications.',
      secretEnvironmentVariable: 'GOOGLE_WEBHOOK_SECRET_ARN',
      secretArn: secrets.googleSecretArn,
      idempotencyTable: tables.idempotency,
      queue: this.subscriptionEventsQueue,
    });

    // -----------------------------------------------------------------------
    // services/subscription-worker
    //
    // Two invocation shapes: SQS batches from the webhook path, and a scheduled
    // event carrying `{ task: 'ENTITLEMENT_RECONCILIATION' }`. The handler
    // discriminates on the presence of `Records`.
    // -----------------------------------------------------------------------

    const workerEnvironment: Record<string, string> = {
      SUBSCRIPTIONS_TABLE: tables.subscriptions.tableName,
      FAMILY_MEMBERSHIPS_TABLE: tables.familyMemberships.tableName,
      IDEMPOTENCY_TABLE: tables.idempotency.tableName,
      NOTIFICATION_COMMANDS_QUEUE_URL: props.notificationCommandsQueue.queueUrl,
      RECONCILIATION_TASK_NAME: RECONCILIATION_TASK,
    };

    // Reconciliation calls the stores directly, so it needs the same
    // credentials as the webhook handlers wherever they are configured.
    const workerSecretArns: string[] = [];
    if (secrets.revenueCatSecretArn !== undefined && secrets.revenueCatSecretArn !== '') {
      workerEnvironment.REVENUECAT_WEBHOOK_SECRET_ARN = secrets.revenueCatSecretArn;
      workerSecretArns.push(secrets.revenueCatSecretArn);
    }
    if (secrets.appleSecretArn !== undefined && secrets.appleSecretArn !== '') {
      workerEnvironment.APPLE_WEBHOOK_SECRET_ARN = secrets.appleSecretArn;
      workerSecretArns.push(secrets.appleSecretArn);
    }
    if (secrets.googleSecretArn !== undefined && secrets.googleSecretArn !== '') {
      workerEnvironment.GOOGLE_WEBHOOK_SECRET_ARN = secrets.googleSecretArn;
      workerSecretArns.push(secrets.googleSecretArn);
    }

    const worker = new NodeService(this, 'SubscriptionWorkerService', {
      config,
      serviceName: 'subscription-worker',
      description: 'Applies subscription events and reconciles entitlements.',
      memorySize: 1024,
      timeout: WORKER_TIMEOUT,
      environment: workerEnvironment,
    });
    this.subscriptionWorkerFunction = worker.function;

    tables.subscriptions.grantReadWriteData(this.subscriptionWorkerFunction);
    tables.familyMemberships.grantReadData(this.subscriptionWorkerFunction);
    tables.idempotency.grantReadWriteData(this.subscriptionWorkerFunction);
    props.notificationCommandsQueue.grantSendMessages(this.subscriptionWorkerFunction);
    this.grantSecretRead(this.subscriptionWorkerFunction, workerSecretArns);

    this.subscriptionWorkerFunction.addEventSource(
      new SqsEventSource(this.subscriptionEventsQueue, {
        batchSize: 10,
        maxBatchingWindow: Duration.seconds(5),
        reportBatchItemFailures: true,
      }),
    );

    // -----------------------------------------------------------------------
    // Periodic entitlement reconciliation
    //
    // On the default bus, because scheduled rules are only supported there.
    // Frequent in production, where a missed downgrade means a family keeps a
    // paid feature indefinitely; lazy elsewhere, because it costs store API
    // quota that the sandbox environments share.
    // -----------------------------------------------------------------------

    const reconciliationSchedule = new Rule(this, 'EntitlementReconciliationSchedule', {
      ruleName: `${config.resourcePrefix}-entitlement-reconciliation`,
      description: 'Re-derives entitlements from the stores of record.',
      schedule: Schedule.rate(config.isProduction ? Duration.hours(6) : Duration.hours(24)),
      enabled: true,
    });

    reconciliationSchedule.addTarget(
      new LambdaFunctionTarget(this.subscriptionWorkerFunction, {
        event: RuleTargetInput.fromObject({ task: RECONCILIATION_TASK }),
        retryAttempts: 2,
        maxEventAge: Duration.hours(1),
      }),
    );

    // -----------------------------------------------------------------------
    // Outputs
    // -----------------------------------------------------------------------

    new CfnOutput(this, 'SubscriptionEventsQueueUrl', {
      value: this.subscriptionEventsQueue.queueUrl,
      description: 'Queue consumed by services/subscription-worker.',
    });

    new CfnOutput(this, 'EntitlementReconciliationRuleName', {
      value: reconciliationSchedule.ruleName,
      description: 'EventBridge rule driving periodic entitlement reconciliation.',
    });
  }

  /**
   * Builds one provider's webhook handler. The grants are identical and minimal
   * by construction: deduplicate, enqueue, read one secret.
   */
  private addWebhookService(options: WebhookServiceOptions): IFunction {
    const environment: Record<string, string> = {
      IDEMPOTENCY_TABLE: options.idempotencyTable.tableName,
      SUBSCRIPTION_EVENTS_QUEUE_URL: options.queue.queueUrl,
    };
    const secretArn =
      options.secretArn !== undefined && options.secretArn !== '' ? options.secretArn : undefined;
    if (secretArn !== undefined) {
      environment[options.secretEnvironmentVariable] = secretArn;
    }

    const service = new NodeService(this, options.constructId, {
      config: options.config,
      serviceName: options.serviceName,
      // All three providers are verified by services/subscription-worker, whose
      // handler dispatches on the request path. Deploying it three times keeps
      // per-provider isolation — a malformed Apple payload cannot throttle
      // RevenueCat — while the verification logic stays in one place.
      entry: serviceEntry('subscription-worker'),
      description: options.description,
      memorySize: 512,
      timeout: WEBHOOK_TIMEOUT,
      environment,
    });

    options.idempotencyTable.grantReadWriteData(service.function);
    options.queue.grantSendMessages(service.function);
    this.grantSecretRead(service.function, secretArn === undefined ? [] : [secretArn]);

    return service.function;
  }

  /**
   * Secrets Manager hands out ARNs with a six-character suffix, but operators
   * frequently configure the unsuffixed form. Both are accepted so that a
   * configuration detail cannot turn into an opaque AccessDenied at cold start.
   */
  private grantSecretRead(grantee: IFunction, secretArns: string[]): void {
    if (secretArns.length === 0) {
      return;
    }
    grantee.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['secretsmanager:GetSecretValue'],
        resources: secretArns.flatMap((arn) => [arn, `${arn}-??????`]),
      }),
    );
  }
}
