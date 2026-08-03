/**
 * Maintenance stack — the jobs that keep promises from quietly lapsing.
 *
 * `services/scheduled-maintenance` was deployed by nothing, so none of these
 * ran. The consequences were not cosmetic: live sessions never expired on the
 * server side, invitations never lapsed, stale sharing users were never marked,
 * the freshness and queue-depth metrics that three alarms watch were never
 * published, and — worst — no erasure job was ever handed to the deletion
 * worker, so every account deletion request sat in its table untouched.
 *
 * Every job is independently invocable and independently scheduled, so one
 * failing job cannot stop the others, and any of them can be run by hand
 * (`{"job":"expire-invitations","dryRun":true}`) to rehearse a change.
 *
 * Rules are on the default event bus because `Schedule.rate`/`cron` is only
 * supported there, matching the reconciliation schedule in the billing stack.
 */
import { CfnOutput, Duration, Stack } from 'aws-cdk-lib';
import { Rule, RuleTargetInput, Schedule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction } from 'aws-cdk-lib/aws-events-targets';
import { Effect, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { type IFunction } from 'aws-cdk-lib/aws-lambda';
import { type IQueue } from 'aws-cdk-lib/aws-sqs';
import { type Construct } from 'constructs';

import { applyStandardTags, cdkEnvironment } from '../config/index.js';
import { type DataConsumerStackProps } from '../config/types.js';
import { NodeService } from '../constructs/node-service.js';

const MAINTENANCE_TIMEOUT = Duration.minutes(5);

/**
 * One entry per job, with the cadence it needs rather than a single sweep.
 *
 * The reasoning behind each interval matters more than the number:
 *  - live sessions and deletions are the two where lateness is a broken
 *    promise to a person, so they run often;
 *  - the metric jobs run on the alarm period, because a metric published less
 *    often than its alarm evaluates leaves the alarm permanently in INSUFFICIENT
 *    DATA;
 *  - the history sweep is a backstop behind DynamoDB TTL, so it runs nightly.
 */
const SCHEDULED_JOBS: ReadonlyArray<{
  readonly job: string;
  readonly id: string;
  readonly schedule: Schedule;
  readonly why: string;
}> = [
  {
    job: 'expire-live-sessions',
    id: 'ExpireLiveSessions',
    schedule: Schedule.rate(Duration.minutes(5)),
    why: 'A live session that outlives its timer is someone being followed after they stopped agreeing to it.',
  },
  {
    job: 'dispatch-deletions',
    id: 'DispatchDeletions',
    schedule: Schedule.rate(Duration.minutes(15)),
    why: 'Hands due erasure jobs to the deletion worker. Without it a deletion request is accepted and never acted on.',
  },
  {
    job: 'expire-invitations',
    id: 'ExpireInvitations',
    schedule: Schedule.rate(Duration.hours(1)),
    why: 'Invitations are valid for 72 hours; hourly is well inside that.',
  },
  {
    job: 'mark-stale-users',
    id: 'MarkStaleUsers',
    schedule: Schedule.rate(Duration.minutes(15)),
    why: 'A member shown as sharing whose fixes stopped arriving must be shown as stale, not as last known.',
  },
  {
    job: 'emit-freshness-metrics',
    id: 'EmitFreshnessMetrics',
    schedule: Schedule.rate(Duration.minutes(5)),
    why: 'Publishes the freshness metric an alarm watches; the alarm evaluates on five minutes.',
  },
  {
    job: 'emit-queue-depth-metrics',
    id: 'EmitQueueDepthMetrics',
    schedule: Schedule.rate(Duration.minutes(5)),
    why: 'Publishes queue depth on the same period as the alarm over it.',
  },
  {
    job: 'sweep-expired-history',
    id: 'SweepExpiredHistory',
    schedule: Schedule.cron({ minute: '0', hour: '4' }),
    why: 'Backstop behind DynamoDB TTL, which is best-effort and can lag by days. The 30-day retention promise is not best-effort.',
  },
];

export interface MaintenanceStackProps extends DataConsumerStackProps {
  /** Queues whose depth is published as a metric. */
  readonly monitoredQueues: readonly IQueue[];
  /** Queue the deletion worker consumes; due jobs are dispatched onto it. */
  readonly deletionQueue: IQueue;
  /** SNS platform applications whose endpoints are reconciled, when configured. */
  readonly platformApplicationArns?: readonly string[];
}

export class MaintenanceStack extends Stack {
  public readonly maintenanceFunction: IFunction;

  constructor(scope: Construct, id: string, props: MaintenanceStackProps) {
    super(scope, id, {
      ...props,
      env: props.env ?? cdkEnvironment(props.config),
      terminationProtection: props.terminationProtection ?? props.config.isProduction,
      description: props.description ?? 'Kinmap scheduled maintenance jobs.',
    });

    const { config, tables } = props;

    applyStandardTags(this, config);

    const platformApplicationArns = props.platformApplicationArns ?? [];

    const maintenance = new NodeService(this, 'ScheduledMaintenanceService', {
      config,
      serviceName: 'scheduled-maintenance',
      description: 'Expiry, staleness, retention sweeps and erasure dispatch.',
      memorySize: 1024,
      timeout: MAINTENANCE_TIMEOUT,
      environment: {
        LIVE_SESSIONS_TABLE: tables.liveSessions.tableName,
        INVITATIONS_TABLE: tables.invitations.tableName,
        CURRENT_LOCATIONS_TABLE: tables.currentLocations.tableName,
        LOCATION_HISTORY_TABLE: tables.locationHistory.tableName,
        DEVICES_TABLE: tables.devices.tableName,
        DELETION_JOBS_TABLE: tables.deletionJobs.tableName,
        DELETION_QUEUE_URL: props.deletionQueue.queueUrl,
        MONITORED_QUEUE_URLS: props.monitoredQueues.map((queue) => queue.queueUrl).join(','),
        PLATFORM_APPLICATION_ARNS: platformApplicationArns.join(','),
        HISTORY_RETENTION_DAYS: String(config.historyRetentionDays),
        MAX_ITEMS_PER_JOB: String(config.isProduction ? 5000 : 1000),
        MAX_WRITES_PER_SECOND: String(25),
      },
    });
    this.maintenanceFunction = maintenance.function;

    tables.liveSessions.grantReadWriteData(this.maintenanceFunction);
    tables.invitations.grantReadWriteData(this.maintenanceFunction);
    tables.devices.grantReadWriteData(this.maintenanceFunction);
    // Marks a fix stale and sweeps expired rows. It never decrypts one — a
    // staleness verdict is a comparison of timestamps, and the coordinate key
    // is deliberately not granted here.
    tables.currentLocations.grantReadWriteData(this.maintenanceFunction);
    tables.locationHistory.grantReadWriteData(this.maintenanceFunction);
    // Reads due jobs and dispatches them; the worker owns their status.
    tables.deletionJobs.grantReadData(this.maintenanceFunction);
    props.deletionQueue.grantSendMessages(this.maintenanceFunction);

    for (const queue of props.monitoredQueues) {
      queue.grant(this.maintenanceFunction, 'sqs:GetQueueAttributes');
    }

    if (platformApplicationArns.length > 0) {
      const endpointArns: string[] = [];
      for (const arn of platformApplicationArns) {
        endpointArns.push(arn, `${arn}/*`);
      }
      this.maintenanceFunction.addToRolePolicy(
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: [
            'sns:ListEndpointsByPlatformApplication',
            'sns:GetEndpointAttributes',
            'sns:DeleteEndpoint',
          ],
          resources: endpointArns,
        }),
      );
    }

    for (const entry of SCHEDULED_JOBS) {
      new Rule(this, `${entry.id}Rule`, {
        ruleName: `${config.resourcePrefix}-${entry.job}`,
        description: entry.why,
        schedule: entry.schedule,
        targets: [
          new LambdaFunction(this.maintenanceFunction, {
            event: RuleTargetInput.fromObject({ job: entry.job }),
          }),
        ],
      });
    }

    // Endpoint reconciliation only exists once there is a platform application
    // to reconcile against; scheduling it before then would fail every run.
    if (platformApplicationArns.length > 0) {
      new Rule(this, 'ReconcilePushEndpointsRule', {
        ruleName: `${config.resourcePrefix}-reconcile-push-endpoints`,
        description: 'Retires push endpoints whose device row is gone.',
        schedule: Schedule.cron({ minute: '30', hour: '4' }),
        targets: [
          new LambdaFunction(this.maintenanceFunction, {
            event: RuleTargetInput.fromObject({ job: 'reconcile-push-endpoints' }),
          }),
        ],
      });
    }

    new CfnOutput(this, 'MaintenanceFunctionNameOutput', {
      value: this.maintenanceFunction.functionName,
      description: 'Run one job by hand with {"job":"<name>","dryRun":true}',
    });
  }
}
