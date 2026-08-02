import {
  AlarmRule,
  AlarmState,
  CompositeAlarm,
  type AlarmBase,
  type IAlarmRule,
} from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import type { IKey } from 'aws-cdk-lib/aws-kms';
import { Topic, type ITopic } from 'aws-cdk-lib/aws-sns';
import { EmailSubscription } from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';

import type { EnvironmentConfig } from '../config/types.js';

export interface AlarmSetProps {
  readonly config: EnvironmentConfig;
  /**
   * Existing topic to publish to. When omitted a topic is created and, if
   * {@link notificationEmail} resolves, subscribed to that address.
   */
  readonly topic?: ITopic;
  /** Suffix for a created topic, e.g. `alarms`. Ignored when {@link topic} is set. */
  readonly topicName?: string;
  /** Defaults to `config.alarmEmail`. Pass `null` to create no subscription. */
  readonly notificationEmail?: string | null;
  /** Customer-managed key for a created topic. */
  readonly encryptionKey?: IKey;
  /** Also send an OK notification when an alarm recovers. Defaults to true. */
  readonly notifyOnRecovery?: boolean;
}

/**
 * Groups alarms onto one SNS topic.
 *
 * Everything routed through here is operational: counts, durations, queue
 * depths, error rates. Nothing about an individual user — and certainly no
 * coordinate — is permitted in an alarm name, description or dimension, because
 * an SNS topic fans out to email and pagers that live well outside the
 * product's privacy boundary.
 */
export class AlarmSet extends Construct {
  readonly topic: ITopic;
  readonly action: SnsAction;

  private readonly registered: AlarmBase[] = [];
  private readonly notifyOnRecovery: boolean;

  constructor(scope: Construct, id: string, props: AlarmSetProps) {
    super(scope, id);

    const { config } = props;
    this.notifyOnRecovery = props.notifyOnRecovery ?? true;

    if (props.topic !== undefined) {
      this.topic = props.topic;
    } else {
      const suffix = props.topicName ?? 'alarms';
      const created = new Topic(this, 'Topic', {
        topicName: `${config.resourcePrefix}-${suffix}`,
        displayName: `Kinmap ${config.envName} ${suffix}`,
        masterKey: props.encryptionKey,
        enforceSSL: true,
      });

      const email =
        props.notificationEmail === undefined ? config.alarmEmail : props.notificationEmail;
      if (email !== null && email.length > 0) {
        created.addSubscription(new EmailSubscription(email));
      }

      this.topic = created;
    }

    this.action = new SnsAction(this.topic);
  }

  /**
   * Attaches this set's SNS action to each alarm. Undefined entries are skipped
   * so a caller can pass optional alarms without a filter at every call site.
   */
  add(...alarms: Array<AlarmBase | undefined>): this {
    for (const alarm of alarms) {
      if (alarm === undefined) {
        continue;
      }
      alarm.addAlarmAction(this.action);
      if (this.notifyOnRecovery) {
        alarm.addOkAction(this.action);
      }
      this.registered.push(alarm);
    }
    return this;
  }

  /** Array form of {@link add}, for spreading a construct's `alarms` property. */
  addAll(alarms: readonly AlarmBase[]): this {
    return this.add(...alarms);
  }

  /** Every alarm registered with this set, in registration order. */
  get alarms(): readonly AlarmBase[] {
    return this.registered;
  }

  /**
   * A single alarm that fires when any member of the set fires — useful as the
   * one thing an on-call rotation has to subscribe to.
   */
  compositeAlarm(id: string, description: string): CompositeAlarm {
    const first = this.registered.at(0);
    if (first === undefined) {
      throw new Error(
        `Cannot build composite alarm "${id}": no alarms have been added to this AlarmSet.`,
      );
    }

    const rules: IAlarmRule[] = this.registered.map((alarm) =>
      AlarmRule.fromAlarm(alarm, AlarmState.ALARM),
    );
    const combined = rules.length === 1 ? rules[0] : AlarmRule.anyOf(...rules);
    if (combined === undefined) {
      throw new Error(`Cannot build composite alarm "${id}": alarm rule list was empty.`);
    }

    const composite = new CompositeAlarm(this, id, {
      alarmRule: combined,
      alarmDescription: description,
    });
    composite.addAlarmAction(this.action);
    if (this.notifyOnRecovery) {
      composite.addOkAction(this.action);
    }
    return composite;
  }
}
