/**
 * Location stack — the coordinate-handling half of the platform.
 *
 * Everything here is built around one rule: a precise coordinate is only ever
 * in plaintext inside a Lambda invocation. It reaches this stack encrypted
 * under the foundation's coordinate key, travels through EventBridge and SQS as
 * ciphertext, and is decrypted only by the two functions that hold
 * `kms:Decrypt` (location-query and geofence-worker). Nothing in this file
 * creates a sink — no log destination, no event archive, no metric dimension —
 * that could come to hold a fix.
 *
 * Wiring contract:
 *   - table names reach services as `<TABLE>_TABLE`
 *   - queue urls as `<QUEUE>_QUEUE_URL`
 *   - the coordinate key as `COORDINATE_KEY_ID`
 *   - each service is `services/<name>/src/handler.ts`, named export `handler`
 *
 * Stack dependency direction: NotificationStack is synthesised first and its
 * command queue is passed in here, so a geofence transition can be handed off
 * without a cyclic stack reference.
 */
import { CfnOutput, Duration, Stack } from 'aws-cdk-lib';
import { EventBus, EventField, Rule, RuleTargetInput } from 'aws-cdk-lib/aws-events';
import { SqsQueue } from 'aws-cdk-lib/aws-events-targets';
import { Effect, Grant, PolicyStatement, type IGrantable } from 'aws-cdk-lib/aws-iam';
import { type IFunction } from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { CfnGeofenceCollection } from 'aws-cdk-lib/aws-location';
import { Queue, type IQueue } from 'aws-cdk-lib/aws-sqs';
import { type Construct } from 'constructs';

import { applyStandardTags, cdkEnvironment } from '../config/index.js';
import { type DataConsumerStackProps } from '../config/types.js';
import { NodeService } from '../constructs/node-service.js';
import { QueueWithDlq } from '../constructs/queue-with-dlq.js';

/**
 * EventBridge vocabulary. These constants are handed to the ingestion Lambda as
 * environment variables so the producer and the rules cannot drift apart.
 */
const LOCATION_EVENT_SOURCE = 'kinmap.location';
const ACCEPTED_LOCATION_DETAIL_TYPE = 'location.accepted';

/** Live tracking mode, mirrored from `TrackingStateSchema` in @family/contracts. */
const LIVE_TRACKING_MODE = 'LIVE';

/** Function timeouts. Queue visibility is derived from these, never guessed. */
const INGESTION_TIMEOUT = Duration.seconds(20);
const QUERY_TIMEOUT = Duration.seconds(15);
const GEOFENCE_WORKER_TIMEOUT = Duration.seconds(30);

/** AWS guidance: visibility timeout of six times the consumer's timeout. */
const VISIBILITY_TIMEOUT_FACTOR = 6;

export interface LocationStackProps extends DataConsumerStackProps {
  /**
   * Command queue owned by NotificationStack. Arrival, departure and
   * live-refresh commands are enqueued here; they carry ids and a saved-place
   * name, never a coordinate.
   */
  readonly notificationCommandsQueue: IQueue;
}

export class LocationStack extends Stack {
  /** Bus carrying accepted-location events. Every detail payload is ciphertext. */
  public readonly locationEventBus: EventBus;

  public readonly ingestionFunction: IFunction;
  public readonly queryFunction: IFunction;
  public readonly geofenceWorkerFunction: IFunction;

  public readonly geofenceEvaluationQueue: IQueue;

  public readonly geofenceCollectionName: string;
  public readonly geofenceCollectionArn: string;

  constructor(scope: Construct, id: string, props: LocationStackProps) {
    super(scope, id, {
      ...props,
      env: props.env ?? cdkEnvironment(props.config),
      terminationProtection: props.terminationProtection ?? props.config.isProduction,
      description:
        props.description ?? 'Kinmap location ingestion, authorised reads and geofencing.',
    });

    const { config, foundation, tables } = props;

    applyStandardTags(this, config);

    // -----------------------------------------------------------------------
    // Event bus
    // -----------------------------------------------------------------------

    this.locationEventBus = new EventBus(this, 'LocationEventBus', {
      eventBusName: `${config.resourcePrefix}-location`,
    });
    this.locationEventBus.applyRemovalPolicy(config.removalPolicy);

    // -----------------------------------------------------------------------
    // Geofence evaluation queue
    // -----------------------------------------------------------------------

    const geofenceEvaluation = new QueueWithDlq(this, 'GeofenceEvaluationQueue', {
      config,
      queueName: `${config.resourcePrefix}-geofence-evaluation`,
      visibilityTimeout: Duration.seconds(
        GEOFENCE_WORKER_TIMEOUT.toSeconds() * VISIBILITY_TIMEOUT_FACTOR,
      ),
      maxReceiveCount: 5,
    });
    this.geofenceEvaluationQueue = geofenceEvaluation.queue;

    // -----------------------------------------------------------------------
    // Amazon Location Service geofence collection
    //
    // Geometry is written by the saved-places service (another stack) through
    // `grantManageGeofences`; this stack only lets the worker read and evaluate.
    // The collection is encrypted with the same customer-managed key as the
    // coordinates in DynamoDB, because a saved place is a home address.
    // -----------------------------------------------------------------------

    this.geofenceCollectionName = `${config.resourcePrefix}-family-places`;

    const geofenceCollection = new CfnGeofenceCollection(this, 'FamilyPlacesGeofenceCollection', {
      collectionName: this.geofenceCollectionName,
      description: 'Saved-place geofences for Kinmap families.',
      kmsKeyId: foundation.coordinateKey.keyArn,
    });
    geofenceCollection.applyRemovalPolicy(config.removalPolicy);

    this.geofenceCollectionArn = this.formatArn({
      service: 'geo',
      resource: 'geofence-collection',
      resourceName: this.geofenceCollectionName,
    });

    // -----------------------------------------------------------------------
    // services/location-ingestion — accepts batch uploads from devices
    // -----------------------------------------------------------------------

    const ingestion = new NodeService(this, 'LocationIngestionService', {
      config,
      serviceName: 'location-ingestion',
      description: 'Validates, encrypts and stores device location batches.',
      memorySize: 1024,
      timeout: INGESTION_TIMEOUT,
      environment: {
        CURRENT_LOCATIONS_TABLE: tables.currentLocations.tableName,
        LOCATION_HISTORY_TABLE: tables.locationHistory.tableName,
        FAMILY_MEMBERSHIPS_TABLE: tables.familyMemberships.tableName,
        IDEMPOTENCY_TABLE: tables.idempotency.tableName,
        COORDINATE_KEY_ID: foundation.coordinateKey.keyId,
        LOCATION_EVENT_BUS_NAME: this.locationEventBus.eventBusName,
        LOCATION_EVENT_SOURCE,
        HISTORY_RETENTION_DAYS: String(config.historyRetentionDays),
        USERS_TABLE: tables.users.tableName,
      },
    });
    this.ingestionFunction = ingestion.function;

    // Ingestion compares each point against the previous accepted fix (the
    // duplicate and speed-plausibility checks in `ACCEPTANCE`), so it reads and
    // writes CurrentLocations. History is strictly append-only from here.
    tables.currentLocations.grantReadWriteData(this.ingestionFunction);
    tables.locationHistory.grantWriteData(this.ingestionFunction);
    tables.familyMemberships.grantReadData(this.ingestionFunction);
    tables.idempotency.grantReadWriteData(this.ingestionFunction);
    tables.users.grantReadData(this.ingestionFunction);
    foundation.coordinateKey.grantEncrypt(this.ingestionFunction);
    this.locationEventBus.grantPutEventsTo(this.ingestionFunction);

    // -----------------------------------------------------------------------
    // services/location-query — the only authorised reader of stored fixes
    //
    // The grants are deliberately asymmetric: read on the four tables it needs
    // to answer and to authorise a request, write on the audit log it must
    // append to. It can neither mutate a stored location nor read the audit
    // trail back out, so a compromised query function cannot cover its tracks.
    // -----------------------------------------------------------------------

    const query = new NodeService(this, 'LocationQueryService', {
      config,
      serviceName: 'location-query',
      description: 'Serves authorised current-location and history reads.',
      memorySize: 1024,
      timeout: QUERY_TIMEOUT,
      environment: {
        CURRENT_LOCATIONS_TABLE: tables.currentLocations.tableName,
        LOCATION_HISTORY_TABLE: tables.locationHistory.tableName,
        FAMILY_MEMBERSHIPS_TABLE: tables.familyMemberships.tableName,
        SAVED_PLACES_TABLE: tables.savedPlaces.tableName,
        AUDIT_EVENTS_TABLE: tables.auditEvents.tableName,
        COORDINATE_KEY_ID: foundation.coordinateKey.keyId,
        USERS_TABLE: tables.users.tableName,
        DEVICES_TABLE: tables.devices.tableName,
        SUBSCRIPTIONS_TABLE: tables.subscriptions.tableName,
      },
    });
    this.queryFunction = query.function;

    tables.currentLocations.grantReadData(this.queryFunction);
    tables.locationHistory.grantReadData(this.queryFunction);
    tables.familyMemberships.grantReadData(this.queryFunction);
    tables.savedPlaces.grantReadData(this.queryFunction);
    tables.auditEvents.grantWriteData(this.queryFunction);
    // Entitlements gate how far back history may be read, so the query path has
    // to resolve the caller's plan and device before it answers.
    tables.users.grantReadData(this.queryFunction);
    tables.devices.grantReadData(this.queryFunction);
    tables.subscriptions.grantReadData(this.queryFunction);
    foundation.coordinateKey.grantDecrypt(this.queryFunction);

    // -----------------------------------------------------------------------
    // services/geofence-worker — arrival and departure detection
    //
    // Decrypts the fix in memory, compares it against the family's saved places
    // and the previous verdict, and emits a notification command carrying a
    // place name and ids only.
    // -----------------------------------------------------------------------

    const geofenceWorker = new NodeService(this, 'GeofenceWorkerService', {
      config,
      serviceName: 'geofence-worker',
      description: 'Evaluates accepted locations against family saved places.',
      memorySize: 1024,
      timeout: GEOFENCE_WORKER_TIMEOUT,
      environment: {
        SAVED_PLACES_TABLE: tables.savedPlaces.tableName,
        FAMILY_MEMBERSHIPS_TABLE: tables.familyMemberships.tableName,
        GEOFENCE_STATE_TABLE: tables.geofenceState.tableName,
        COORDINATE_KEY_ID: foundation.coordinateKey.keyId,
        GEOFENCE_COLLECTION_NAME: this.geofenceCollectionName,
        NOTIFICATION_COMMANDS_QUEUE_URL: props.notificationCommandsQueue.queueUrl,
      },
    });
    this.geofenceWorkerFunction = geofenceWorker.function;

    tables.savedPlaces.grantReadData(this.geofenceWorkerFunction);
    tables.familyMemberships.grantReadData(this.geofenceWorkerFunction);
    // Transition detection is stateful: the previous inside/outside verdict has
    // to survive a worker restart or every cold start re-announces an arrival.
    tables.geofenceState.grantReadWriteData(this.geofenceWorkerFunction);
    foundation.coordinateKey.grantDecrypt(this.geofenceWorkerFunction);
    props.notificationCommandsQueue.grantSendMessages(this.geofenceWorkerFunction);

    this.geofenceWorkerFunction.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['geo:BatchEvaluateGeofences', 'geo:GetGeofence', 'geo:ListGeofences'],
        resources: [this.geofenceCollectionArn],
      }),
    );

    // Partial batch responses: one poisoned record must not replay the other
    // nine, because a replayed arrival is a duplicate push to a whole family.
    this.geofenceWorkerFunction.addEventSource(
      new SqsEventSource(this.geofenceEvaluationQueue, {
        batchSize: 10,
        maxBatchingWindow: Duration.seconds(5),
        reportBatchItemFailures: true,
      }),
    );

    // -----------------------------------------------------------------------
    // Rules routing accepted-location events
    // -----------------------------------------------------------------------

    new Rule(this, 'AcceptedLocationToGeofenceRule', {
      eventBus: this.locationEventBus,
      ruleName: `${config.resourcePrefix}-accepted-location-geofence`,
      description: 'Every accepted location is evaluated for saved-place transitions.',
      eventPattern: {
        source: [LOCATION_EVENT_SOURCE],
        detailType: [ACCEPTED_LOCATION_DETAIL_TYPE],
      },
      targets: [new SqsQueue(this.geofenceEvaluationQueue)],
    });

    // Live sessions are short and watched in real time, so an accepted fix
    // captured in LIVE mode also nudges the watcher's app to refetch.
    //
    // The target input is transformed rather than forwarded. The event detail
    // holds the coordinate ciphertext and the notification path has no decrypt
    // grant, but putting an encrypted fix on a queue that feeds APNs and FCM is
    // the kind of adjacency that later becomes a leak — so only these named
    // fields ever leave the bus. The watcher's app performs an ordinary
    // authorised read to obtain the position itself.
    const importedNotificationQueue = Queue.fromQueueArn(
      this,
      'ImportedNotificationCommandsQueue',
      props.notificationCommandsQueue.queueArn,
    );

    new Rule(this, 'AcceptedLocationLiveRefreshRule', {
      eventBus: this.locationEventBus,
      ruleName: `${config.resourcePrefix}-accepted-location-live-refresh`,
      description: 'Accepted locations captured during a live session trigger a silent refresh.',
      eventPattern: {
        source: [LOCATION_EVENT_SOURCE],
        detailType: [ACCEPTED_LOCATION_DETAIL_TYPE],
        detail: { trackingMode: [LIVE_TRACKING_MODE] },
      },
      targets: [
        // Imported by ARN on purpose. Handing CDK the real cross-stack queue
        // construct makes it write the SendMessage policy into the
        // NotificationStack, referencing this rule's ARN — and since this stack
        // already depends on NotificationStack for the queue, that reverse
        // reference is a dependency cycle CloudFormation cannot deploy. The
        // import keeps the target while leaving the policy to NotificationStack,
        // which grants EventBridge access by source-ARN pattern instead.
        new SqsQueue(importedNotificationQueue, {
          message: RuleTargetInput.fromObject({
            kind: 'LIVE_SESSION_REFRESH',
            subjectUserId: EventField.fromPath('$.detail.subjectUserId'),
            deviceId: EventField.fromPath('$.detail.deviceId'),
            capturedAt: EventField.fromPath('$.detail.capturedAt'),
          }),
        }),
      ],
    });

    // -----------------------------------------------------------------------
    // Outputs. Operator convenience only — no export names, because sibling
    // stacks receive these constructs directly from bin/app.ts rather than
    // through CloudFormation exports.
    // -----------------------------------------------------------------------

    new CfnOutput(this, 'LocationEventBusName', {
      value: this.locationEventBus.eventBusName,
      description: 'EventBridge bus carrying accepted-location events.',
    });

    new CfnOutput(this, 'GeofenceEvaluationQueueUrl', {
      value: this.geofenceEvaluationQueue.queueUrl,
      description: 'Queue consumed by services/geofence-worker.',
    });

    new CfnOutput(this, 'GeofenceCollectionNameOutput', {
      value: this.geofenceCollectionName,
      description: 'Amazon Location Service geofence collection holding saved places.',
    });
  }

  /**
   * Lets the saved-places service (owned by another stack) manage geofence
   * geometry without being handed the whole collection. Kept here so the ARN is
   * never re-derived by hand at the call site.
   */
  public grantManageGeofences(grantee: IGrantable): Grant {
    return Grant.addToPrincipal({
      grantee,
      actions: [
        'geo:BatchPutGeofence',
        'geo:BatchDeleteGeofence',
        'geo:GetGeofence',
        'geo:ListGeofences',
      ],
      resourceArns: [this.geofenceCollectionArn],
      scope: this,
    });
  }
}
