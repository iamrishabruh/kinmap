import { CfnOutput, Duration, Stack } from 'aws-cdk-lib';
import { CfnBudget } from 'aws-cdk-lib/aws-budgets';
import { CfnAnomalyMonitor, CfnAnomalySubscription } from 'aws-cdk-lib/aws-ce';
import {
  Certificate,
  CertificateValidation,
  type ICertificate,
} from 'aws-cdk-lib/aws-certificatemanager';
import { ReadWriteType, Trail } from 'aws-cdk-lib/aws-cloudtrail';
import {
  Effect,
  OpenIdConnectPrincipal,
  OpenIdConnectProvider,
  PolicyStatement,
  Role,
  ServicePrincipal,
  type IOpenIdConnectProvider,
  type IRole,
} from 'aws-cdk-lib/aws-iam';
import { Key, type IKey } from 'aws-cdk-lib/aws-kms';
import { LogGroup } from 'aws-cdk-lib/aws-logs';
import { HostedZone, type IHostedZone } from 'aws-cdk-lib/aws-route53';
import { ObjectOwnership, type IBucket } from 'aws-cdk-lib/aws-s3';
import type { ITopic } from 'aws-cdk-lib/aws-sns';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';

import {
  APP_NAME,
  applyStandardTags,
  cdkEnvironment,
  EDGE_REGION,
  type BaseStackProps,
  type EnvironmentConfig,
  type FoundationResources,
} from '../config/index.js';
import { AlarmSet } from '../constructs/alarm-set.js';
import { SecureBucket } from '../constructs/secure-bucket.js';

/** GitHub's OIDC issuer. Constant, and deliberately not configurable. */
const GITHUB_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';

/** The audience GitHub mints for `configure-aws-credentials`. */
const GITHUB_OIDC_AUDIENCE = 'sts.amazonaws.com';

const SUBJECT_CLAIM = 'token.actions.githubusercontent.com:sub';
const AUDIENCE_CLAIM = 'token.actions.githubusercontent.com:aud';

export type FoundationStackProps = BaseStackProps;

/**
 * Everything the rest of the platform builds on and nothing that changes often:
 * DNS, certificates, encryption keys, log and artifact storage, the audit trail
 * of the AWS account itself, cost guardrails, and the CI deployment identity.
 *
 * Two deliberate constraints shape this file:
 *
 *  - **No context lookups.** `HostedZone.fromLookup`, `Vpc.fromLookup` and
 *    `StringParameter.valueFromLookup` all need live credentials, which would
 *    make `cdk synth` impossible on a fork pull request. The hosted zone is
 *    imported from configuration instead.
 *  - **Two keys, not one.** Coordinates get a dedicated customer-managed key so
 *    that key access can be audited, alarmed and revoked independently of the
 *    operational key used for logs, queues and notifications. Mixing them would
 *    mean anyone who could read a queue could also read location data.
 */
export class FoundationStack extends Stack implements FoundationResources {
  readonly hostedZone: IHostedZone;
  readonly certificate: ICertificate;
  readonly cloudFrontCertificate: ICertificate;
  readonly coordinateKey: IKey;
  readonly operationsKey: IKey;
  readonly artifactBucket: IBucket;
  readonly accessLogBucket: IBucket;
  readonly trailBucket: IBucket;
  readonly alarmTopic: ITopic;
  readonly alarmSet: AlarmSet;
  readonly parameterPrefix: string;
  readonly deployRole: IRole;
  readonly diffRole: IRole;
  readonly trail: Trail;
  /** Present only when the primary region is not us-east-1. */
  readonly edgeStack?: Stack;

  constructor(scope: Construct, id: string, props: FoundationStackProps) {
    super(scope, id, {
      ...props,
      env: cdkEnvironment(props.config),
      terminationProtection: props.terminationProtection ?? props.config.isProduction,
      description:
        props.description ??
        `Kinmap ${props.config.envName} — DNS, certificates, keys, audit and cost guardrails`,
      // Only materialises resources if an edge stack is actually created.
      crossRegionReferences: true,
    });

    const { config } = props;
    this.parameterPrefix = config.parameterPrefix;

    // ---------------------------------------------------------------------
    // Encryption keys
    // ---------------------------------------------------------------------

    const coordinateKey = new Key(this, 'CoordinateKey', {
      alias: `alias/${config.resourcePrefix}-coordinates`,
      description:
        'Envelope-encrypts location coordinates at rest (spec §20). Separate ' +
        'from the operations key so location access can be revoked on its own.',
      enableKeyRotation: true,
      rotationPeriod: Duration.days(365),
      pendingWindow: Duration.days(config.isProduction ? 30 : 7),
      removalPolicy: config.removalPolicy,
    });
    this.coordinateKey = coordinateKey;

    const operationsKey = new Key(this, 'OperationsKey', {
      alias: `alias/${config.resourcePrefix}-operations`,
      description: 'Encrypts queues, notification topics and build artefacts.',
      enableKeyRotation: true,
      rotationPeriod: Duration.days(365),
      pendingWindow: Duration.days(config.isProduction ? 30 : 7),
      removalPolicy: config.removalPolicy,
    });
    // CloudWatch alarms and EventBridge rules publish to the encrypted alarm
    // topic; without this they fail silently with KMSAccessDenied.
    operationsKey.addToResourcePolicy(
      new PolicyStatement({
        sid: 'AllowAwsServicesToPublishToEncryptedTopics',
        effect: Effect.ALLOW,
        principals: [
          new ServicePrincipal('cloudwatch.amazonaws.com'),
          new ServicePrincipal('events.amazonaws.com'),
        ],
        actions: ['kms:Decrypt', 'kms:GenerateDataKey*'],
        resources: ['*'],
      }),
    );
    this.operationsKey = operationsKey;

    // ---------------------------------------------------------------------
    // Buckets
    // ---------------------------------------------------------------------

    // S3 server access logging cannot deliver into an SSE-KMS bucket, so this
    // one stays on SSE-S3. It holds request metadata, never user content.
    this.accessLogBucket = new SecureBucket(this, 'AccessLogBucket', {
      config,
      // S3 log delivery still writes with an ACL, so this one bucket must use
      // ObjectWriter. Every other bucket keeps BUCKET_OWNER_ENFORCED, which
      // disables ACLs entirely — CDK sets accessControl=LogDeliveryWrite on a
      // server-access-log target, and that is rejected outright under
      // BUCKET_OWNER_ENFORCED.
      objectOwnership: ObjectOwnership.OBJECT_WRITER,
      versioned: false,
      expirationDays: config.isProduction ? 365 : 30,
      transitionToInfrequentAccessDays: config.isProduction ? 30 : undefined,
    });

    this.artifactBucket = new SecureBucket(this, 'ArtifactBucket', {
      config,
      encryptionKey: operationsKey,
      serverAccessLogsBucket: this.accessLogBucket,
      serverAccessLogsPrefix: 'artifacts/',
      noncurrentVersionExpirationDays: config.isProduction ? 180 : 30,
      transitionToInfrequentAccessDays: 60,
    });

    // CloudTrail delivers with SSE-S3; adding a CMK here buys nothing that log
    // file validation and bucket policy do not already provide, and it would
    // put the audit trail behind a key whose deletion is itself an audit event.
    this.trailBucket = new SecureBucket(this, 'CloudTrailBucket', {
      config,
      serverAccessLogsBucket: this.accessLogBucket,
      serverAccessLogsPrefix: 'cloudtrail/',
      noncurrentVersionExpirationDays: 90,
      transitionToGlacierDays: config.isProduction ? 90 : undefined,
      expirationDays: config.isProduction ? undefined : 30,
    });

    // ---------------------------------------------------------------------
    // Operational alarm fan-out
    // ---------------------------------------------------------------------

    this.alarmSet = new AlarmSet(this, 'OperationalAlarms', {
      config,
      topicName: 'alarms',
      encryptionKey: operationsKey,
    });
    this.alarmTopic = this.alarmSet.topic;

    // ---------------------------------------------------------------------
    // DNS and certificates
    // ---------------------------------------------------------------------

    const zoneAttributes = { hostedZoneId: config.hostedZoneId, zoneName: config.domain };
    this.hostedZone = HostedZone.fromHostedZoneAttributes(this, 'HostedZone', zoneAttributes);

    this.certificate = new Certificate(this, 'ApiCertificate', {
      domainName: config.apiDomain,
      subjectAlternativeNames: [config.domain, `*.${config.domain}`],
      validation: CertificateValidation.fromDns(this.hostedZone),
    });

    // CloudFront only accepts certificates from us-east-1. When the primary
    // region already is us-east-1 the certificate is created here; otherwise a
    // sibling stack is created in us-east-1 and referenced across regions.
    const edgeIsLocal = config.region === config.edgeRegion;
    if (edgeIsLocal) {
      this.cloudFrontCertificate = new Certificate(this, 'CloudFrontCertificate', {
        domainName: config.webDomain,
        subjectAlternativeNames: [config.domain, `*.${config.domain}`],
        validation: CertificateValidation.fromDns(this.hostedZone),
      });
    } else {
      const edgeStack = new Stack(scope, `${id}-edge`, {
        env: { account: config.account, region: config.edgeRegion },
        description: `Kinmap ${config.envName} — us-east-1 resources required by CloudFront and Cost Explorer`,
        crossRegionReferences: true,
      });
      applyStandardTags(edgeStack, config);
      this.edgeStack = edgeStack;

      const edgeZone = HostedZone.fromHostedZoneAttributes(edgeStack, 'HostedZone', zoneAttributes);
      this.cloudFrontCertificate = new Certificate(edgeStack, 'CloudFrontCertificate', {
        domainName: config.webDomain,
        subjectAlternativeNames: [config.domain, `*.${config.domain}`],
        validation: CertificateValidation.fromDns(edgeZone),
      });
    }

    // Budgets and Cost Explorer anomaly detection are global services whose
    // CloudFormation resources must be created in us-east-1.
    const globalScope: Construct = this.edgeStack ?? this;

    // ---------------------------------------------------------------------
    // Account audit trail
    // ---------------------------------------------------------------------

    const trailLogGroup = new LogGroup(this, 'CloudTrailLogGroup', {
      logGroupName: `/aws/cloudtrail/${config.resourcePrefix}`,
      retention: config.auditLogRetention,
      removalPolicy: config.removalPolicy,
    });

    this.trail = new Trail(this, 'Trail', {
      trailName: `${config.resourcePrefix}-management-events`,
      bucket: this.trailBucket,
      s3KeyPrefix: 'cloudtrail',
      // Log file validation produces the digest chain that proves the trail was
      // not edited after the fact; without it the audit story is unverifiable.
      enableFileValidation: true,
      includeGlobalServiceEvents: true,
      isMultiRegionTrail: true,
      managementEvents: ReadWriteType.ALL,
      sendToCloudWatchLogs: true,
      cloudWatchLogGroup: trailLogGroup,
    });

    // ---------------------------------------------------------------------
    // Cost guardrails
    // ---------------------------------------------------------------------

    new CfnBudget(globalScope, 'MonthlyBudget', {
      budget: {
        // Deliberately unnamed. Changing a subscriber — which is what happens
        // whenever the alarm address moves — forces CloudFormation to replace
        // the budget, and Budgets refuses to create a second one with the same
        // name while the first still exists:
        //
        //   A budget or resource with the same name but a different internalId
        //   already exists.
        //
        // The stack then wedges on a cost alert, which is a silly thing to be
        // blocked by. A generated name lets the replacement happen.
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: config.monthlyBudgetUsd, unit: 'USD' },
      },
      notificationsWithSubscribers: [
        {
          notification: {
            notificationType: 'ACTUAL',
            comparisonOperator: 'GREATER_THAN',
            threshold: 80,
            thresholdType: 'PERCENTAGE',
          },
          subscribers: [{ subscriptionType: 'EMAIL', address: config.alarmEmail }],
        },
        {
          notification: {
            notificationType: 'ACTUAL',
            comparisonOperator: 'GREATER_THAN',
            threshold: 100,
            thresholdType: 'PERCENTAGE',
          },
          subscribers: [{ subscriptionType: 'EMAIL', address: config.alarmEmail }],
        },
        {
          notification: {
            notificationType: 'FORECASTED',
            comparisonOperator: 'GREATER_THAN',
            threshold: 100,
            thresholdType: 'PERCENTAGE',
          },
          subscribers: [{ subscriptionType: 'EMAIL', address: config.alarmEmail }],
        },
      ],
    });

    const anomalyMonitor = new CfnAnomalyMonitor(globalScope, 'CostAnomalyMonitor', {
      monitorName: `${config.resourcePrefix}-service-monitor`,
      monitorType: 'DIMENSIONAL',
      monitorDimension: 'SERVICE',
    });

    new CfnAnomalySubscription(globalScope, 'CostAnomalySubscription', {
      subscriptionName: `${config.resourcePrefix}-cost-anomaly`,
      frequency: 'DAILY',
      monitorArnList: [anomalyMonitor.attrMonitorArn],
      subscribers: [{ type: 'EMAIL', address: config.alarmEmail }],
      thresholdExpression: JSON.stringify({
        Dimensions: {
          Key: 'ANOMALY_TOTAL_IMPACT_ABSOLUTE',
          MatchOptions: ['GREATER_THAN_OR_EQUAL'],
          Values: [String(config.costAnomalyThresholdUsd)],
        },
      }),
    });

    // ---------------------------------------------------------------------
    // GitHub Actions deployment identity (spec §7 — OIDC only, no static keys)
    // ---------------------------------------------------------------------

    const oidcProvider = this.resolveGitHubOidcProvider(config);
    const repo = `repo:${config.github.owner}/${config.github.repository}`;

    const deployRole = new Role(this, 'GitHubDeployRole', {
      roleName: `${config.resourcePrefix}-github-deploy`,
      description: `Assumed by GitHub Actions from ${repo} to deploy ${config.envName}.`,
      maxSessionDuration: Duration.hours(1),
      assumedBy: new OpenIdConnectPrincipal(oidcProvider, {
        StringEquals: { [AUDIENCE_CLAIM]: GITHUB_OIDC_AUDIENCE },
        StringLike: { [SUBJECT_CLAIM]: [...config.github.deploySubjectClaims] },
      }),
    });
    // The role itself holds no deployment permissions. It may only assume the
    // CDK bootstrap roles, which is what actually mutates the account — so the
    // blast radius of a leaked OIDC token is bounded by the bootstrap policy.
    deployRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: 'AssumeCdkBootstrapRoles',
        effect: Effect.ALLOW,
        actions: ['sts:AssumeRole'],
        resources: [`arn:${this.partition}:iam::${config.account}:role/cdk-*`],
      }),
    );
    deployRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: 'ReadCdkBootstrapVersion',
        effect: Effect.ALLOW,
        actions: ['ssm:GetParameter', 'ssm:GetParameters'],
        resources: [
          `arn:${this.partition}:ssm:${config.region}:${config.account}:parameter/cdk-bootstrap/*`,
          `arn:${this.partition}:ssm:${EDGE_REGION}:${config.account}:parameter/cdk-bootstrap/*`,
        ],
      }),
    );
    this.deployRole = deployRole;

    // `cdk diff` runs on pull requests, so this role is reachable from any
    // branch a contributor can push. The AWS-managed ReadOnlyAccess policy is
    // deliberately NOT used: it would let a pull request read DynamoDB items
    // and S3 objects, i.e. real families' location data.
    const diffRole = new Role(this, 'GitHubDiffRole', {
      roleName: `${config.resourcePrefix}-github-diff`,
      description: `Assumed by GitHub Actions from ${repo} to run \`cdk diff\` against ${config.envName}.`,
      maxSessionDuration: Duration.hours(1),
      assumedBy: new OpenIdConnectPrincipal(oidcProvider, {
        StringEquals: { [AUDIENCE_CLAIM]: GITHUB_OIDC_AUDIENCE },
        StringLike: { [SUBJECT_CLAIM]: [...config.github.diffSubjectClaims] },
      }),
    });
    diffRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: 'DescribeDeployedTemplates',
        effect: Effect.ALLOW,
        actions: [
          'cloudformation:DescribeStacks',
          'cloudformation:DescribeStackEvents',
          'cloudformation:DescribeStackResources',
          'cloudformation:GetTemplate',
          'cloudformation:GetTemplateSummary',
          'cloudformation:ListStacks',
        ],
        resources: ['*'],
      }),
    );
    diffRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: 'ReadCdkBootstrapVersionForDiff',
        effect: Effect.ALLOW,
        actions: ['ssm:GetParameter', 'ssm:GetParameters'],
        resources: [
          `arn:${this.partition}:ssm:${config.region}:${config.account}:parameter/cdk-bootstrap/*`,
        ],
      }),
    );
    this.diffRole = diffRole;

    // ---------------------------------------------------------------------
    // SSM parameter namespace — how services and scripts discover the account
    // ---------------------------------------------------------------------

    this.publishParameter('Domain', 'domain', config.domain);
    this.publishParameter('ApiDomain', 'api-domain', config.apiDomain);
    this.publishParameter('WebDomain', 'web-domain', config.webDomain);
    this.publishParameter('HostedZoneId', 'hosted-zone-id', config.hostedZoneId);
    this.publishParameter('CoordinateKeyId', 'coordinate-key-id', coordinateKey.keyId);
    this.publishParameter('CoordinateKeyArn', 'coordinate-key-arn', coordinateKey.keyArn);
    this.publishParameter('OperationsKeyArn', 'operations-key-arn', operationsKey.keyArn);
    this.publishParameter('ArtifactBucketName', 'artifact-bucket', this.artifactBucket.bucketName);
    this.publishParameter('AlarmTopicArn', 'alarm-topic-arn', this.alarmTopic.topicArn);
    this.publishParameter(
      'ApiCertificateArn',
      'api-certificate-arn',
      this.certificate.certificateArn,
    );

    // ---------------------------------------------------------------------
    // Outputs
    // ---------------------------------------------------------------------

    new CfnOutput(this, 'CoordinateKeyIdOutput', {
      value: coordinateKey.keyId,
      description: 'COORDINATE_KEY_ID for every service that touches location data',
      exportName: `${config.resourcePrefix}-coordinate-key-id`,
    });
    new CfnOutput(this, 'AlarmTopicArnOutput', {
      value: this.alarmTopic.topicArn,
      description: 'SNS topic every operational alarm publishes to',
    });
    new CfnOutput(this, 'DeployRoleArnOutput', {
      value: deployRole.roleArn,
      description: 'AWS_DEPLOY_ROLE_ARN for the GitHub environment',
    });
    new CfnOutput(this, 'DiffRoleArnOutput', {
      value: diffRole.roleArn,
      description: 'AWS_DIFF_ROLE_ARN for the infrastructure-diff workflow',
    });
    new CfnOutput(this, 'ArtifactBucketNameOutput', {
      value: this.artifactBucket.bucketName,
      description: 'Build artefact and export bucket',
    });
  }

  /**
   * An account may hold only one OIDC provider per issuer URL, so an account
   * that already trusts GitHub imports the existing one rather than failing the
   * deployment with EntityAlreadyExists.
   */
  private resolveGitHubOidcProvider(config: EnvironmentConfig): IOpenIdConnectProvider {
    const existing = config.github.existingOidcProviderArn;
    if (existing !== undefined) {
      return OpenIdConnectProvider.fromOpenIdConnectProviderArn(
        this,
        'GitHubOidcProvider',
        existing,
      );
    }
    return new OpenIdConnectProvider(this, 'GitHubOidcProvider', {
      url: GITHUB_OIDC_ISSUER,
      clientIds: [GITHUB_OIDC_AUDIENCE],
    });
  }

  /** Writes one value into the `/kinmap/<env>` namespace this stack owns. */
  private publishParameter(id: string, name: string, value: string): StringParameter {
    return new StringParameter(this, `${id}Parameter`, {
      parameterName: `${this.parameterPrefix}/${name}`,
      stringValue: value,
      description: `${APP_NAME} ${name}`,
    });
  }
}
