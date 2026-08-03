/**
 * Privacy stack — the two workers that make the product's promises real.
 *
 * `deletion-worker` carries out a right-to-erasure request. `audit-worker`
 * appends the record of who looked at whose location. Both existed in
 * `services/` and were deployed by nothing, which meant the API accepted
 * deletion requests, told the user a date by which they would be complete, and
 * then never acted on them.
 *
 * The deletion worker is the most dangerous function in the platform: it holds
 * delete permission on every table that stores anything about a person, plus
 * `cognito-idp:AdminDeleteUser`. Its grants are therefore enumerated action by
 * action rather than through `grantReadWriteData`, so that what it can destroy
 * is legible in one place, and it is given no `kms:Decrypt` on the coordinate
 * key — erasing a sealed row never requires reading it.
 *
 * Stack dependency direction: NotificationStack and IdentityStack are
 * synthesised first. Nothing here depends on the API.
 */
import { CfnOutput, Duration, Stack } from 'aws-cdk-lib';
import { Effect, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { type IFunction } from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { type IQueue } from 'aws-cdk-lib/aws-sqs';
import { type Construct } from 'constructs';

import { applyStandardTags, cdkEnvironment } from '../config/index.js';
import { type DataConsumerStackProps } from '../config/types.js';
import { NodeService } from '../constructs/node-service.js';
import { QueueWithDlq } from '../constructs/queue-with-dlq.js';

/** Erasure walks every table for one person; it is allowed to take its time. */
const DELETION_WORKER_TIMEOUT = Duration.minutes(5);
const AUDIT_WORKER_TIMEOUT = Duration.seconds(30);

/** AWS guidance: visibility timeout of six times the consumer's timeout. */
const VISIBILITY_TIMEOUT_FACTOR = 6;

export interface PrivacyStackProps extends DataConsumerStackProps {
  /** Pool the worker deletes the identity from. */
  readonly userPoolId: string;
  readonly userPoolArn: string;
  /**
   * Secret whose value peppers the deletion tombstone hash, so a tombstone
   * cannot be reversed into the account it stands for. Passed by ARN and read
   * at runtime; the value never enters a template or an environment variable.
   */
  readonly tombstonePepperSecretArn?: string;
}

export class PrivacyStack extends Stack {
  public readonly deletionWorkerFunction: IFunction;
  public readonly auditWorkerFunction: IFunction;

  /** Job ids awaiting erasure. Carries no identity — only a job id. */
  public readonly deletionQueue: IQueue;
  /** Audit rows awaiting append. */
  public readonly auditCommandsQueue: IQueue;

  constructor(scope: Construct, id: string, props: PrivacyStackProps) {
    super(scope, id, {
      ...props,
      env: props.env ?? cdkEnvironment(props.config),
      terminationProtection: props.terminationProtection ?? props.config.isProduction,
      description: props.description ?? 'Kinmap account erasure and the audit trail.',
    });

    const { config, tables } = props;

    applyStandardTags(this, config);

    // -----------------------------------------------------------------------
    // services/deletion-worker
    // -----------------------------------------------------------------------

    const deletionQueue = new QueueWithDlq(this, 'DeletionJobsQueue', {
      config,
      queueName: `${config.resourcePrefix}-deletion-jobs`,
      visibilityTimeout: Duration.seconds(
        DELETION_WORKER_TIMEOUT.toSeconds() * VISIBILITY_TIMEOUT_FACTOR,
      ),
    });
    this.deletionQueue = deletionQueue.queue;

    const deletionWorker = new NodeService(this, 'DeletionWorkerService', {
      config,
      serviceName: 'deletion-worker',
      description: 'Carries out account erasure across every table that holds a person.',
      memorySize: 1024,
      timeout: DELETION_WORKER_TIMEOUT,
      environment: {
        DELETION_JOBS_TABLE: tables.deletionJobs.tableName,
        USERS_TABLE: tables.users.tableName,
        DEVICES_TABLE: tables.devices.tableName,
        FAMILIES_TABLE: tables.families.tableName,
        FAMILY_MEMBERSHIPS_TABLE: tables.familyMemberships.tableName,
        CURRENT_LOCATIONS_TABLE: tables.currentLocations.tableName,
        LOCATION_HISTORY_TABLE: tables.locationHistory.tableName,
        SAVED_PLACES_TABLE: tables.savedPlaces.tableName,
        NOTIFICATION_PREFERENCES_TABLE: tables.notificationPreferences.tableName,
        LIVE_SESSIONS_TABLE: tables.liveSessions.tableName,
        GEOFENCE_STATE_TABLE: tables.geofenceState.tableName,
        // Its own queue: a job too large for one invocation re-enqueues itself
        // rather than running to the Lambda timeout and being retried whole.
        DELETION_QUEUE_URL: this.deletionQueue.queueUrl,
        COGNITO_USER_POOL_ID: props.userPoolId,
        // Placeholder only where no secret is configured. The pepper is what
        // stops a tombstone being reversed into the account it stands for, so a
        // real environment must supply one.
        DELETION_TOMBSTONE_PEPPER: props.tombstonePepperSecretArn ?? `${config.envName}-unset`,
        HISTORY_DELETION_LOOKBACK_DAYS: String(config.historyRetentionDays + 7),
      },
    });
    this.deletionWorkerFunction = deletionWorker.function;

    // Enumerated rather than granted wholesale. This function can erase a
    // person from every table below; nothing here should be inferable only from
    // the absence of a comment.
    tables.deletionJobs.grant(
      this.deletionWorkerFunction,
      'dynamodb:GetItem',
      'dynamodb:PutItem',
      'dynamodb:UpdateItem',
    );
    tables.users.grant(this.deletionWorkerFunction, 'dynamodb:GetItem', 'dynamodb:DeleteItem');
    tables.devices.grant(this.deletionWorkerFunction, 'dynamodb:Query', 'dynamodb:DeleteItem');
    tables.families.grant(
      this.deletionWorkerFunction,
      'dynamodb:GetItem',
      'dynamodb:UpdateItem',
      'dynamodb:DeleteItem',
    );
    tables.familyMemberships.grant(
      this.deletionWorkerFunction,
      'dynamodb:Query',
      'dynamodb:UpdateItem',
      'dynamodb:DeleteItem',
    );
    for (const table of [
      tables.currentLocations,
      tables.locationHistory,
      tables.savedPlaces,
      tables.notificationPreferences,
      tables.liveSessions,
      tables.geofenceState,
    ]) {
      table.grant(this.deletionWorkerFunction, 'dynamodb:Query', 'dynamodb:BatchWriteItem');
    }
    this.deletionQueue.grantSendMessages(this.deletionWorkerFunction);

    // Deleting the identity itself. Scoped to this one pool and this one
    // action: the worker can remove a user, and can do nothing else to Cognito.
    this.deletionWorkerFunction.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['cognito-idp:AdminDeleteUser'],
        resources: [props.userPoolArn],
      }),
    );

    // Push endpoints outlive the device row, so an un-deleted endpoint would
    // keep a deleted person addressable.
    this.deletionWorkerFunction.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['sns:DeleteEndpoint', 'sns:GetEndpointAttributes'],
        resources: ['*'],
      }),
    );

    if (props.tombstonePepperSecretArn !== undefined) {
      this.deletionWorkerFunction.addToRolePolicy(
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ['secretsmanager:GetSecretValue'],
          resources: [props.tombstonePepperSecretArn],
        }),
      );
    }

    this.deletionWorkerFunction.addEventSource(
      new SqsEventSource(this.deletionQueue, {
        // One job per invocation: an erasure is long, and a batch failure must
        // not re-run an erasure that already completed.
        batchSize: 1,
        reportBatchItemFailures: true,
      }),
    );

    // -----------------------------------------------------------------------
    // services/audit-worker
    // -----------------------------------------------------------------------

    const auditQueue = new QueueWithDlq(this, 'AuditCommandsQueue', {
      config,
      queueName: `${config.resourcePrefix}-audit-commands`,
      visibilityTimeout: Duration.seconds(
        AUDIT_WORKER_TIMEOUT.toSeconds() * VISIBILITY_TIMEOUT_FACTOR,
      ),
    });
    this.auditCommandsQueue = auditQueue.queue;

    const auditWorker = new NodeService(this, 'AuditWorkerService', {
      config,
      serviceName: 'audit-worker',
      description: 'Appends the record of who read whose location.',
      memorySize: 512,
      timeout: AUDIT_WORKER_TIMEOUT,
      environment: {
        AUDIT_EVENTS_TABLE: tables.auditEvents.tableName,
        USERS_TABLE: tables.users.tableName,
      },
    });
    this.auditWorkerFunction = auditWorker.function;

    // Append and read back, never update or delete: the audit trail is the one
    // record that must survive a compromise of the thing that writes it.
    tables.auditEvents.grant(
      this.auditWorkerFunction,
      'dynamodb:PutItem',
      'dynamodb:Query',
      'dynamodb:GetItem',
    );
    tables.users.grantReadData(this.auditWorkerFunction);

    this.auditWorkerFunction.addEventSource(
      new SqsEventSource(this.auditCommandsQueue, {
        batchSize: 10,
        reportBatchItemFailures: true,
      }),
    );

    new CfnOutput(this, 'DeletionQueueUrlOutput', {
      value: this.deletionQueue.queueUrl,
      description: 'Queue the deletion worker consumes',
    });
    new CfnOutput(this, 'AuditCommandsQueueUrlOutput', {
      value: this.auditCommandsQueue.queueUrl,
      description: 'Queue the audit worker consumes',
    });
  }
}
