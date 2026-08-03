/**
 * Notification stack — the push delivery path.
 *
 * Two constraints shape everything here.
 *
 * 1. A push payload leaves our infrastructure and is handled by Apple and
 *    Google, so it may never contain a coordinate (see `PushPayloadSchema` in
 *    @family/schemas). Nothing in this stack creates a channel that could carry
 *    one: the worker receives ids and a saved-place name the recipient already
 *    knows, and the app fetches any detail over an authorised API call after
 *    the tap.
 *
 * 2. The stack must deploy before store credentials exist. An APNs signing key
 *    and an FCM service account are manual, human-gated artefacts; blocking the
 *    first environment on them would mean the backend cannot be stood up at
 *    all. So each SNS platform application is created only when its Secrets
 *    Manager ARN is configured, and until then the worker simply has no ARN for
 *    that platform and fails closed on it.
 *
 * SNS platform applications are not a CloudFormation resource type, so they are
 * managed by a small custom resource. The credential itself is never placed in
 * the template or in the custom resource's properties — only the secret ARN is,
 * and the handler reads the value with the SDK at execution time. Resolving the
 * secret into the template instead (`SecretValue#unsafeUnwrap`, or a dynamic
 * reference inside `AwsCustomResource` parameters) would put an APNs signing
 * key into CloudFormation stack events and into the provider's log group.
 */
import { ArnFormat, CfnOutput, CustomResource, Duration, Stack } from 'aws-cdk-lib';
import {
  Effect,
  PolicyDocument,
  PolicyStatement,
  Role,
  ServicePrincipal,
  type IRole,
} from 'aws-cdk-lib/aws-iam';
import {
  Architecture,
  Code,
  Function as LambdaFunction,
  Runtime,
  type IFunction,
} from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { type IQueue } from 'aws-cdk-lib/aws-sqs';
import { Provider } from 'aws-cdk-lib/custom-resources';
import { type Construct } from 'constructs';

import { applyStandardTags, cdkEnvironment } from '../config/index.js';
import { type DataConsumerStackProps } from '../config/types.js';
import { NodeService } from '../constructs/node-service.js';
import { QueueWithDlq } from '../constructs/queue-with-dlq.js';

const WORKER_TIMEOUT = Duration.seconds(30);
const VISIBILITY_TIMEOUT_FACTOR = 6;

/**
 * Secrets Manager ARNs for the store push credentials. Every field is optional
 * so an environment can be deployed before the corresponding developer account
 * exists.
 *
 * Each secret holds a JSON object whose keys are SNS platform-application
 * attribute names. Only this allow-list is forwarded to SNS:
 *
 *   PlatformPrincipal        APNs: signing key id.  FCM: unused.
 *   PlatformCredential       APNs: .p8 signing key. FCM: service-account JSON.
 *   ApplePlatformTeamID      APNs token authentication only.
 *   ApplePlatformBundleID    APNs token authentication only.
 *   AuthenticationMethod     'TOKEN' for APNs token auth and FCM HTTP v1.
 */
export interface PushCredentialSecrets {
  /** APNs production credential secret ARN. */
  readonly apnsSecretArn?: string;
  /** APNs sandbox secret ARN. A separate credential means a separate app. */
  readonly apnsSandboxSecretArn?: string;
  /** Firebase Cloud Messaging credential secret ARN. */
  readonly fcmSecretArn?: string;
}

export interface NotificationStackProps extends DataConsumerStackProps {
  /**
   * Passed as a prop rather than read from `EnvironmentConfig` so that adding a
   * fourth platform later does not change the shape of the configuration every
   * other stack also receives. bin/app.ts sources it per environment.
   */
  readonly pushCredentials?: PushCredentialSecrets;
}

interface PlatformApplicationSpec {
  readonly constructId: string;
  /** SNS platform identifier. */
  readonly platform: 'APNS' | 'APNS_SANDBOX' | 'GCM';
  readonly nameSuffix: string;
  readonly secretArn: string;
  readonly environmentVariable: string;
  readonly outputId: string;
}

/**
 * `Code.fromInline` is capped at 4 KiB, which this comfortably fits. It is
 * plain CommonJS because inline code is loaded as `index.js`, and the AWS SDK
 * v3 clients it requires are provided by the managed Node.js runtime.
 *
 * The handler never logs the secret, never returns it in `Data`, and reports
 * only structural failures ('missing PlatformCredential'), so no stack event
 * and no log line can carry a signing key.
 */
const PLATFORM_APPLICATION_HANDLER = `'use strict';
const {
  SNSClient,
  CreatePlatformApplicationCommand,
  SetPlatformApplicationAttributesCommand,
  DeletePlatformApplicationCommand,
} = require('@aws-sdk/client-sns');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

const sns = new SNSClient({});
const secrets = new SecretsManagerClient({});

const CREDENTIAL_KEYS = [
  'PlatformPrincipal',
  'PlatformCredential',
  'ApplePlatformTeamID',
  'ApplePlatformBundleID',
  'AuthenticationMethod',
];

async function buildAttributes(props) {
  const attributes = {};
  const configured = props.Attributes || {};
  for (const key of Object.keys(configured)) {
    const value = configured[key];
    if (typeof value === 'string' && value.length > 0) attributes[key] = value;
  }
  const result = await secrets.send(new GetSecretValueCommand({ SecretId: props.SecretArn }));
  if (!result.SecretString) throw new Error('Push credential secret has no string value.');
  let parsed;
  try {
    parsed = JSON.parse(result.SecretString);
  } catch (_error) {
    throw new Error('Push credential secret is not a JSON object.');
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Push credential secret is not a JSON object.');
  }
  for (const key of CREDENTIAL_KEYS) {
    const value = parsed[key];
    if (typeof value === 'string' && value.length > 0) attributes[key] = value;
  }
  if (!attributes.PlatformCredential) {
    throw new Error('Push credential secret is missing PlatformCredential.');
  }
  return attributes;
}

function isArn(value) {
  return typeof value === 'string' && value.indexOf('arn:') === 0;
}

exports.handler = async (event) => {
  const props = event.ResourceProperties || {};
  const previous = event.OldResourceProperties || {};
  if (event.RequestType === 'Delete') {
    if (isArn(event.PhysicalResourceId)) {
      await sns.send(
        new DeletePlatformApplicationCommand({ PlatformApplicationArn: event.PhysicalResourceId }),
      );
    }
    return { PhysicalResourceId: event.PhysicalResourceId };
  }
  const attributes = await buildAttributes(props);
  const reusable =
    event.RequestType === 'Update' &&
    isArn(event.PhysicalResourceId) &&
    previous.Name === props.Name &&
    previous.Platform === props.Platform;
  if (reusable) {
    await sns.send(
      new SetPlatformApplicationAttributesCommand({
        PlatformApplicationArn: event.PhysicalResourceId,
        Attributes: attributes,
      }),
    );
    return {
      PhysicalResourceId: event.PhysicalResourceId,
      Data: { PlatformApplicationArn: event.PhysicalResourceId },
    };
  }
  const created = await sns.send(
    new CreatePlatformApplicationCommand({
      Name: props.Name,
      Platform: props.Platform,
      Attributes: attributes,
    }),
  );
  if (!created.PlatformApplicationArn) {
    throw new Error('SNS did not return a platform application ARN.');
  }
  return {
    PhysicalResourceId: created.PlatformApplicationArn,
    Data: { PlatformApplicationArn: created.PlatformApplicationArn },
  };
};
`;

export class NotificationStack extends Stack {
  /** Commands consumed by services/notification-worker. Never carries a fix. */
  public readonly notificationCommandsQueue: IQueue;

  public readonly notificationWorkerFunction: IFunction;

  /** Undefined until the matching store credential secret has been configured. */
  public readonly apnsPlatformApplicationArn: string | undefined;
  public readonly apnsSandboxPlatformApplicationArn: string | undefined;
  public readonly fcmPlatformApplicationArn: string | undefined;

  constructor(scope: Construct, id: string, props: NotificationStackProps) {
    super(scope, id, {
      ...props,
      env: props.env ?? cdkEnvironment(props.config),
      terminationProtection: props.terminationProtection ?? props.config.isProduction,
      description: props.description ?? 'Kinmap push delivery and notification fan-out.',
    });

    const { config, tables } = props;
    const credentials: PushCredentialSecrets = props.pushCredentials ?? {};

    applyStandardTags(this, config);

    // -----------------------------------------------------------------------
    // Delivery-status logging roles
    //
    // SNS assumes these to write per-message delivery status into CloudWatch
    // Logs. Success is sampled in production — otherwise every geofence event
    // produces a log line per family member — while failures are always
    // recorded, because a silently failing push is indistinguishable from
    // "nobody moved", which is exactly the failure this product cannot have.
    // -----------------------------------------------------------------------

    const deliveryStatusPolicy = new PolicyDocument({
      statements: [
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: [
            'logs:CreateLogGroup',
            'logs:CreateLogStream',
            'logs:PutLogEvents',
            'logs:PutMetricFilter',
            'logs:PutRetentionPolicy',
          ],
          resources: [
            this.formatArn({
              service: 'logs',
              resource: 'log-group',
              resourceName: 'sns/*',
              arnFormat: ArnFormat.COLON_RESOURCE_NAME,
            }),
            this.formatArn({
              service: 'logs',
              resource: 'log-group',
              resourceName: 'sns/*:*',
              arnFormat: ArnFormat.COLON_RESOURCE_NAME,
            }),
          ],
        }),
      ],
    });

    const successFeedbackRole = new Role(this, 'PushDeliverySuccessRole', {
      assumedBy: new ServicePrincipal('sns.amazonaws.com'),
      description: 'Lets SNS log sampled successful push deliveries.',
      inlinePolicies: { DeliveryStatusLogging: deliveryStatusPolicy },
    });

    const failureFeedbackRole = new Role(this, 'PushDeliveryFailureRole', {
      assumedBy: new ServicePrincipal('sns.amazonaws.com'),
      description: 'Lets SNS log failed push deliveries and invalid endpoints.',
      inlinePolicies: { DeliveryStatusLogging: deliveryStatusPolicy },
    });

    // -----------------------------------------------------------------------
    // Platform applications, each gated on its own secret being configured
    // -----------------------------------------------------------------------

    const specs: PlatformApplicationSpec[] = [];

    if (credentials.apnsSecretArn !== undefined && credentials.apnsSecretArn !== '') {
      specs.push({
        constructId: 'ApnsPlatformApplication',
        platform: 'APNS',
        nameSuffix: 'apns',
        secretArn: credentials.apnsSecretArn,
        environmentVariable: 'APNS_PLATFORM_APPLICATION_ARN',
        outputId: 'ApnsPlatformApplicationArnOutput',
      });
    }

    if (credentials.apnsSandboxSecretArn !== undefined && credentials.apnsSandboxSecretArn !== '') {
      specs.push({
        constructId: 'ApnsSandboxPlatformApplication',
        platform: 'APNS_SANDBOX',
        nameSuffix: 'apns-sandbox',
        secretArn: credentials.apnsSandboxSecretArn,
        environmentVariable: 'APNS_SANDBOX_PLATFORM_APPLICATION_ARN',
        outputId: 'ApnsSandboxPlatformApplicationArnOutput',
      });
    }

    if (credentials.fcmSecretArn !== undefined && credentials.fcmSecretArn !== '') {
      specs.push({
        constructId: 'FcmPlatformApplication',
        platform: 'GCM',
        nameSuffix: 'fcm',
        secretArn: credentials.fcmSecretArn,
        environmentVariable: 'FCM_PLATFORM_APPLICATION_ARN',
        outputId: 'FcmPlatformApplicationArnOutput',
      });
    }

    const platformApplicationArns = new Map<string, string>();

    if (specs.length > 0) {
      const provider = this.createPlatformApplicationProvider(
        specs.map((spec) => spec.secretArn),
        [successFeedbackRole, failureFeedbackRole],
      );

      for (const spec of specs) {
        const resource = new CustomResource(this, spec.constructId, {
          serviceToken: provider.serviceToken,
          resourceType: 'Custom::SnsPlatformApplication',
          removalPolicy: config.removalPolicy,
          properties: {
            Name: `${config.resourcePrefix}-${spec.nameSuffix}`,
            Platform: spec.platform,
            SecretArn: spec.secretArn,
            // Non-secret attributes travel through the template. The credential
            // does not — the handler reads it from Secrets Manager itself.
            Attributes: {
              SuccessFeedbackRoleArn: successFeedbackRole.roleArn,
              FailureFeedbackRoleArn: failureFeedbackRole.roleArn,
              SuccessFeedbackSampleRate: config.isProduction ? '5' : '100',
            },
          },
        });

        const arn = resource.getAttString('PlatformApplicationArn');
        platformApplicationArns.set(spec.environmentVariable, arn);

        new CfnOutput(this, spec.outputId, {
          value: arn,
          description: `SNS platform application ARN for ${spec.platform}.`,
        });
      }
    }

    this.apnsPlatformApplicationArn = platformApplicationArns.get('APNS_PLATFORM_APPLICATION_ARN');
    this.apnsSandboxPlatformApplicationArn = platformApplicationArns.get(
      'APNS_SANDBOX_PLATFORM_APPLICATION_ARN',
    );
    this.fcmPlatformApplicationArn = platformApplicationArns.get('FCM_PLATFORM_APPLICATION_ARN');

    // -----------------------------------------------------------------------
    // Notification command queue
    // -----------------------------------------------------------------------

    const notificationCommands = new QueueWithDlq(this, 'NotificationCommandsQueue', {
      config,
      queueName: `${config.resourcePrefix}-notification-commands`,
      visibilityTimeout: Duration.seconds(WORKER_TIMEOUT.toSeconds() * VISIBILITY_TIMEOUT_FACTOR),
      maxReceiveCount: 5,
    });
    this.notificationCommandsQueue = notificationCommands.queue;

    // EventBridge rules in the location stack target this queue. That grant
    // cannot be created from there — CDK would write the policy back into this
    // stack referencing the rule's ARN, which is a dependency cycle — so it is
    // declared here instead, scoped by source-ARN pattern rather than by a
    // specific rule ARN. Without this the rules deliver nothing, silently.
    notificationCommands.queue.addToResourcePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        principals: [new ServicePrincipal('events.amazonaws.com')],
        actions: ['sqs:SendMessage'],
        resources: [notificationCommands.queue.queueArn],
        conditions: {
          ArnLike: {
            'aws:SourceArn': Stack.of(this).formatArn({
              service: 'events',
              resource: 'rule',
              resourceName: `${config.resourcePrefix}-*`,
            }),
          },
        },
      }),
    );

    // -----------------------------------------------------------------------
    // services/notification-worker
    // -----------------------------------------------------------------------

    const workerEnvironment: Record<string, string> = {
      DEVICES_TABLE: tables.devices.tableName,
      NOTIFICATION_PREFERENCES_TABLE: tables.notificationPreferences.tableName,
      FAMILY_MEMBERSHIPS_TABLE: tables.familyMemberships.tableName,
      LIVE_SESSIONS_TABLE: tables.liveSessions.tableName,
      USERS_TABLE: tables.users.tableName,
      SAVED_PLACES_TABLE: tables.savedPlaces.tableName,
      IDEMPOTENCY_TABLE: tables.idempotency.tableName,
    };
    for (const [variable, arn] of platformApplicationArns) {
      workerEnvironment[variable] = arn;
    }

    const worker = new NodeService(this, 'NotificationWorkerService', {
      config,
      serviceName: 'notification-worker',
      description: 'Renders and delivers coordinate-free push notifications.',
      memorySize: 1024,
      timeout: WORKER_TIMEOUT,
      environment: workerEnvironment,
    });
    this.notificationWorkerFunction = worker.function;

    // Membership and the live-session record are re-checked at delivery time:
    // a member removed one second ago must not receive the push that was
    // already in flight for them.
    tables.devices.grantReadData(this.notificationWorkerFunction);
    tables.notificationPreferences.grantReadData(this.notificationWorkerFunction);
    tables.familyMemberships.grantReadData(this.notificationWorkerFunction);
    tables.liveSessions.grantReadData(this.notificationWorkerFunction);
    // The rendered copy names the person and the place ("Ada arrived at
    // School"), so the worker resolves both. The place name is all it takes —
    // it never reads a coordinate.
    tables.users.grantReadData(this.notificationWorkerFunction);
    tables.savedPlaces.grantReadData(this.notificationWorkerFunction);
    // SQS redelivery is at-least-once, and a duplicate push is a duplicate
    // buzz in someone's pocket.
    tables.idempotency.grantReadWriteData(this.notificationWorkerFunction);

    // A token rejected by APNs or FCM has to be retired immediately, and that
    // is the only mutation the worker is allowed to make to a device record.
    this.notificationWorkerFunction.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['dynamodb:UpdateItem'],
        resources: [tables.devices.tableArn],
      }),
    );

    if (platformApplicationArns.size > 0) {
      const endpointArns: string[] = [];
      for (const arn of platformApplicationArns.values()) {
        endpointArns.push(arn, `${arn}/*`);
      }
      this.notificationWorkerFunction.addToRolePolicy(
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: [
            'sns:CreatePlatformEndpoint',
            'sns:GetEndpointAttributes',
            'sns:SetEndpointAttributes',
            'sns:DeleteEndpoint',
            'sns:Publish',
          ],
          resources: endpointArns,
        }),
      );
    }

    this.notificationWorkerFunction.addEventSource(
      new SqsEventSource(this.notificationCommandsQueue, {
        batchSize: 10,
        maxBatchingWindow: Duration.seconds(5),
        reportBatchItemFailures: true,
      }),
    );

    new CfnOutput(this, 'NotificationCommandsQueueUrl', {
      value: this.notificationCommandsQueue.queueUrl,
      description: 'Queue consumed by services/notification-worker.',
    });
  }

  /**
   * One provider backs every platform application. Its handler is the only
   * principal in the account that reads the push credential secrets.
   */
  private createPlatformApplicationProvider(
    secretArns: string[],
    passableRoles: IRole[],
  ): Provider {
    const onEvent = new LambdaFunction(this, 'PlatformApplicationOnEvent', {
      description: 'Creates and updates SNS platform applications from Secrets Manager.',
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      handler: 'index.handler',
      code: Code.fromInline(PLATFORM_APPLICATION_HANDLER),
      timeout: Duration.minutes(2),
      memorySize: 256,
    });

    // Secrets Manager appends a six-character suffix to the ARN it hands out;
    // accept the configured form and the suffixed form so either can be
    // supplied in configuration without an opaque AccessDenied at deploy time.
    onEvent.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['secretsmanager:GetSecretValue'],
        resources: secretArns.flatMap((arn) => [arn, `${arn}-??????`]),
      }),
    );

    // CreatePlatformApplication has no resource to scope to — the ARN does not
    // exist until the call returns — so creation is account-wide while every
    // subsequent operation is scoped to applications this application named.
    onEvent.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['sns:CreatePlatformApplication'],
        resources: ['*'],
      }),
    );

    onEvent.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          'sns:SetPlatformApplicationAttributes',
          'sns:GetPlatformApplicationAttributes',
          'sns:DeletePlatformApplication',
        ],
        resources: [
          this.formatArn({
            service: 'sns',
            resource: 'app',
            resourceName: '*/kinmap-*',
          }),
        ],
      }),
    );

    onEvent.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['iam:PassRole'],
        resources: passableRoles.map((role) => role.roleArn),
        conditions: { StringEquals: { 'iam:PassedToService': 'sns.amazonaws.com' } },
      }),
    );

    return new Provider(this, 'PlatformApplicationProvider', { onEventHandler: onEvent });
  }
}
