import { Duration, type RemovalPolicy } from 'aws-cdk-lib';
import {
  Alarm,
  ComparisonOperator,
  TreatMissingData,
  type IMetric,
} from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import {
  BillingMode,
  Operation,
  ProjectionType,
  Table,
  TableEncryption,
  type Attribute,
  type StreamViewType,
} from 'aws-cdk-lib/aws-dynamodb';
import type { IKey } from 'aws-cdk-lib/aws-kms';
import type { ITopic } from 'aws-cdk-lib/aws-sns';
import type { Construct } from 'constructs';

import { qualifiedName, type EnvironmentConfig } from '../config/types.js';

/** A global secondary index in the shape this application always uses. */
export interface GuardedTableIndex {
  readonly indexName: string;
  readonly partitionKey: Attribute;
  readonly sortKey?: Attribute;
  /** Defaults to ALL — these tables are small per-item and read-heavy. */
  readonly projectionType?: ProjectionType;
  /** Required when {@link projectionType} is INCLUDE. */
  readonly nonKeyAttributes?: string[];
}

export interface GuardedTableProps {
  readonly config: EnvironmentConfig;
  /** Logical table name, e.g. `CurrentLocations`. Prefixed with `kinmap-<env>-`. */
  readonly tableName: string;
  readonly partitionKey: Attribute;
  readonly sortKey?: Attribute;
  /** Customer-managed key. Required: AWS-owned keys are not acceptable here. */
  readonly encryptionKey: IKey;
  /** Attribute holding the epoch-seconds expiry used by DynamoDB TTL. */
  readonly timeToLiveAttribute?: string;
  /** Enables a stream when supplied. */
  readonly stream?: StreamViewType;
  readonly globalSecondaryIndexes?: GuardedTableIndex[];
  /** Alarms publish here when supplied; without it they are metric-only. */
  readonly alarmTopic?: ITopic;
  readonly removalPolicy?: RemovalPolicy;
  readonly deletionProtection?: boolean;
  readonly throttleAlarmThreshold?: number;
  readonly systemErrorAlarmThreshold?: number;
  readonly contributorInsightsEnabled?: boolean;
}

/**
 * A DynamoDB table with the guarantees this product depends on:
 *
 *  - on-demand billing, so a burst of location uploads cannot throttle a family
 *    out of the product while someone is trying to find a relative;
 *  - point-in-time recovery, so an operator error is recoverable within 35 days;
 *  - customer-managed KMS encryption — the key is ours, so revoking it revokes
 *    access to the data even from AWS-side operations;
 *  - deletion protection wherever the environment says the data is real;
 *  - throttle and system-error alarms, because a silently throttling table
 *    presents to a user as "my family member's location is stuck".
 */
/**
 * Operations the alarms watch.
 *
 * Defaulting to every operation builds a metric-math expression over all 13
 * DynamoDB operations, and CloudWatch rejects any expression referencing more
 * than 10 metrics. These eight are the calls this platform actually issues, so
 * the alarm stays inside the limit without losing coverage.
 */
const ALARMED_OPERATIONS: readonly Operation[] = [
  Operation.GET_ITEM,
  Operation.PUT_ITEM,
  Operation.UPDATE_ITEM,
  Operation.DELETE_ITEM,
  Operation.QUERY,
  Operation.SCAN,
  Operation.BATCH_WRITE_ITEM,
  Operation.TRANSACT_WRITE_ITEMS,
];

export class GuardedTable extends Table {
  /** Every alarm this construct created, for grouping onto an SNS topic. */
  readonly alarms: Alarm[];

  constructor(scope: Construct, id: string, props: GuardedTableProps) {
    const { config } = props;
    const removalPolicy = props.removalPolicy ?? config.removalPolicy;
    const physicalName = qualifiedName(config.resourcePrefix, props.tableName);

    super(scope, id, {
      tableName: physicalName,
      partitionKey: props.partitionKey,
      sortKey: props.sortKey,

      // On-demand: this workload is spiky by nature (commute peaks) and
      // provisioned capacity would trade user-visible failure for a few dollars.
      billingMode: BillingMode.PAY_PER_REQUEST,

      encryption: TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: props.encryptionKey,

      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },

      timeToLiveAttribute: props.timeToLiveAttribute,
      stream: props.stream,

      removalPolicy,
      deletionProtection: props.deletionProtection ?? config.deletionProtection,
      contributorInsightsEnabled: props.contributorInsightsEnabled,
    });

    for (const index of props.globalSecondaryIndexes ?? []) {
      this.addGlobalSecondaryIndex({
        indexName: index.indexName,
        partitionKey: index.partitionKey,
        sortKey: index.sortKey,
        projectionType: index.projectionType ?? ProjectionType.ALL,
        nonKeyAttributes: index.nonKeyAttributes,
      });
    }

    const period = Duration.minutes(5);

    const throttleAlarm = this.buildAlarm(
      'ThrottleAlarm',
      this.metricThrottledRequestsForOperations({ period, operations: [...ALARMED_OPERATIONS] }),
      props.throttleAlarmThreshold ?? config.alarmThresholds.tableThrottles,
      `${props.tableName} is throttling requests; reads or writes are being rejected.`,
      `${physicalName}-throttled`,
    );

    const systemErrorAlarm = this.buildAlarm(
      'SystemErrorAlarm',
      this.metricSystemErrorsForOperations({ period, operations: [...ALARMED_OPERATIONS] }),
      props.systemErrorAlarmThreshold ?? config.alarmThresholds.tableSystemErrors,
      `${props.tableName} is returning DynamoDB system errors.`,
      `${physicalName}-system-errors`,
    );

    this.alarms = [throttleAlarm, systemErrorAlarm];

    if (props.alarmTopic !== undefined) {
      const action = new SnsAction(props.alarmTopic);
      for (const alarm of this.alarms) {
        alarm.addAlarmAction(action);
        alarm.addOkAction(action);
      }
    }
  }

  private buildAlarm(
    id: string,
    metric: IMetric,
    threshold: number,
    alarmDescription: string,
    alarmName: string,
  ): Alarm {
    return new Alarm(this, id, {
      alarmName,
      alarmDescription,
      metric,
      threshold,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      // A table with no traffic emits nothing; that is healthy, not broken.
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
  }
}
