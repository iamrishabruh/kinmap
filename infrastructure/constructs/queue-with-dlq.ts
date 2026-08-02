import { Duration, type RemovalPolicy } from 'aws-cdk-lib';
import { Alarm, ComparisonOperator, TreatMissingData } from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import type { IKey } from 'aws-cdk-lib/aws-kms';
import type { ITopic } from 'aws-cdk-lib/aws-sns';
import { Queue, QueueEncryption } from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

import { qualifiedName, type EnvironmentConfig } from '../config/types.js';

export interface QueueWithDlqProps {
  readonly config: EnvironmentConfig;
  /**
   * Queue name. Prefixed with `kinmap-<env>-` unless it already starts with it,
   * so `'geofence-evaluation'` and `` `${config.resourcePrefix}-geofence-evaluation` ``
   * both produce the same physical name.
   */
  readonly queueName: string;
  /**
   * Must be at least the consumer's timeout, and AWS recommends six times it
   * for Lambda consumers so a retry never lands on an in-flight message.
   * Defaults to six times the environment's Lambda timeout.
   */
  readonly visibilityTimeout?: Duration;
  /** Receives before a message is parked on the DLQ. Defaults to 5. */
  readonly maxReceiveCount?: number;
  /** Defaults to four days. */
  readonly retentionPeriod?: Duration;
  /** Defaults to fourteen days — a parked message must survive a long weekend. */
  readonly deadLetterRetentionPeriod?: Duration;
  /** Customer-managed key. Falls back to the SQS-managed key when omitted. */
  readonly encryptionKey?: IKey;
  /** Alarms publish here when supplied. */
  readonly alarmTopic?: ITopic;
  readonly deliveryDelay?: Duration;
  readonly receiveMessageWaitTime?: Duration;
  readonly removalPolicy?: RemovalPolicy;
  /** Depth at which the DLQ alarm fires. Defaults to 0 — anything parked is a bug. */
  readonly deadLetterAlarmThreshold?: number;
}

/**
 * A work queue and its dead-letter queue, wired together with a redrive policy
 * and an alarm on the DLQ.
 *
 * The DLQ alarm threshold is zero on purpose. In this product a parked message
 * is a location event, a geofence evaluation or a notification that never
 * reached the person it was about — there is no volume of those that is
 * acceptable, so the alarm fires on the first one rather than on a rate.
 */
export class QueueWithDlq extends Construct {
  readonly queue: Queue;
  readonly deadLetterQueue: Queue;
  readonly deadLetterAlarm: Alarm;
  readonly alarms: Alarm[];

  constructor(scope: Construct, id: string, props: QueueWithDlqProps) {
    super(scope, id);

    const { config } = props;
    const baseName = qualifiedName(config.resourcePrefix, props.queueName);
    const encryption =
      props.encryptionKey !== undefined ? QueueEncryption.KMS : QueueEncryption.KMS_MANAGED;
    const visibilityTimeout =
      props.visibilityTimeout ?? Duration.seconds(config.lambdaTimeoutSeconds * 6);

    this.deadLetterQueue = new Queue(this, 'DeadLetterQueue', {
      queueName: `${baseName}-dlq`,
      encryption,
      encryptionMasterKey: props.encryptionKey,
      enforceSSL: true,
      retentionPeriod: props.deadLetterRetentionPeriod ?? Duration.days(14),
      visibilityTimeout,
      removalPolicy: props.removalPolicy ?? config.removalPolicy,
    });

    this.queue = new Queue(this, 'Queue', {
      queueName: baseName,
      encryption,
      encryptionMasterKey: props.encryptionKey,
      enforceSSL: true,
      retentionPeriod: props.retentionPeriod ?? Duration.days(4),
      visibilityTimeout,
      deliveryDelay: props.deliveryDelay,
      // Long polling: fewer empty receives, lower cost, lower latency.
      receiveMessageWaitTime: props.receiveMessageWaitTime ?? Duration.seconds(20),
      removalPolicy: props.removalPolicy ?? config.removalPolicy,
      deadLetterQueue: {
        queue: this.deadLetterQueue,
        maxReceiveCount: props.maxReceiveCount ?? 5,
      },
    });

    this.deadLetterAlarm = new Alarm(this, 'DeadLetterQueueDepthAlarm', {
      alarmName: `${baseName}-dlq-depth`,
      alarmDescription:
        `Messages are parked on the ${props.queueName} dead-letter queue. ` +
        'Each one is work that never reached the user it was for.',
      metric: this.deadLetterQueue.metricApproximateNumberOfMessagesVisible({
        period: Duration.minutes(5),
        statistic: 'Maximum',
      }),
      threshold: props.deadLetterAlarmThreshold ?? config.alarmThresholds.deadLetterQueueDepth,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });

    this.alarms = [this.deadLetterAlarm];

    if (props.alarmTopic !== undefined) {
      const action = new SnsAction(props.alarmTopic);
      this.deadLetterAlarm.addAlarmAction(action);
      this.deadLetterAlarm.addOkAction(action);
    }
  }

  /** Queue URL, for the `<NAME>_QUEUE_URL` environment variable. */
  get queueUrl(): string {
    return this.queue.queueUrl;
  }

  /** Dead-letter queue URL, for operator tooling and redrive scripts. */
  get deadLetterQueueUrl(): string {
    return this.deadLetterQueue.queueUrl;
  }
}
