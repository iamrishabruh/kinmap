import { Duration, Stack } from 'aws-cdk-lib';
import { CfnAnalyzer } from 'aws-cdk-lib/aws-accessanalyzer';
import { BackupPlan, BackupPlanRule, BackupResource, BackupVault } from 'aws-cdk-lib/aws-backup';
import { Alarm, ComparisonOperator, Metric, TreatMissingData } from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import {
  CfnConfigRule,
  CfnConfigurationRecorder,
  CfnDeliveryChannel,
} from 'aws-cdk-lib/aws-config';
import { Schedule } from 'aws-cdk-lib/aws-events';
import { CfnDetector } from 'aws-cdk-lib/aws-guardduty';
import {
  Effect,
  ManagedPolicy,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from 'aws-cdk-lib/aws-iam';
import { Key, type IKey } from 'aws-cdk-lib/aws-kms';
import {
  Architecture,
  Code,
  Function as LambdaFunction,
  Runtime,
  Tracing,
} from 'aws-cdk-lib/aws-lambda';
import { LogGroup } from 'aws-cdk-lib/aws-logs';
import { Secret, type ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import { CfnHub } from 'aws-cdk-lib/aws-securityhub';
import type { Construct } from 'constructs';

import {
  cdkEnvironment,
  type BaseStackProps,
  type EnvironmentConfig,
  type FoundationResources,
} from '../config/index.js';
import { SecureBucket } from '../constructs/secure-bucket.js';

/**
 * Account perimeter and durability.
 *
 * Detection (GuardDuty, Security Hub, IAM Access Analyzer, AWS Config), secret
 * rotation, and AWS Backup over the DynamoDB tables that hold the data this
 * product cannot afford to lose.
 *
 * The backup selection addresses tables by their conventional ARN
 * (`kinmap-<env>-<Table>`) rather than importing `DataTables`. That is
 * deliberate: this stack and the data stack are siblings with no ordering
 * between them, so a real reference would force the backup policy to deploy
 * behind every table change — and a backup plan that cannot be deployed during
 * an incident is not a backup plan.
 *
 * Account-level singletons: a GuardDuty detector, the Security Hub
 * subscription, the Config recorder and its delivery channel are all
 * one-per-account-per-region. Deploy this stack for one environment per AWS
 * account, or pass `enableAccountLevelServices: false` for environments that
 * share an account with the one that owns them.
 */

/**
 * Tables covered by the backup plan. Physical names follow the platform
 * convention `<resourcePrefix>-<Table>` applied by the GuardedTable construct.
 */
export const BACKED_UP_TABLES: readonly string[] = [
  'Users',
  'Devices',
  'Families',
  'FamilyMemberships',
  'Invitations',
  'CurrentLocations',
  'LocationHistory',
  'SavedPlaces',
  'GeofenceState',
  'NotificationPreferences',
  'LiveSessions',
  'Subscriptions',
  'AuditEvents',
  'DataMigrations',
  'RemoteConfiguration',
  'DeletionJobs',
];

/** High-value AWS Config managed rules, addressed by their stable identifiers. */
const CONFIG_RULES: ReadonlyArray<{ id: string; identifier: string; description: string }> = [
  {
    id: 'S3PublicReadProhibited',
    identifier: 'S3_BUCKET_PUBLIC_READ_PROHIBITED',
    description: 'No bucket may be publicly readable.',
  },
  {
    id: 'S3PublicWriteProhibited',
    identifier: 'S3_BUCKET_PUBLIC_WRITE_PROHIBITED',
    description: 'No bucket may be publicly writable.',
  },
  {
    id: 'S3SslRequestsOnly',
    identifier: 'S3_BUCKET_SSL_REQUESTS_ONLY',
    description: 'Buckets must reject plaintext requests.',
  },
  {
    id: 'DynamoPitrEnabled',
    identifier: 'DYNAMODB_PITR_ENABLED',
    description: 'Location and membership data must stay point-in-time recoverable.',
  },
  {
    id: 'DynamoTableEncryptedKms',
    identifier: 'DYNAMODB_TABLE_ENCRYPTED_KMS',
    description: 'Every table must use the customer-managed key, not an AWS-owned one.',
  },
  {
    id: 'LambdaPublicAccessProhibited',
    identifier: 'LAMBDA_FUNCTION_PUBLIC_ACCESS_PROHIBITED',
    description: 'No function may be invokable by the world.',
  },
  {
    id: 'SecretsRotationEnabled',
    identifier: 'SECRETSMANAGER_ROTATION_ENABLED_CHECK',
    description: 'Long-lived signing material must rotate.',
  },
  {
    id: 'IamRootAccessKeyCheck',
    identifier: 'IAM_ROOT_ACCESS_KEY_CHECK',
    description: 'The account root must not hold access keys.',
  },
  {
    id: 'CloudTrailEnabled',
    identifier: 'CLOUD_TRAIL_ENABLED',
    description: 'The audit trail of the AWS account itself must stay on.',
  },
];

/**
 * Rotation handler for self-managed secrets: material we mint ourselves and
 * that no external system has to be told about. It implements the four-step
 * Secrets Manager protocol; `setSecret`/`testSecret` validate the pending value
 * rather than being a no-op that would happily promote an unusable secret.
 */
const ROTATION_HANDLER_SOURCE = [
  "const sm = require('@aws-sdk/client-secrets-manager');",
  'const client = new sm.SecretsManagerClient({});',
  'exports.handler = async (event) => {',
  '  const id = event.SecretId;',
  '  const token = event.ClientRequestToken;',
  '  const step = event.Step;',
  '  const meta = await client.send(new sm.DescribeSecretCommand({ SecretId: id }));',
  "  if (!meta.RotationEnabled) throw new Error('Rotation is not enabled for this secret');",
  '  const stages = (meta.VersionIdsToStages || {})[token];',
  "  if (!stages) throw new Error('Rotation token has no staging label');",
  "  if (stages.indexOf('AWSCURRENT') >= 0) return;",
  "  if (stages.indexOf('AWSPENDING') < 0) throw new Error('Rotation token is not AWSPENDING');",
  "  if (step === 'createSecret') {",
  '    try {',
  "      await client.send(new sm.GetSecretValueCommand({ SecretId: id, VersionId: token, VersionStage: 'AWSPENDING' }));",
  '    } catch (err) {',
  '      const generated = await client.send(new sm.GetRandomPasswordCommand({',
  '        PasswordLength: 64, ExcludePunctuation: true, RequireEachIncludedType: true,',
  '      }));',
  '      await client.send(new sm.PutSecretValueCommand({',
  '        SecretId: id, ClientRequestToken: token,',
  '        SecretString: JSON.stringify({ signingKey: generated.RandomPassword, rotatedAt: new Date().toISOString() }),',
  "        VersionStages: ['AWSPENDING'],",
  '      }));',
  '    }',
  '    return;',
  '  }',
  "  if (step === 'setSecret' || step === 'testSecret') {",
  "    const pending = await client.send(new sm.GetSecretValueCommand({ SecretId: id, VersionId: token, VersionStage: 'AWSPENDING' }));",
  "    const parsed = JSON.parse(pending.SecretString || '{}');",
  "    if (!parsed.signingKey || parsed.signingKey.length < 32) throw new Error('Pending secret is unusable');",
  '    return;',
  '  }',
  "  if (step === 'finishSecret') {",
  '    let current;',
  '    const staged = meta.VersionIdsToStages || {};',
  "    for (const versionId of Object.keys(staged)) { if (staged[versionId].indexOf('AWSCURRENT') >= 0) current = versionId; }",
  '    if (current === token) return;',
  '    await client.send(new sm.UpdateSecretVersionStageCommand({',
  "      SecretId: id, VersionStage: 'AWSCURRENT', MoveToVersionId: token, RemoveFromVersionId: current,",
  '    }));',
  '    return;',
  '  }',
  "  throw new Error('Unknown rotation step: ' + step);",
  '};',
].join('\n');

export interface SecurityStackProps extends BaseStackProps {
  /**
   * Shared account resources, when they are available. This stack is
   * deliberately able to stand alone — it holds the detective controls, and a
   * broken application stack must never be able to leave the account without
   * them — so it provisions its own key when the foundation is not supplied.
   */
  readonly foundation?: FoundationResources;
  /** Unqualified table names to protect. Defaults to {@link BACKED_UP_TABLES}. */
  readonly tableNames?: readonly string[];
  /** Set false when another environment in the same account owns the singletons. */
  readonly enableAccountLevelServices?: boolean;
  /** Existing secrets that should adopt the same rotation schedule. */
  readonly additionalRotatedSecretArns?: readonly string[];
}

export class SecurityStack extends Stack {
  public readonly backupVault: BackupVault;
  public readonly backupPlan: BackupPlan;
  /** Self-managed signing key; rotates on the schedule set below. */
  public readonly rotatingSigningSecret: Secret;
  public readonly rotationFunction: LambdaFunction;

  public constructor(scope: Construct, id: string, props: SecurityStackProps) {
    super(scope, id, {
      ...props,
      env: cdkEnvironment(props.config),
      description: `Kinmap ${props.config.envName} — threat detection, configuration compliance, secret rotation and backup`,
    });

    const { config } = props;
    const accountLevel = props.enableAccountLevelServices ?? true;

    // This stack owns its key rather than borrowing the foundation's. Attaching
    // a rotation schedule makes CDK grant the rotation function on the secret's
    // key, which writes a statement into that key's policy — from here, that
    // would point a dependency edge back at the foundation while this stack
    // already reads from it, i.e. a cycle. Owning the key also means backup and
    // rotation material can be re-keyed without touching the rest of the
    // platform.
    const encryptionKey = new Key(this, 'SecurityKey', {
      alias: `alias/${config.resourcePrefix}-security`,
      description: 'Encrypts the Kinmap backup vault and the self-managed signing secret.',
      enableKeyRotation: true,
      removalPolicy: config.removalPolicy,
    });

    if (accountLevel) {
      this.enableDetection(config);
    }

    this.createConfigRecorder(config, props, accountLevel);

    this.rotationFunction = this.createRotationFunction(config);
    this.rotatingSigningSecret = this.createRotatingSecret(config, encryptionKey);

    this.rotatingSigningSecret.addRotationSchedule('Rotation', {
      rotationLambda: this.rotationFunction,
      automaticallyAfter: this.rotationInterval(config),
    });

    for (const [index, arn] of (props.additionalRotatedSecretArns ?? []).entries()) {
      const imported: ISecret = Secret.fromSecretCompleteArn(
        this,
        `ImportedRotatedSecret${index}`,
        arn,
      );
      imported.addRotationSchedule(`ImportedRotation${index}`, {
        rotationLambda: this.rotationFunction,
        automaticallyAfter: this.rotationInterval(config),
      });
    }

    const { vault, plan } = this.createBackupPlan(config, props, encryptionKey);
    this.backupVault = vault;
    this.backupPlan = plan;

    this.createAlarms(config, props, vault);
  }

  /**
   * A silent backup failure and a silent rotation failure look identical from
   * the outside — everything keeps working right up until the moment it
   * matters. Both are alarmed. Referencing the foundation's topic is a one-way
   * read, so it introduces no dependency cycle.
   */
  private createAlarms(
    config: EnvironmentConfig,
    props: SecurityStackProps,
    vault: BackupVault,
  ): void {
    const backupFailures = new Alarm(this, 'BackupJobFailureAlarm', {
      alarmName: `${config.resourcePrefix}-backup-job-failures`,
      alarmDescription: 'An AWS Backup job failed; the recovery points are not what we think.',
      metric: new Metric({
        namespace: 'AWS/Backup',
        metricName: 'NumberOfBackupJobsFailed',
        dimensionsMap: { BackupVaultName: vault.backupVaultName },
        statistic: 'Sum',
        period: Duration.hours(1),
      }),
      threshold: 0,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });

    const rotationFailures = new Alarm(this, 'SecretRotationFailureAlarm', {
      alarmName: `${config.resourcePrefix}-secret-rotation-failures`,
      alarmDescription: 'Secret rotation is failing; signing material is ageing past its schedule.',
      metric: this.rotationFunction.metricErrors({
        period: Duration.hours(1),
        statistic: 'Sum',
      }),
      threshold: 0,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });

    const alarmTopic = props.foundation?.alarmTopic;
    if (alarmTopic === undefined) {
      return;
    }
    const action = new SnsAction(alarmTopic);
    for (const alarm of [backupFailures, rotationFailures]) {
      alarm.addAlarmAction(action);
      alarm.addOkAction(action);
    }
  }

  // -------------------------------------------------------------------------

  private rotationInterval(config: EnvironmentConfig): Duration {
    return Duration.days(config.isProduction ? 90 : 365);
  }

  /**
   * GuardDuty, Security Hub and IAM Access Analyzer. All three are account-wide
   * detectors; none of them can see the contents of a DynamoDB item, which is
   * the point — detection operates on control-plane behaviour, not user data.
   */
  private enableDetection(config: EnvironmentConfig): void {
    new CfnDetector(this, 'GuardDutyDetector', {
      enable: true,
      findingPublishingFrequency: 'FIFTEEN_MINUTES',
      dataSources: {
        s3Logs: { enable: true },
        kubernetes: { auditLogs: { enable: false } },
      },
    });

    new CfnHub(this, 'SecurityHub', {
      enableDefaultStandards: true,
      controlFindingGenerator: 'SECURITY_CONTROL',
      autoEnableControls: true,
    });

    new CfnAnalyzer(this, 'AccessAnalyzer', {
      analyzerName: `${config.resourcePrefix}-account`,
      type: 'ACCOUNT',
    });
  }

  /**
   * AWS Config: the recorder, its delivery channel, and the rules that encode
   * invariants this product must not lose quietly.
   */
  private createConfigRecorder(
    config: EnvironmentConfig,
    props: SecurityStackProps,
    accountLevel: boolean,
  ): SecureBucket {
    // Server access logs deliberately stay off: the delivery policy CDK writes
    // onto a log bucket in another stack references this bucket's ARN, which
    // would point a dependency edge back at the foundation and create a cycle.
    // Access to this bucket is already covered by CloudTrail and its own
    // TLS-only bucket policy.
    const configBucket = new SecureBucket(this, 'ConfigBucket', {
      config,
      expirationDays: config.isProduction ? 730 : 90,
      transitionToInfrequentAccessDays: 60,
    });

    if (!accountLevel) {
      return configBucket;
    }

    const recorderRole = new Role(this, 'ConfigRecorderRole', {
      assumedBy: new ServicePrincipal('config.amazonaws.com'),
      description: 'AWS Config configuration recorder',
      managedPolicies: [ManagedPolicy.fromAwsManagedPolicyName('service-role/AWS_ConfigRole')],
    });
    configBucket.grantPut(recorderRole);
    recorderRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: 'ReadDeliveryBucketAcl',
        effect: Effect.ALLOW,
        actions: ['s3:GetBucketAcl', 's3:ListBucket'],
        resources: [configBucket.bucketArn],
      }),
    );

    const recorder = new CfnConfigurationRecorder(this, 'ConfigRecorder', {
      name: config.resourcePrefix,
      roleArn: recorderRole.roleArn,
      recordingGroup: { allSupported: true, includeGlobalResourceTypes: true },
    });

    // Config refuses to start a recorder that has nowhere to deliver to, so the
    // channel must exist first.
    const deliveryChannel = new CfnDeliveryChannel(this, 'ConfigDeliveryChannel', {
      name: config.resourcePrefix,
      s3BucketName: configBucket.bucketName,
      configSnapshotDeliveryProperties: { deliveryFrequency: 'TwentyFour_Hours' },
    });
    deliveryChannel.node.addDependency(recorder);

    for (const rule of CONFIG_RULES) {
      const configRule = new CfnConfigRule(this, `ConfigRule${rule.id}`, {
        configRuleName: `${config.resourcePrefix}-${rule.identifier.toLowerCase()}`,
        description: rule.description,
        source: { owner: 'AWS', sourceIdentifier: rule.identifier },
      });
      configRule.node.addDependency(deliveryChannel);
    }

    return configBucket;
  }

  private createRotationFunction(config: EnvironmentConfig): LambdaFunction {
    const functionName = `${config.resourcePrefix}-secret-rotation`;

    const logGroup = new LogGroup(this, 'SecretRotationLogGroup', {
      logGroupName: `/aws/lambda/${functionName}`,
      retention: config.auditLogRetention,
      removalPolicy: config.removalPolicy,
    });

    return new LambdaFunction(this, 'SecretRotationFunction', {
      functionName,
      description: 'Four-step Secrets Manager rotation for self-managed signing material',
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      handler: 'index.handler',
      // Inline rather than bundled: the whole rotation protocol fits on one
      // screen, and a rotation handler that needs a build step is a rotation
      // handler that stops working the first time the build breaks.
      code: Code.fromInline(ROTATION_HANDLER_SOURCE),
      timeout: Duration.seconds(60),
      memorySize: 256,
      tracing: Tracing.ACTIVE,
      logGroup,
      environment: { APP_ENV: config.envName },
    });
  }

  private createRotatingSecret(config: EnvironmentConfig, encryptionKey: IKey): Secret {
    return new Secret(this, 'RotatingSigningSecret', {
      secretName: `${config.parameterPrefix}/security/signing-key`,
      description: 'Self-managed key used to sign internal service-to-service requests',
      encryptionKey,
      removalPolicy: config.removalPolicy,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ rotatedAt: 'never' }),
        generateStringKey: 'signingKey',
        passwordLength: 64,
        excludePunctuation: true,
      },
    });
  }

  /**
   * AWS Backup over the DynamoDB tables. Point-in-time recovery already covers
   * the last 35 days inside DynamoDB; this covers the case PITR does not — the
   * table itself being deleted, or the account being compromised — by copying
   * recovery points into a vault with its own key and, in production, recovery
   * point deletion blocked.
   */
  private createBackupPlan(
    config: EnvironmentConfig,
    props: SecurityStackProps,
    encryptionKey: IKey,
  ): { vault: BackupVault; plan: BackupPlan } {
    const vault = new BackupVault(this, 'BackupVault', {
      backupVaultName: config.resourcePrefix,
      encryptionKey,
      removalPolicy: config.removalPolicy,
      blockRecoveryPointDeletion: config.isProduction,
    });

    const plan = new BackupPlan(this, 'BackupPlan', {
      backupPlanName: `${config.resourcePrefix}-dynamodb`,
      backupVault: vault,
    });

    plan.addRule(
      new BackupPlanRule({
        ruleName: 'daily',
        scheduleExpression: Schedule.cron({ minute: '0', hour: '4' }),
        startWindow: Duration.hours(1),
        completionWindow: Duration.hours(5),
        deleteAfter: Duration.days(config.isProduction ? 35 : 7),
      }),
    );

    if (config.isProduction) {
      plan.addRule(
        new BackupPlanRule({
          ruleName: 'weekly',
          scheduleExpression: Schedule.cron({ minute: '0', hour: '5', weekDay: 'SUN' }),
          startWindow: Duration.hours(1),
          completionWindow: Duration.hours(7),
          moveToColdStorageAfter: Duration.days(30),
          deleteAfter: Duration.days(365),
        }),
      );
    }

    const tableNames = props.tableNames ?? BACKED_UP_TABLES;
    plan.addSelection('DynamoTables', {
      backupSelectionName: `${config.resourcePrefix}-tables`,
      resources: tableNames.map((name) =>
        BackupResource.fromArn(
          this.formatArn({
            service: 'dynamodb',
            resource: 'table',
            resourceName: `${config.resourcePrefix}-${name}`,
          }),
        ),
      ),
      // Restores write user data back into live tables. Outside development
      // that is an operator-approved action, not something the backup role
      // should be able to do on its own.
      allowRestores: !config.isProduction,
    });

    return { vault, plan };
  }
}
