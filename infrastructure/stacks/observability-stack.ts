import { ArnFormat, Duration, Stack } from 'aws-cdk-lib';
import {
  Alarm,
  ComparisonOperator,
  Dashboard,
  GraphWidget,
  MathExpression,
  Metric,
  TextWidget,
  TreatMissingData,
  type IMetric,
} from 'aws-cdk-lib/aws-cloudwatch';
import { Effect, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { LogGroup } from 'aws-cdk-lib/aws-logs';
import type { ITopic } from 'aws-cdk-lib/aws-sns';
import { CfnCanary } from 'aws-cdk-lib/aws-synthetics';
import type { Construct } from 'constructs';

import {
  cdkEnvironment,
  EDGE_REGION,
  type DataConsumerStackProps,
  type EnvironmentConfig,
} from '../config/index.js';
import { AlarmSet } from '../constructs/alarm-set.js';
import { SecureBucket } from '../constructs/secure-bucket.js';

/**
 * Platform observability: the incident topic, the dashboards an on-call
 * engineer opens first, and the alarms that wake them.
 *
 * Two design choices are worth stating, because both look like omissions:
 *
 *  1. **Alarms are search expressions, not resource references.** Every alarm
 *     here resolves its metrics with CloudWatch `SEARCH` over the resource-name
 *     prefix instead of importing a queue, function or table. That keeps this
 *     stack free of cross-stack CloudFormation exports, so an alarm threshold
 *     can be changed and deployed without sequencing behind the service that
 *     emits the metric — and a newly added queue is covered the moment it
 *     exists rather than the next time somebody remembers to wire it up.
 *
 *  2. **No dimension may be a coordinate.** Metric dimensions are queryable for
 *     months, exportable, and fan out to email and pagers through SNS — well
 *     outside the product's privacy boundary. Every metric name, dimension and
 *     expression built here is pushed through
 *     {@link assertNoCoordinateInTelemetry}, which throws during synth. A stack
 *     that would publish a coordinate fails `cdk synth`, not code review
 *     (spec §20).
 */

// ---------------------------------------------------------------------------
// Privacy guard
// ---------------------------------------------------------------------------

/**
 * Identifiers that carry, or are conventionally used to carry, a precise fix.
 * Mirrors the runtime deny-list in `@family/observability`; it is restated here
 * because the CDK app must not take a dependency on a Lambda runtime package
 * merely to validate strings at synth time.
 */
const COORDINATE_TOKENS: readonly string[] = [
  'lat',
  'latitude',
  'lon',
  'lng',
  'longitude',
  'coord',
  'coords',
  'coordinate',
  'coordinates',
  'latlng',
  'latlon',
  'latitudee7',
  'longitudee7',
  'preciselocation',
  'geopoint',
  'position',
];

/** A decimal carrying four or more fractional digits resolves to ~11m or finer. */
const COORDINATE_SHAPED_VALUE = /-?\d{1,3}\.\d{4,}/;

/**
 * Throws when a telemetry token is a coordinate identifier or is
 * coordinate-shaped. Exported so any stack can apply the same gate before
 * publishing a metric definition.
 *
 * @param context where the token came from, used in the failure message
 * @param tokens metric names, dimension names and values, widget titles
 */
export function assertNoCoordinateInTelemetry(context: string, tokens: readonly string[]): void {
  for (const token of tokens) {
    const normalised = token.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (COORDINATE_TOKENS.includes(normalised)) {
      throw new Error(
        `${context}: "${token}" is a coordinate identifier and must never become a metric name ` +
          'or dimension. Emit a coarse geohash instead (spec §20).',
      );
    }
    if (COORDINATE_SHAPED_VALUE.test(token)) {
      throw new Error(
        `${context}: "${token}" is coordinate-shaped and must never reach CloudWatch (spec §20).`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Metric vocabulary
// ---------------------------------------------------------------------------

/**
 * Custom metrics the services publish as CloudWatch Embedded Metric Format via
 * `@family/observability`. Services choose their own dimensions; the alarms
 * below aggregate with `SEARCH`, so adding a dimension never silently blinds an
 * alarm.
 */
export const APP_METRICS = {
  authorizationDenied: 'AuthorizationDenied',
  locationEventAccepted: 'LocationEventAccepted',
  locationEventRejected: 'LocationEventRejected',
  locationEventDuplicate: 'LocationEventDuplicate',
  locationEventInvalidAccuracy: 'LocationEventInvalidAccuracy',
  locationFreshnessSeconds: 'LocationFreshnessSeconds',
  staleSharingUsers: 'StaleSharingUsers',
  geofenceEventProcessed: 'GeofenceEventProcessed',
  geofenceEventFailed: 'GeofenceEventFailed',
  notificationDelivered: 'NotificationDelivered',
  notificationFailed: 'NotificationFailed',
  subscriptionWebhookFailed: 'SubscriptionWebhookFailed',
  migrationProgressPercent: 'MigrationProgressPercent',
  migrationFailed: 'MigrationFailed',
  deletionJobOldestAgeHours: 'DeletionJobOldestAgeHours',
} as const;

/** Short environment codes; a Synthetics canary name is capped at 21 characters. */
const ENV_CODES: Record<string, string> = {
  development: 'dev',
  staging: 'stg',
  production: 'prd',
};

const FIVE_MINUTES = Duration.minutes(5);
const PERIOD_SECONDS = 300;

/**
 * Queue names, minus the environment prefix.
 *
 * A queue missing from this list is simply not alarmed on — `queue-inventory`
 * in the deploy checks compares it against the queues that actually exist.
 */
const WORK_QUEUES = ['geofence-evaluation', 'notification-commands', 'subscription-events'];
const DEAD_LETTER_QUEUES = [...WORK_QUEUES, 'mail-forwarder', 'migration-schedule'];

type AlarmOptions = {
  readonly name: string;
  readonly metric: IMetric;
  readonly threshold: number;
  readonly evaluationPeriods: number;
  readonly description: string;
  readonly comparisonOperator?: ComparisonOperator;
  readonly treatMissingData?: TreatMissingData;
};

export interface ObservabilityStackProps extends DataConsumerStackProps {
  /** HTTP API id, when the API stack can supply it. Narrows the API searches. */
  readonly apiId?: string;
  /** Route the canary probes. Defaults to `/health`. */
  readonly healthCheckPath?: string;
  /** EMF namespace the services publish into. Defaults to `Kinmap/<env>`. */
  readonly metricNamespace?: string;
}

export class ObservabilityStack extends Stack {
  /** Paging topic. Distinct from the foundation's operational alarm topic. */
  public readonly incidentTopic: ITopic;
  /** Namespace services must publish EMF into; pass as `METRICS_NAMESPACE`. */
  public readonly metricNamespace: string;
  /** Shared cross-service log group owned by this stack. */
  public readonly platformLogGroup: LogGroup;
  public readonly canaryName: string;

  private readonly config: EnvironmentConfig;

  public constructor(scope: Construct, id: string, props: ObservabilityStackProps) {
    super(scope, id, {
      ...props,
      env: cdkEnvironment(props.config),
      description: `Kinmap ${props.config.envName} — incident routing, dashboards, alarms and the API canary`,
    });

    const { config, foundation, tables } = props;
    this.config = config;
    this.metricNamespace = props.metricNamespace ?? `Kinmap/${config.envName}`;
    const envCode = ENV_CODES[config.envName] ?? config.envName.slice(0, 3).toLowerCase();
    this.canaryName = `kinmap-${envCode}-health`;

    assertNoCoordinateInTelemetry('metric namespace', [this.metricNamespace]);
    assertNoCoordinateInTelemetry('metric vocabulary', Object.values(APP_METRICS));

    // -----------------------------------------------------------------------
    // Incident routing. The foundation's topic carries routine operational
    // alarms; this one is the paging surface, so it can be subscribed to a
    // rotation without also delivering every warning.
    // -----------------------------------------------------------------------

    this.incidentTopic = new AlarmSet(this, 'Incidents', {
      config,
      topicName: 'incidents',
      encryptionKey: foundation.operationsKey,
    }).topic;

    // -----------------------------------------------------------------------
    // Log retention. Service log groups belong to the stacks that own the
    // functions (NodeService creates each with `config.logRetention`); this
    // stack owns the shared cross-service group.
    // -----------------------------------------------------------------------

    this.platformLogGroup = new LogGroup(this, 'PlatformLogGroup', {
      logGroupName: `/kinmap/${config.envName}/platform`,
      retention: config.logRetention,
      removalPolicy: config.removalPolicy,
    });

    // -----------------------------------------------------------------------
    // API
    // -----------------------------------------------------------------------

    const apiFilter = props.apiId === undefined ? '' : ` ApiId="${props.apiId}"`;
    const apiSchema = '{AWS/ApiGateway,ApiId}';

    const apiRequests = this.search(
      'ApiRequestVolume',
      'API requests',
      `SUM(SEARCH('${apiSchema} MetricName="Count"${apiFilter}', 'Sum', ${PERIOD_SECONDS}))`,
    );
    const apiLatency = this.search(
      'ApiLatencyP99',
      'API p99 (ms)',
      `MAX(SEARCH('${apiSchema} MetricName="Latency"${apiFilter}', 'p99', ${PERIOD_SECONDS}))`,
    );
    const api4xx = this.search(
      'Api4xx',
      'API 4xx',
      `SUM(SEARCH('${apiSchema} MetricName="4xx"${apiFilter}', 'Sum', ${PERIOD_SECONDS}))`,
    );
    const api5xx = this.search(
      'Api5xx',
      'API 5xx',
      `SUM(SEARCH('${apiSchema} MetricName="5xx"${apiFilter}', 'Sum', ${PERIOD_SECONDS}))`,
    );

    const apiVolumeAlarm = this.alarm('ApiRequestVolumeAlarm', {
      name: 'api-request-volume',
      metric: this.apiMetric(
        'ApiRequestVolumeAlarmMetric',
        'API requests',
        'Count',
        'Sum',
        props.apiId,
      ),
      threshold: config.isProduction ? 200_000 : 50_000,
      evaluationPeriods: 2,
      description:
        'API request volume is far outside its envelope: abuse, or a client retry storm.',
    });
    const apiLatencyAlarm = this.alarm('ApiLatencyAlarm', {
      name: 'api-latency-p99',
      metric: this.apiMetric(
        'ApiLatencyAlarmMetric',
        'API p99 (ms)',
        'Latency',
        'p99',
        props.apiId,
      ),
      threshold: config.alarmThresholds.apiLatencyP99Millis,
      evaluationPeriods: 3,
      description: 'API p99 latency is above the agreed budget.',
    });
    const api4xxAlarm = this.alarm('Api4xxAlarm', {
      name: 'api-4xx',
      metric: this.apiMetric('Api4xxAlarmMetric', 'API 4xx', '4xx', 'Sum', props.apiId),
      threshold: config.isProduction ? 500 : 200,
      evaluationPeriods: 3,
      description: 'Elevated 4xx: a client contract has probably broken.',
    });
    const api5xxAlarm = this.alarm('Api5xxAlarm', {
      name: 'api-5xx',
      metric: this.apiMetric('Api5xxAlarmMetric', 'API 5xx', '5xx', 'Sum', props.apiId),
      threshold: config.alarmThresholds.apiServerErrors,
      evaluationPeriods: 2,
      description: 'The API is returning server errors.',
    });

    const canaryAlarm = this.createCanary(props);

    new AlarmSet(this, 'ApiHealth', { config, topic: this.incidentTopic })
      .add(api5xxAlarm, apiLatencyAlarm, canaryAlarm, apiVolumeAlarm, api4xxAlarm)
      .compositeAlarm(
        'ApiHealthComposite',
        'The API is unhealthy: server errors, latency, traffic anomaly or a failing canary.',
      );

    // -----------------------------------------------------------------------
    // Authorization. A spike in opaque FORBIDDEN responses is what probing for
    // family membership looks like from the outside (spec §34).
    // -----------------------------------------------------------------------

    const authorizationDenied = this.appMetric(
      'AuthorizationDenied',
      APP_METRICS.authorizationDenied,
      'Authorization denials',
    );
    const authorizationAlarm = this.alarm('AuthorizationFailureAlarm', {
      name: 'authorization-failures',
      metric: authorizationDenied,
      threshold: config.isProduction ? 100 : 50,
      evaluationPeriods: 2,
      description:
        'Authorization denials have spiked. Investigate the audit trail, never the coordinates.',
    });

    // -----------------------------------------------------------------------
    // Location ingestion
    // -----------------------------------------------------------------------

    const accepted = this.appMetric(
      'LocationAccepted',
      APP_METRICS.locationEventAccepted,
      'Accepted',
    );
    const rejected = this.appMetric(
      'LocationRejected',
      APP_METRICS.locationEventRejected,
      'Rejected',
    );
    const duplicate = this.appMetric(
      'LocationDuplicate',
      APP_METRICS.locationEventDuplicate,
      'Deduplicated',
    );
    const invalidAccuracy = this.appMetric(
      'LocationInvalidAccuracy',
      APP_METRICS.locationEventInvalidAccuracy,
      'Failed the accuracy gate',
    );
    const freshness = this.appMetric(
      'LocationFreshness',
      APP_METRICS.locationFreshnessSeconds,
      'Age of newest fix (s)',
      'Average',
    );
    const staleUsers = this.appMetric(
      'StaleUsers',
      APP_METRICS.staleSharingUsers,
      'Sharing users with no recent fix',
      'Maximum',
    );

    const acceptedDropAlarm = this.alarm('LocationAcceptedDropAlarm', {
      name: 'location-accepted-drop',
      metric: accepted,
      threshold: config.isProduction ? 100 : 1,
      comparisonOperator: ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 3,
      // An ingestion pipeline that goes silent is precisely the outage this
      // alarm exists to catch, so in production no data is bad data. Below
      // production there are no users: "no events" is the normal state, and
      // breaching would hold the alarm red forever, which is how a team learns
      // to ignore its alarms.
      treatMissingData: config.isProduction
        ? TreatMissingData.BREACHING
        : TreatMissingData.NOT_BREACHING,
      description: 'Accepted location events have collapsed; ingestion is probably broken.',
    });
    const rejectedAlarm = this.alarm('LocationRejectedAlarm', {
      name: 'location-rejected',
      metric: rejected,
      threshold: config.isProduction ? 2000 : 500,
      evaluationPeriods: 3,
      description: 'Ingestion is rejecting an unusual share of uploads.',
    });
    const duplicateAlarm = this.alarm('LocationDuplicateAlarm', {
      name: 'location-duplicate',
      metric: duplicate,
      threshold: config.isProduction ? 5000 : 1000,
      evaluationPeriods: 3,
      description: 'Deduplication is high: a client is replaying its queue.',
    });
    const invalidAccuracyAlarm = this.alarm('LocationInvalidAccuracyAlarm', {
      name: 'location-invalid-accuracy',
      metric: invalidAccuracy,
      threshold: config.isProduction ? 2000 : 500,
      evaluationPeriods: 3,
      description: 'Many fixes fail the accuracy gate; a platform regression is likely.',
    });
    const freshnessAlarm = this.alarm('LocationFreshnessAlarm', {
      name: 'location-freshness',
      metric: freshness,
      threshold: 3600,
      evaluationPeriods: 3,
      description: 'The freshest fix the platform holds averages over an hour old.',
    });
    const staleUsersAlarm = this.alarm('StaleUsersAlarm', {
      name: 'stale-sharing-users',
      metric: staleUsers,
      threshold: config.isProduction ? 250 : 50,
      evaluationPeriods: 3,
      description:
        'Many users believe they are sharing but nothing is arriving — the UI is lying to them.',
    });

    // -----------------------------------------------------------------------
    // Queues
    // -----------------------------------------------------------------------

    const prefix = config.resourcePrefix;
    const queueDepth = this.search(
      'QueueDepth',
      'Visible messages',
      `MAX(SEARCH('{AWS/SQS,QueueName} MetricName="ApproximateNumberOfMessagesVisible" "${prefix}"', 'Maximum', ${PERIOD_SECONDS}))`,
    );
    const dlqDepth = this.search(
      'DlqDepth',
      'Dead-lettered messages',
      `MAX(SEARCH('{AWS/SQS,QueueName} MetricName="ApproximateNumberOfMessagesVisible" "${prefix}" "dlq"', 'Maximum', ${PERIOD_SECONDS}))`,
    );

    const queueDepthAlarm = this.alarm('QueueDepthAlarm', {
      name: 'queue-depth',
      metric: this.queueDepthMetric(
        'QueueDepthAlarmMetric',
        'Visible messages',
        WORK_QUEUES.map((q) => `${prefix}-${q}`),
      ),
      threshold: 5000,
      evaluationPeriods: 3,
      description: 'A worker queue is backing up.',
    });
    const dlqAlarm = this.alarm('DlqMessagesAlarm', {
      name: 'dlq-messages',
      metric: this.queueDepthMetric(
        'DlqDepthAlarmMetric',
        'Dead-lettered messages',
        DEAD_LETTER_QUEUES.map((q) => `${prefix}-${q}-dlq`),
      ),
      threshold: config.alarmThresholds.deadLetterQueueDepth,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      description: 'A message has been dead-lettered; nothing will retry it without us.',
    });

    new AlarmSet(this, 'IngestionHealth', { config, topic: this.incidentTopic })
      .add(
        acceptedDropAlarm,
        rejectedAlarm,
        duplicateAlarm,
        invalidAccuracyAlarm,
        freshnessAlarm,
        staleUsersAlarm,
        queueDepthAlarm,
        dlqAlarm,
      )
      .compositeAlarm(
        'IngestionHealthComposite',
        'The location pipeline is degraded: ingestion, freshness or queue depth.',
      );

    // -----------------------------------------------------------------------
    // Geofences, notifications, subscriptions
    // -----------------------------------------------------------------------

    const geofenceProcessed = this.appMetric(
      'GeofenceProcessed',
      APP_METRICS.geofenceEventProcessed,
      'Transitions processed',
    );
    const geofenceFailed = this.appMetric(
      'GeofenceFailed',
      APP_METRICS.geofenceEventFailed,
      'Transitions failed',
    );
    const notificationDelivered = this.appMetric(
      'NotificationDelivered',
      APP_METRICS.notificationDelivered,
      'Delivered',
    );
    const notificationFailed = this.appMetric(
      'NotificationFailed',
      APP_METRICS.notificationFailed,
      'Failed',
    );
    const webhookFailed = this.appMetric(
      'SubscriptionWebhookFailed',
      APP_METRICS.subscriptionWebhookFailed,
      'Webhook failures',
    );

    const geofenceAlarm = this.alarm('GeofenceFailureAlarm', {
      name: 'geofence-failures',
      metric: geofenceFailed,
      threshold: 25,
      evaluationPeriods: 2,
      description: 'Arrival and departure alerts are failing; members stop being told, silently.',
    });
    const notificationFailureAlarm = this.alarm('NotificationFailureAlarm', {
      name: 'notification-failures',
      metric: notificationFailed,
      threshold: 50,
      evaluationPeriods: 2,
      description: 'Push delivery is failing.',
    });
    const notificationSilenceAlarm = this.alarm('NotificationSilenceAlarm', {
      name: 'notification-silence',
      metric: notificationDelivered,
      threshold: 1,
      comparisonOperator: ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 6,
      description: 'No notification has been delivered for thirty minutes.',
    });
    const webhookAlarm = this.alarm('SubscriptionWebhookAlarm', {
      name: 'subscription-webhook-failures',
      metric: webhookFailed,
      threshold: 5,
      evaluationPeriods: 2,
      description: 'Subscription webhooks are failing; entitlements will drift from the store.',
    });

    new AlarmSet(this, 'DeliveryHealth', { config, topic: this.incidentTopic })
      .add(geofenceAlarm, notificationFailureAlarm, notificationSilenceAlarm, webhookAlarm)
      .compositeAlarm(
        'DeliveryHealthComposite',
        'Something the family was promised is not being delivered.',
      );

    // -----------------------------------------------------------------------
    // Maintenance: migrations and deletion jobs
    // -----------------------------------------------------------------------

    const migrationProgress = this.appMetric(
      'MigrationProgress',
      APP_METRICS.migrationProgressPercent,
      'Migration completion (%)',
      'Minimum',
    );
    const migrationFailed = this.appMetric(
      'MigrationFailed',
      APP_METRICS.migrationFailed,
      'Failed migrations',
    );
    const deletionAge = this.appMetric(
      'DeletionJobAge',
      APP_METRICS.deletionJobOldestAgeHours,
      'Oldest pending deletion (h)',
      'Maximum',
    );

    const migrationStalledAlarm = this.alarm('MigrationStalledAlarm', {
      name: 'migration-stalled',
      metric: migrationProgress,
      threshold: 100,
      comparisonOperator: ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 12,
      description: 'A data migration has been incomplete for an hour.',
    });
    const migrationFailedAlarm = this.alarm('MigrationFailedAlarm', {
      name: 'migration-failed',
      metric: migrationFailed,
      threshold: 0,
      evaluationPeriods: 1,
      description: 'A data migration reported FAILED.',
    });
    const deletionAgeAlarm = this.alarm('DeletionJobAgeAlarm', {
      name: 'deletion-job-age',
      metric: deletionAge,
      threshold: 24,
      evaluationPeriods: 1,
      description:
        'A deletion request has been pending for over 24 hours. That is a broken promise to a user, not a backlog.',
    });

    // -----------------------------------------------------------------------
    // Platform capacity and cost
    // -----------------------------------------------------------------------

    const lambdaThrottles = this.search(
      'LambdaThrottles',
      'Lambda throttles',
      `SUM(SEARCH('{AWS/Lambda,FunctionName} MetricName="Throttles" "${prefix}"', 'Sum', ${PERIOD_SECONDS}))`,
    );
    const dynamoThrottles = this.search(
      'DynamoThrottles',
      'DynamoDB throttles',
      `SUM(SEARCH('{AWS/DynamoDB,TableName} MetricName="ReadThrottleEvents" "${prefix}"', 'Sum', ${PERIOD_SECONDS})) + ` +
        `SUM(SEARCH('{AWS/DynamoDB,TableName} MetricName="WriteThrottleEvents" "${prefix}"', 'Sum', ${PERIOD_SECONDS}))`,
    );

    const lambdaThrottleAlarm = this.alarm('LambdaThrottleAlarm', {
      name: 'lambda-throttles',
      metric: this.aggregate(
        'LambdaThrottleAlarmMetric',
        'Lambda throttles',
        'AWS/Lambda',
        'Throttles',
        'Sum',
      ),
      threshold: config.alarmThresholds.lambdaThrottles,
      evaluationPeriods: 2,
      description: 'Lambda concurrency is being throttled.',
    });
    const dynamoThrottleAlarm = this.alarm('DynamoThrottleAlarm', {
      name: 'dynamodb-throttles',
      metric: this.tableThrottleMetric('DynamoThrottleAlarmMetric'),
      threshold: config.alarmThresholds.tableThrottles,
      evaluationPeriods: 2,
      description: 'DynamoDB is throttling reads or writes.',
    });

    // The monthly budget itself lives in FoundationStack (Budgets is a global
    // service and must be created once, in us-east-1). This adds the paging
    // half: month-to-date spend against the same ceiling. AWS/Billing only
    // publishes in us-east-1 and an alarm cannot read another region's metric.
    const costAlarm =
      config.region === EDGE_REGION
        ? this.alarm('EstimatedCostAlarm', {
            name: 'estimated-cost',
            metric: new Metric({
              namespace: 'AWS/Billing',
              metricName: 'EstimatedCharges',
              dimensionsMap: { Currency: 'USD' },
              statistic: 'Maximum',
              period: Duration.hours(6),
            }),
            threshold: config.monthlyBudgetUsd,
            evaluationPeriods: 1,
            description: 'Estimated month-to-date charges have passed the monthly budget.',
          })
        : undefined;

    new AlarmSet(this, 'PlatformCapacity', { config, topic: this.incidentTopic })
      .add(
        lambdaThrottleAlarm,
        dynamoThrottleAlarm,
        authorizationAlarm,
        migrationStalledAlarm,
        migrationFailedAlarm,
        deletionAgeAlarm,
        costAlarm,
      )
      .compositeAlarm(
        'PlatformCapacityComposite',
        'Platform capacity, maintenance or cost needs attention.',
      );

    // -----------------------------------------------------------------------
    // Dashboards
    // -----------------------------------------------------------------------

    const locationTableErrors = [
      tables.currentLocations.metric('SystemErrors', { statistic: 'Sum', period: FIVE_MINUTES }),
      tables.locationHistory.metric('SystemErrors', { statistic: 'Sum', period: FIVE_MINUTES }),
    ];

    new Dashboard(this, 'PlatformDashboard', {
      dashboardName: `${prefix}-platform`,
      widgets: [
        [
          this.graph('API traffic', [apiRequests], [api4xx, api5xx]),
          this.graph('API p99 (ms)', [apiLatency]),
        ],
        [
          this.graph('Lambda throttles', [lambdaThrottles]),
          this.graph('DynamoDB throttles', [dynamoThrottles]),
        ],
        [
          this.graph('Queue depth', [queueDepth], [dlqDepth]),
          this.graph('Location table system errors', locationTableErrors),
        ],
        [
          new TextWidget({
            markdown: [
              `### Cost guardrail — ${config.envName}`,
              '',
              `Monthly budget **$${config.monthlyBudgetUsd}**, enforced by the budget in the`,
              'foundation stack; month-to-date spend pages through',
              `\`${prefix}-incidents\`.`,
              '',
              'No widget on any Kinmap dashboard may plot a coordinate. Every series here is an',
              'aggregate counter resolved by search expression (spec §20).',
            ].join('\n'),
            width: 24,
            height: 5,
          }),
        ],
      ],
    });

    new Dashboard(this, 'LocationDashboard', {
      dashboardName: `${prefix}-location`,
      widgets: [
        [
          this.graph('Ingestion outcome', [accepted], [rejected, duplicate, invalidAccuracy]),
          this.graph('Freshness and staleness', [freshness], [staleUsers]),
        ],
        [
          this.graph('Consent and access', [authorizationDenied]),
          this.graph('Geofence transitions', [geofenceProcessed], [geofenceFailed]),
        ],
        [
          this.graph('Notification delivery', [notificationDelivered], [notificationFailed]),
          this.graph('Maintenance', [migrationProgress], [deletionAge, migrationFailed]),
        ],
      ],
    });
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** A search-expression metric, gated against carrying a coordinate. */
  /**
   * A metric aggregated across every dimension value, suitable for an alarm.
   *
   * Omitting dimensions makes CloudWatch roll the metric up over all of them.
   * That used to be too broad to alarm on, which is why these were SEARCH
   * expressions — but each environment now has its own AWS account, so "every
   * queue in the account" and "every queue belonging to this environment" are
   * the same set. SEARCH is kept for dashboards, where the per-resource
   * breakdown is the point and where CloudWatch actually supports it.
   */
  private aggregate(
    id: string,
    label: string,
    namespace: string,
    metricName: string,
    statistic: string,
  ): Metric {
    assertNoCoordinateInTelemetry(`metric ${id}`, [id, label, metricName]);
    return new Metric({
      namespace,
      metricName,
      statistic,
      label,
      period: FIVE_MINUTES,
    });
  }

  /** One API Gateway metric, dimensioned by API when the id is known. */
  private apiMetric(
    id: string,
    label: string,
    metricName: string,
    statistic: string,
    apiId: string | undefined,
  ): Metric {
    assertNoCoordinateInTelemetry(`metric ${id}`, [id, label, metricName]);
    return new Metric({
      namespace: 'AWS/ApiGateway',
      metricName,
      statistic,
      label,
      period: FIVE_MINUTES,
      dimensionsMap: apiId === undefined ? undefined : { ApiId: apiId },
    });
  }

  /**
   * Depth of the fullest queue in a named set.
   *
   * Named rather than searched because the alarm has to distinguish a work
   * queue from its dead-letter queue: aggregating every queue in the account
   * would make the DLQ alarm fire on ordinary traffic. Names are derived from
   * the resource prefix, so this still adds no cross-stack dependency.
   */
  private queueDepthMetric(id: string, label: string, queueNames: string[]): IMetric {
    assertNoCoordinateInTelemetry(`metric ${id}`, [id, label, ...queueNames]);
    const metrics: Record<string, IMetric> = {};
    queueNames.forEach((queueName, index) => {
      metrics[`q${index}`] = new Metric({
        namespace: 'AWS/SQS',
        metricName: 'ApproximateNumberOfMessagesVisible',
        statistic: 'Maximum',
        period: FIVE_MINUTES,
        dimensionsMap: { QueueName: queueName },
      });
    });
    return new MathExpression({
      expression: `MAX([${Object.keys(metrics).join(',')}])`,
      usingMetrics: metrics,
      label,
      period: FIVE_MINUTES,
    });
  }

  /** Read and write throttles are separate metrics; either one is a problem. */
  private tableThrottleMetric(id: string): IMetric {
    assertNoCoordinateInTelemetry(`metric ${id}`, [id]);
    const throttle = (metricName: string): Metric =>
      new Metric({
        namespace: 'AWS/DynamoDB',
        metricName,
        statistic: 'Sum',
        period: FIVE_MINUTES,
      });
    return new MathExpression({
      expression: 'reads + writes',
      usingMetrics: {
        reads: throttle('ReadThrottleEvents'),
        writes: throttle('WriteThrottleEvents'),
      },
      label: 'DynamoDB throttles',
      period: FIVE_MINUTES,
    });
  }

  private search(id: string, label: string, expression: string): MathExpression {
    assertNoCoordinateInTelemetry(`metric ${id}`, [id, label, expression]);
    return new MathExpression({
      expression,
      label,
      period: FIVE_MINUTES,
      // SEARCH resolves its own time series; there is nothing to bind.
      usingMetrics: {},
    });
  }

  /**
   * Aggregates one application metric across every dimension set the services
   * happen to publish, so a new dimension never blinds an alarm.
   */
  private appMetric(
    id: string,
    metricName: string,
    label: string,
    statistic: 'Sum' | 'Average' | 'Maximum' | 'Minimum' = 'Sum',
  ): IMetric {
    assertNoCoordinateInTelemetry(`metric ${id}`, [id, label, metricName]);

    // A CloudWatch Metrics Insights query, which is neither of the two things
    // that do not work here.
    //
    // SEARCH() aggregates across dimension sets but CloudWatch rejects it on an
    // alarm. A plain un-dimensioned Metric is accepted on an alarm but matches
    // only datapoints published with no dimensions at all — CloudWatch does not
    // roll dimension sets up into an aggregate stream. Services emit some of
    // these with dimensions (`NotificationDelivered` carries `kind`) and some
    // without (`GeofenceEventProcessed`), so an un-dimensioned alarm silently
    // watches an empty stream for half of them.
    //
    // A Metrics Insights query is supported on alarms and aggregates over every
    // dimension set, which is the behaviour these alarms were always assumed to
    // have.
    const aggregate = { Sum: 'SUM', Average: 'AVG', Maximum: 'MAX', Minimum: 'MIN' }[statistic];
    return new MathExpression({
      expression: `SELECT ${aggregate}("${metricName}") FROM "${this.metricNamespace}"`,
      label,
      period: FIVE_MINUTES,
      usingMetrics: {},
    });
  }

  private alarm(id: string, options: AlarmOptions): Alarm {
    assertNoCoordinateInTelemetry(`alarm ${id}`, [id, options.name, options.description]);

    // CloudWatch accepts SEARCH() on a dashboard but rejects it on an alarm:
    //   "SEARCH is not supported on Metric Alarms."
    // It fails only at deploy time, so this catches it at synth instead — an
    // alarm that cannot be created is an alarm nobody is watching.
    const expression = (options.metric as Partial<MathExpression>).expression;
    if (typeof expression === 'string' && expression.includes('SEARCH(')) {
      throw new Error(
        `Alarm '${id}' uses a SEARCH expression, which CloudWatch does not support on ` +
          'alarms. Use an un-dimensioned Metric instead — each environment has its own ' +
          'AWS account, so aggregating across the account is already correctly scoped.',
      );
    }
    return new Alarm(this, id, {
      alarmName: `${this.config.resourcePrefix}-${options.name}`,
      alarmDescription: options.description,
      metric: options.metric,
      threshold: options.threshold,
      evaluationPeriods: options.evaluationPeriods,
      comparisonOperator: options.comparisonOperator ?? ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: options.treatMissingData ?? TreatMissingData.NOT_BREACHING,
    });
  }

  private graph(
    title: string,
    left: readonly IMetric[],
    right: readonly IMetric[] = [],
  ): GraphWidget {
    assertNoCoordinateInTelemetry('dashboard widget', [title]);
    return new GraphWidget({ title, left: [...left], right: [...right], width: 12, height: 6 });
  }

  /**
   * Black-box canary against the public API edge.
   *
   * It probes `/v1/health`, the one unauthenticated route the API exposes, and
   * asserts a response below 500 rather than a specific 200 — a probe holding
   * no JWT gets a 401 from anything else, and that still proves DNS, TLS, the
   * custom domain and the authorizer are alive.
   *
   * The default below is deliberately the real path and not `/`: pointing this
   * at a route that does not exist produces a canary that alarms forever, which
   * is worse than no canary, because a permanently red alarm is one nobody
   * reads.
   */
  private createCanary(props: ObservabilityStackProps): Alarm {
    const { config } = props;
    const url = `https://${config.apiDomain}${props.healthCheckPath ?? '/v1/health'}`;

    // No S3 server access logging: the delivery policy CDK writes onto the log
    // bucket references this bucket's ARN, which would make the foundation
    // stack depend on this one while this one already depends on the
    // foundation's key — a cycle. These artifacts are screenshots and HAR files
    // of our own public endpoint; they contain no user data.
    const artifacts = new SecureBucket(this, 'CanaryArtifacts', {
      config,
      versioned: false,
      expirationDays: 30,
    });

    const role = new Role(this, 'CanaryRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
      description: 'Execution role for the Kinmap API health canary',
    });
    artifacts.grantReadWrite(role);
    role.addToPrincipalPolicy(
      new PolicyStatement({
        sid: 'ResolveArtifactBucket',
        effect: Effect.ALLOW,
        actions: ['s3:GetBucketLocation'],
        resources: [artifacts.bucketArn],
      }),
    );
    role.addToPrincipalPolicy(
      new PolicyStatement({
        sid: 'ListBucketsForCanaryRuntime',
        effect: Effect.ALLOW,
        actions: ['s3:ListAllMyBuckets'],
        resources: ['*'],
      }),
    );
    role.addToPrincipalPolicy(
      new PolicyStatement({
        sid: 'WriteCanaryLogs',
        effect: Effect.ALLOW,
        actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [
          this.formatArn({
            service: 'logs',
            resource: 'log-group',
            resourceName: '/aws/lambda/cwsyn-*',
            arnFormat: ArnFormat.COLON_RESOURCE_NAME,
          }),
        ],
      }),
    );
    role.addToPrincipalPolicy(
      new PolicyStatement({
        sid: 'PublishSyntheticsMetrics',
        effect: Effect.ALLOW,
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
        conditions: { StringEquals: { 'cloudwatch:namespace': 'CloudWatchSynthetics' } },
      }),
    );
    role.addToPrincipalPolicy(
      new PolicyStatement({
        sid: 'TraceCanaryRuns',
        effect: Effect.ALLOW,
        actions: ['xray:PutTraceSegments'],
        resources: ['*'],
      }),
    );

    const script = [
      "const synthetics = require('Synthetics');",
      "const target = new URL('" + url + "');",
      'exports.handler = async function () {',
      '  await synthetics.executeHttpStep(',
      "    'edge-reachable',",
      '    {',
      '      hostname: target.hostname,',
      "      method: 'GET',",
      '      path: target.pathname + target.search,',
      '      port: 443,',
      "      protocol: 'https:',",
      "      headers: { 'User-Agent': 'kinmap-health-canary' },",
      '    },',
      '    async function (response) {',
      '      if (response.statusCode >= 500) {',
      "        throw new Error('API edge returned ' + response.statusCode);",
      '      }',
      '    },',
      '  );',
      '};',
    ].join('\n');

    // The L1 resource keeps the pinned Synthetics runtime an explicit string
    // rather than an enum member whose name moves between CDK releases.
    const canary = new CfnCanary(this, 'ApiHealthCanary', {
      name: this.canaryName,
      artifactS3Location: `s3://${artifacts.bucketName}/canary`,
      executionRoleArn: role.roleArn,
      runtimeVersion: 'syn-nodejs-puppeteer-9.1',
      startCanaryAfterCreation: true,
      schedule: { expression: 'rate(5 minutes)', durationInSeconds: '0' },
      runConfig: { timeoutInSeconds: 60, memoryInMb: 960, activeTracing: true },
      successRetentionPeriod: 7,
      failureRetentionPeriod: 31,
      code: { handler: 'index.handler', script },
    });
    canary.node.addDependency(role);

    assertNoCoordinateInTelemetry('canary metric', ['CanaryName', this.canaryName]);

    return this.alarm('ApiHealthCanaryAlarm', {
      name: 'api-health-canary',
      metric: new Metric({
        namespace: 'CloudWatchSynthetics',
        metricName: 'SuccessPercent',
        dimensionsMap: { CanaryName: this.canaryName },
        statistic: 'Average',
        period: FIVE_MINUTES,
      }),
      threshold: 90,
      comparisonOperator: ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 2,
      treatMissingData: TreatMissingData.BREACHING,
      description: 'The API edge is failing an unauthenticated probe from outside AWS.',
    });
  }
}
