import { ArnFormat, CfnOutput, Duration, Stack } from 'aws-cdk-lib';
import { Alarm, ComparisonOperator, TreatMissingData } from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import { Table, type ITable } from 'aws-cdk-lib/aws-dynamodb';
import { Rule, RuleTargetInput, Schedule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction as LambdaTarget } from 'aws-cdk-lib/aws-events-targets';
import { Effect, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import {
  Architecture,
  Code,
  Function as LambdaFunction,
  Runtime,
  Tracing,
} from 'aws-cdk-lib/aws-lambda';
import { LogGroup } from 'aws-cdk-lib/aws-logs';
import { Queue, QueueEncryption } from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';

import {
  cdkEnvironment,
  type BaseStackProps,
  type DataTables,
  type FoundationResources,
} from '../config/index.js';

/**
 * Unattended data migrations (spec §15).
 *
 * `scripts/migrations/cli.ts` is the operator-facing runner: it discovers the
 * migrations in `migrations/data`, tracks state in the DataMigrations table and
 * refuses an unattended production apply. This stack is the same state machine
 * running inside the account, with four properties that matter:
 *
 *  - **Dry run by default.** The runner reports a plan unless an apply is asked
 *    for explicitly, in the event payload, with `dryRun: false`.
 *  - **It never transforms data itself.** Each migration item carries the ARN of
 *    the worker Lambda that performs its transformation; the runner drives
 *    apply → verify and records the outcome. Infrastructure orchestrates,
 *    migrations migrate.
 *  - **It publishes progress**, so `MigrationProgressPercent` and
 *    `MigrationFailed` in the observability stack have something to observe.
 *  - **The schedule is disabled in production.** There, the only path to a
 *    migration is a manual invoke behind the GitHub environment approval, which
 *    keeps the approval and the audit trail in the same place.
 */

/**
 * The runner. Deliberately dependency-free: the Node 22 runtime ships the AWS
 * SDK v3, so there is nothing to bundle and the entire control plane for
 * migrations stays readable in one place.
 */
const MIGRATION_RUNNER_SOURCE = [
  "const ddbLib = require('@aws-sdk/client-dynamodb');",
  "const lambdaLib = require('@aws-sdk/client-lambda');",
  'const ddb = new ddbLib.DynamoDBClient({});',
  'const fns = new lambdaLib.LambdaClient({});',
  'const TABLE = process.env.DATA_MIGRATIONS_TABLE;',
  'const NS = process.env.METRICS_NAMESPACE;',
  'const ENV = process.env.APP_ENV;',
  "const DONE = ['APPLIED', 'VERIFIED', 'ROLLED_BACK'];",
  'function emit(name, value, unit) {',
  '  process.stdout.write(JSON.stringify({',
  '    _aws: { Timestamp: Date.now(), CloudWatchMetrics: [{ Namespace: NS,',
  "      Dimensions: [['Environment', 'Component']],",
  "      Metrics: [{ Name: name, Unit: unit || 'Count' }] }] },",
  "    Environment: ENV, Component: 'migration-runner', [name]: value,",
  "  }) + '\\n');",
  '}',
  'function text(attr) { return attr && attr.S ? attr.S : undefined; }',
  'async function loadAll() {',
  '  const out = []; let start;',
  '  do {',
  '    const page = await ddb.send(new ddbLib.ScanCommand({ TableName: TABLE, ExclusiveStartKey: start }));',
  '    for (const item of page.Items || []) {',
  "      out.push({ id: text(item.id), status: text(item.status) || 'PENDING', workerArn: text(item.workerArn) });",
  '    }',
  '    start = page.LastEvaluatedKey;',
  '  } while (start);',
  '  return out.filter((m) => m.id).sort((a, b) => a.id.localeCompare(b.id));',
  '}',
  'async function record(id, status, detail) {',
  '  await ddb.send(new ddbLib.UpdateItemCommand({',
  '    TableName: TABLE, Key: { id: { S: id } },',
  "    UpdateExpression: 'SET #s = :s, environment = :e, updatedAt = :u, detail = :d',",
  "    ExpressionAttributeNames: { '#s': 'status' },",
  "    ExpressionAttributeValues: { ':s': { S: status }, ':e': { S: ENV },",
  "      ':u': { S: new Date().toISOString() }, ':d': { S: (detail || 'none').slice(0, 512) } },",
  '  }));',
  '}',
  'async function runPhase(migration, phase) {',
  '  const res = await fns.send(new lambdaLib.InvokeCommand({',
  "    FunctionName: migration.workerArn, InvocationType: 'RequestResponse',",
  '    Payload: Buffer.from(JSON.stringify({ migrationId: migration.id, environment: ENV, phase })),',
  '  }));',
  "  if (res.FunctionError) throw new Error(phase + ' reported ' + res.FunctionError);",
  '}',
  'exports.handler = async (event) => {',
  "  if (!TABLE) throw new Error('DATA_MIGRATIONS_TABLE is not configured');",
  '  const request = event || {};',
  "  const action = request.action || 'plan';",
  "  const dryRun = request.dryRun === undefined ? process.env.DRY_RUN !== 'false' : request.dryRun !== false;",
  '  const all = await loadAll();',
  '  const pending = all.filter((m) => DONE.indexOf(m.status) < 0);',
  '  const percent = all.length === 0 ? 100 : Math.round(((all.length - pending.length) / all.length) * 100);',
  "  emit('MigrationProgressPercent', percent, 'Percent');",
  "  emit('MigrationPending', pending.length);",
  "  if (action === 'plan' || dryRun) {",
  '    return { action, dryRun: true, environment: ENV, total: all.length, pending: pending.map((m) => m.id) };',
  '  }',
  "  if (action !== 'apply') throw new Error('Unsupported action: ' + action);",
  '  const applied = []; let failed = 0;',
  '  for (const migration of pending) {',
  '    if (!migration.workerArn) {',
  "      failed++; await record(migration.id, 'FAILED', 'no worker'); continue;",
  '    }',
  '    try {',
  "      await record(migration.id, 'RUNNING', 'started');",
  "      await runPhase(migration, 'apply');",
  "      await record(migration.id, 'APPLIED', 'applied');",
  "      await runPhase(migration, 'verify');",
  "      await record(migration.id, 'VERIFIED', 'verified');",
  '      applied.push(migration.id);',
  '    } catch (error) {',
  '      failed++;',
  "      await record(migration.id, 'FAILED', error && error.message ? error.message : 'unknown');",
  '      break;',
  '    }',
  '  }',
  "  emit('MigrationFailed', failed);",
  "  emit('MigrationApplied', applied.length);",
  '  return { action, dryRun: false, environment: ENV, applied, failed };',
  '};',
].join('\n');

export interface MigrationStackProps extends BaseStackProps {
  /** Shared account resources, when the foundation is wired in. */
  readonly foundation?: FoundationResources;
  /** Full table set. Only {@link DataTables.dataMigrations} is used. */
  readonly tables?: DataTables;
  /** The DataMigrations table on its own, when the full set is not to hand. */
  readonly dataMigrationsTable?: ITable;
  /**
   * Default for the runner's `DRY_RUN` variable. Defaults to `true` in every
   * environment: applying a migration is an explicit act, never a default.
   */
  readonly dryRun?: boolean;
  /** EMF namespace shared with the observability stack. */
  readonly metricNamespace?: string;
}

export class MigrationStack extends Stack {
  public readonly runner: LambdaFunction;
  public readonly schedule: Rule;
  public readonly dataMigrationsTable: ITable;

  public constructor(scope: Construct, id: string, props: MigrationStackProps) {
    super(scope, id, {
      ...props,
      env: cdkEnvironment(props.config),
      description: `Kinmap ${props.config.envName} — data migration runner, progress metrics and its schedule`,
    });

    const { config, foundation } = props;
    const dryRun = props.dryRun ?? true;
    const functionName = `${config.resourcePrefix}-migration-runner`;

    // Prefer a real reference so the grant is exact; fall back to the naming
    // convention the GuardedTable construct applies, which keeps this stack
    // deployable without waiting on the data stack.
    const table =
      props.tables?.dataMigrations ??
      props.dataMigrationsTable ??
      Table.fromTableName(this, 'DataMigrationsTable', `${config.resourcePrefix}-DataMigrations`);
    this.dataMigrationsTable = table;

    const logGroup = new LogGroup(this, 'MigrationRunnerLogGroup', {
      logGroupName: `/aws/lambda/${functionName}`,
      // Migration history is part of the operational audit trail.
      retention: config.auditLogRetention,
      removalPolicy: config.removalPolicy,
    });

    this.runner = new LambdaFunction(this, 'MigrationRunner', {
      functionName,
      description:
        'Reads DataMigrations, publishes progress metrics and — only when explicitly asked — drives each migration worker through apply and verify.',
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      handler: 'index.handler',
      code: Code.fromInline(MIGRATION_RUNNER_SOURCE),
      timeout: Duration.minutes(15),
      memorySize: 512,
      // One migration run at a time; concurrent runners would race on status.
      //
      // Production only: a fresh AWS account has a total Lambda concurrency of
      // 10 and requires 10 to remain unreserved, so any reservation fails
      // outright. The DataMigrations table's conditional writes are the actual
      // guard against a double-apply — this reservation is defence in depth,
      // not the mechanism — so dropping it outside production is safe.
      reservedConcurrentExecutions: config.isProduction ? 1 : undefined,
      tracing: Tracing.ACTIVE,
      logGroup,
      environment: {
        APP_ENV: config.envName,
        DATA_MIGRATIONS_TABLE: table.tableName,
        METRICS_NAMESPACE: props.metricNamespace ?? `Kinmap/${config.envName}`,
        DRY_RUN: dryRun ? 'true' : 'false',
      },
    });

    table.grantReadWriteData(this.runner);

    // The runner orchestrates; it never touches user data itself. The grant is
    // therefore a name prefix over migration workers, not a wildcard over every
    // function in the account.
    this.runner.addToRolePolicy(
      new PolicyStatement({
        sid: 'InvokeMigrationWorkers',
        effect: Effect.ALLOW,
        actions: ['lambda:InvokeFunction'],
        resources: [
          this.formatArn({
            service: 'lambda',
            resource: 'function',
            resourceName: `${config.resourcePrefix}-migration-worker-*`,
            arnFormat: ArnFormat.COLON_RESOURCE_NAME,
          }),
        ],
      }),
    );

    // -----------------------------------------------------------------------
    // Schedule
    // -----------------------------------------------------------------------

    const scheduleDeadLetterQueue = new Queue(this, 'MigrationScheduleDlq', {
      queueName: `${config.resourcePrefix}-migration-schedule-dlq`,
      encryption: foundation === undefined ? QueueEncryption.KMS_MANAGED : QueueEncryption.KMS,
      encryptionMasterKey: foundation?.operationsKey,
      enforceSSL: true,
      retentionPeriod: Duration.days(14),
      removalPolicy: config.removalPolicy,
    });

    this.schedule = new Rule(this, 'MigrationSchedule', {
      ruleName: `${config.resourcePrefix}-migration-plan`,
      description: config.isProduction
        ? 'Disabled in production: migrations there are invoked manually behind the GitHub environment approval.'
        : 'Daily migration plan — reports pending migrations and publishes progress metrics.',
      enabled: !config.isProduction,
      schedule: Schedule.cron({ minute: '0', hour: '3' }),
      targets: [
        new LambdaTarget(this.runner, {
          event: RuleTargetInput.fromObject({ action: 'plan', dryRun: true }),
          retryAttempts: 2,
          maxEventAge: Duration.hours(2),
          deadLetterQueue: scheduleDeadLetterQueue,
        }),
      ],
    });

    // -----------------------------------------------------------------------
    // Alarm. A failing runner means migration state is unknown, which is worse
    // than a migration that has not started.
    // -----------------------------------------------------------------------

    const failureAlarm = new Alarm(this, 'MigrationRunnerErrorAlarm', {
      alarmName: `${config.resourcePrefix}-migration-runner-errors`,
      alarmDescription: 'The migration runner is failing; migration state is unverified.',
      metric: this.runner.metricErrors({ period: Duration.minutes(5), statistic: 'Sum' }),
      threshold: 0,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
    if (foundation !== undefined) {
      const alarmAction = new SnsAction(foundation.alarmTopic);
      failureAlarm.addAlarmAction(alarmAction);
      failureAlarm.addOkAction(alarmAction);
    }

    new CfnOutput(this, 'MigrationRunnerFunctionNameOutput', {
      value: this.runner.functionName,
      description:
        'Invoke with {"action":"plan"} to report; {"action":"apply","dryRun":false} to run migrations',
    });
    new CfnOutput(this, 'MigrationScheduleEnabledOutput', {
      value: config.isProduction ? 'false' : 'true',
      description: 'The migration schedule is disabled in production by design',
    });
    new CfnOutput(this, 'MigrationDryRunDefaultOutput', {
      value: dryRun ? 'true' : 'false',
      description: 'Default DRY_RUN for the runner; an apply must override it explicitly',
    });
  }
}
