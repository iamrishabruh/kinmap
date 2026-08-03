import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Duration, type RemovalPolicy } from 'aws-cdk-lib';
import { Alarm, ComparisonOperator, TreatMissingData } from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import type { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import {
  ApplicationLogLevel,
  Architecture,
  LoggingFormat,
  Runtime,
  SystemLogLevel,
  Tracing,
  type ILayerVersion,
  type CfnFunction,
} from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, type RetentionDays } from 'aws-cdk-lib/aws-logs';
import type { ITopic } from 'aws-cdk-lib/aws-sns';
import type { IQueue } from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

import { qualifiedName, type EnvironmentConfig } from '../config/types.js';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));

/** Repository root: `infrastructure/constructs` -> `infrastructure` -> repo. */
export const REPOSITORY_ROOT = path.resolve(moduleDirectory, '..', '..');

/**
 * The single place that knows where a service's Lambda entry point lives.
 * Every service exposes `services/<name>/src/handler.ts` with a named export
 * `handler`; nothing else is a valid entry point.
 */
export function serviceEntry(serviceName: string): string {
  return path.join(REPOSITORY_ROOT, 'services', serviceName, 'src', 'handler.ts');
}

/**
 * ESM output needs the CommonJS globals some transitive dependencies still
 * reach for. Without this banner an `esbuild`-bundled ESM Lambda fails at cold
 * start with "require is not defined".
 */
const ESM_COMPATIBILITY_BANNER = [
  "import{createRequire as __kinmapCreateRequire}from'node:module';",
  "import{fileURLToPath as __kinmapFileURLToPath}from'node:url';",
  "import{dirname as __kinmapDirname}from'node:path';",
  'const require=__kinmapCreateRequire(import.meta.url);',
  'const __filename=__kinmapFileURLToPath(import.meta.url);',
  'const __dirname=__kinmapDirname(__filename);',
].join('');

export interface NodeServiceProps {
  readonly config: EnvironmentConfig;
  /**
   * Directory name under `services/`, e.g. `location-ingest`. Also the suffix
   * of the physical function name and of the log group.
   */
  readonly serviceName: string;
  /**
   * Overrides the derived `services/<serviceName>/src/handler.ts` path. Use it
   * when one service directory exports several Lambda entry points.
   */
  readonly entry?: string;
  /** Exported symbol in the entry module. Always `handler` by convention. */
  readonly handler?: string;
  readonly description?: string;
  readonly environment?: Record<string, string>;
  readonly memorySize?: number;
  readonly timeout?: Duration;
  /**
   * Reserved concurrency. Honoured only in production.
   *
   * Reserving concurrency carves capacity out of the account's pool, and a new
   * AWS account starts with a total limit of 10 rather than 1000 — with a hard
   * requirement that 10 stay unreserved. Any reservation in such an account
   * therefore fails outright with "decreases account's UnreservedConcurrentExecution
   * below its minimum value". The setting exists for production blast-radius and
   * cost control, which a development account does not need, so it is ignored
   * outside production rather than blocking the whole environment from deploying.
   */
  readonly reservedConcurrentExecutions?: number;
  readonly logRetention?: RetentionDays;
  readonly alarmTopic?: ITopic;
  readonly initialPolicy?: PolicyStatement[];
  readonly layers?: ILayerVersion[];
  /** Async invocation failures land here. */
  readonly deadLetterQueue?: IQueue;
  readonly removalPolicy?: RemovalPolicy;
  readonly errorAlarmThreshold?: number;
  readonly throttleAlarmThreshold?: number;
  /**
   * Modules esbuild should leave unbundled. Empty by default: the AWS SDK is
   * pinned in this repository, and bundling it means the version that was
   * tested is the version that runs, rather than whatever the runtime ships.
   */
  readonly externalModules?: string[];
  /** Extra esbuild `define` entries, e.g. build stamps. */
  readonly bundlingDefine?: Record<string, string>;
}

/**
 * A Lambda function with the standards this platform applies to every service:
 * Node 22 on ARM64, ESM bundles produced by esbuild, active X-Ray tracing,
 * structured JSON logging into an explicitly-managed log group with a real
 * retention policy, and error and throttle alarms.
 *
 * Privacy note: nothing here ever puts a coordinate into an environment
 * variable, a log line, an alarm name or an alarm description. Function-level
 * telemetry is limited to counts and durations, which is why alarms can be
 * routed to a shared operational topic without leaking anything about a user.
 */
export class NodeService extends Construct {
  readonly function: NodejsFunction;
  readonly logGroup: LogGroup;
  readonly errorAlarm: Alarm;
  readonly throttleAlarm: Alarm;
  readonly alarms: Alarm[];

  constructor(scope: Construct, id: string, props: NodeServiceProps) {
    super(scope, id);

    const { config } = props;
    const functionName = qualifiedName(config.resourcePrefix, props.serviceName);

    // Which service's code this function actually runs. Usually the same as
    // `serviceName`, but not always: the three billing webhooks all run
    // services/subscription-worker. Recorded on the resource because the
    // environment a function needs is decided by its BUNDLE, not its name, and
    // without this the template gives no way to check one against the other.
    const bundle = path.basename(
      path.dirname(path.dirname(props.entry ?? serviceEntry(props.serviceName))),
    );
    const removalPolicy = props.removalPolicy ?? config.removalPolicy;

    this.logGroup = new LogGroup(this, 'LogGroup', {
      logGroupName: `/aws/lambda/${functionName}`,
      retention: props.logRetention ?? config.logRetention,
      removalPolicy,
    });

    this.function = new NodejsFunction(this, 'Function', {
      functionName,
      description:
        props.description ?? `${props.serviceName} (${config.envName}) — Kinmap backend service`,
      entry: props.entry ?? serviceEntry(props.serviceName),
      handler: props.handler ?? 'handler',

      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,

      memorySize: props.memorySize ?? config.lambdaMemoryMb,
      timeout: props.timeout ?? Duration.seconds(config.lambdaTimeoutSeconds),
      reservedConcurrentExecutions: config.isProduction
        ? props.reservedConcurrentExecutions
        : undefined,

      tracing: Tracing.ACTIVE,
      logGroup: this.logGroup,
      loggingFormat: LoggingFormat.JSON,
      applicationLogLevelV2: config.isProduction
        ? ApplicationLogLevel.INFO
        : ApplicationLogLevel.DEBUG,
      systemLogLevelV2: SystemLogLevel.WARN,

      environment: {
        APP_ENV: config.envName,
        SERVICE_NAME: props.serviceName,
        LOG_LEVEL: config.isProduction ? 'info' : 'debug',
        // Source maps are emitted by the bundler below; without this the stack
        // traces in CloudWatch point at minified offsets.
        NODE_OPTIONS: '--enable-source-maps',
        DETAILED_TRACING: config.enableDetailedTracing ? '1' : '0',
        ...props.environment,
      },

      initialPolicy: props.initialPolicy,
      layers: props.layers,
      deadLetterQueue: props.deadLetterQueue,

      projectRoot: REPOSITORY_ROOT,
      depsLockFilePath: path.join(REPOSITORY_ROOT, 'pnpm-lock.yaml'),

      bundling: {
        format: OutputFormat.ESM,
        target: 'node22',
        mainFields: ['module', 'main'],
        banner: ESM_COMPATIBILITY_BANNER,
        minify: config.isProduction,
        sourceMap: true,
        sourcesContent: false,
        externalModules: props.externalModules ?? [],
        define: props.bundlingDefine,
      },
    });

    (this.function.node.defaultChild as CfnFunction).addMetadata('kinmap:bundle', bundle);

    this.errorAlarm = new Alarm(this, 'ErrorAlarm', {
      alarmName: `${functionName}-errors`,
      alarmDescription: `${props.serviceName} is returning errors.`,
      metric: this.function.metricErrors({
        period: Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: props.errorAlarmThreshold ?? config.alarmThresholds.lambdaErrors,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });

    this.throttleAlarm = new Alarm(this, 'ThrottleAlarm', {
      alarmName: `${functionName}-throttles`,
      alarmDescription:
        `${props.serviceName} is being throttled; requests are failing before ` +
        'the handler runs.',
      metric: this.function.metricThrottles({
        period: Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: props.throttleAlarmThreshold ?? config.alarmThresholds.lambdaThrottles,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });

    this.alarms = [this.errorAlarm, this.throttleAlarm];

    if (props.alarmTopic !== undefined) {
      const action = new SnsAction(props.alarmTopic);
      for (const alarm of this.alarms) {
        alarm.addAlarmAction(action);
        alarm.addOkAction(action);
      }
    }
  }

  /** Alias for {@link function}; `fn` reads better at a grant call site. */
  get fn(): NodejsFunction {
    return this.function;
  }

  /** Alias for {@link function}. */
  get lambda(): NodejsFunction {
    return this.function;
  }

  /** Adds one environment variable after construction. */
  addEnvironment(key: string, value: string): this {
    this.function.addEnvironment(key, value);
    return this;
  }
}
