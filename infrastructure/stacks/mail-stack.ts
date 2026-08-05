/**
 * Mail stack — inbound mail for support@, privacy@ and security@.
 *
 * App Review sends mail to the support address listed on the App Store product
 * page and expects a human to answer it, so this is a store-submission blocker
 * rather than a convenience. The path is: SES receives, an S3 action spools the
 * raw message, a Lambda action rewrites it for forwarding, and SES sends one
 * copy to a personal inbox.
 *
 * ---------------------------------------------------------------------------
 * Region: the one detail that breaks this if it is ignored
 * ---------------------------------------------------------------------------
 * SES can *send* from every commercial region but can only *receive* in a
 * subset of them (see {@link SES_INBOUND_REGIONS}). A receipt rule set, the
 * bucket its S3 action writes to, and the function its Lambda action invokes
 * must all be in that same receiving region — SES will not write across a
 * region boundary, and the MX record has to point at that region's
 * `inbound-smtp` endpoint.
 *
 * So this stack pins itself to {@link MailStackProps.sesRegion} (default
 * `us-east-1`) regardless of the region the rest of the application deploys
 * into: `env.region` is overridden in the `super` call below. Everything that
 * has to be co-located with the receipt rule is created here; the only things
 * shared with the primary region are DNS records, and Route53 is global.
 *
 * ---------------------------------------------------------------------------
 * Two manual, one-time steps after the first deploy
 * ---------------------------------------------------------------------------
 *  1. A receipt rule set is not active just because it exists, and there is no
 *     CloudFormation property for activation — exactly one rule set per region
 *     is active at a time and that is an account-level API call. The exact
 *     command is emitted as a stack output.
 *  2. SES starts in the sandbox, where sending to an *unverified* address is
 *     refused. Until production access is granted, forwarding to a personal
 *     mailbox fails silently from the sender's point of view. Verify the
 *     destination address (or request production access) before relying on it.
 *
 * No context lookup happens here: the hosted zone is passed in or imported from
 * attributes, never `HostedZone.fromLookup`, so `cdk synth` still runs on a
 * fork pull request with no credentials.
 */
import { Annotations, CfnOutput, Duration, Stack } from 'aws-cdk-lib';
import { Alarm, ComparisonOperator, TreatMissingData } from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import { Effect, PolicyStatement, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Key } from 'aws-cdk-lib/aws-kms';
import { type IFunction } from 'aws-cdk-lib/aws-lambda';
import {
  CfnRecordSet,
  HostedZone,
  MxRecord,
  TxtRecord,
  type IHostedZone,
} from 'aws-cdk-lib/aws-route53';
import {
  CfnConfigurationSetEventDestination,
  ConfigurationSet,
  DkimIdentity,
  EasyDkimSigningKeyLength,
  EmailIdentity,
  Identity,
  MailFromBehaviorOnMxFailure,
  ReceiptRuleSet,
  SuppressionReasons,
  TlsPolicy,
  type ReceiptRule,
} from 'aws-cdk-lib/aws-ses';
import {
  Lambda as LambdaReceiptAction,
  LambdaInvocationType,
  S3 as S3ReceiptAction,
} from 'aws-cdk-lib/aws-ses-actions';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { Queue, QueueEncryption } from 'aws-cdk-lib/aws-sqs';
import { type Construct } from 'constructs';

import { applyStandardTags } from '../config/index.js';
import { type FoundationConsumerStackProps } from '../config/types.js';
import { NodeService } from '../constructs/node-service.js';
import { SecureBucket } from '../constructs/secure-bucket.js';

/**
 * Regions in which SES can receive mail. Kept as a guard rather than a hard
 * constraint: AWS adds to this list, and a warning that names the problem is
 * more useful than a synth failure on a region that became valid last month.
 */
export const SES_INBOUND_REGIONS: readonly string[] = [
  'us-east-1',
  'us-east-2',
  'us-west-2',
  'ap-northeast-1',
  'ap-southeast-1',
  'ap-southeast-2',
  'ca-central-1',
  'eu-central-1',
  'eu-north-1',
  'eu-west-1',
  'eu-west-2',
  'il-central-1',
  'sa-east-1',
];

/** SES receiving region used unless a caller names another. */
export const DEFAULT_SES_REGION = 'us-east-1';

/** Local parts forwarded to a person. Every one of these is published somewhere. */
export const DEFAULT_FORWARDED_MAILBOXES: readonly string[] = [
  'support',
  'privacy',
  'security',
  // Where CloudWatch alarms are sent. It has to be a real, deliverable mailbox:
  // an SNS email subscription stays PendingConfirmation forever if the
  // confirmation cannot arrive, and an alarm topic nobody confirmed is an alarm
  // nobody receives.
  'alerts',
];

/** Local part every forwarded copy is sent *from*. Never one we also receive. */
const DEFAULT_FROM_LOCAL_PART = 'no-reply';

/** Key prefix the S3 receipt action writes under; the forwarder reads only this. */
const MAIL_OBJECT_PREFIX = 'inbound/';

/** This is a forwarder, not an archive. */
const DEFAULT_RETENTION_DAYS = 30;

/**
 * SES accepts up to 40 MB, but most consumer mailboxes reject well below that
 * and a bounce at the destination looks exactly like mail we never received.
 * Above this the forwarder sends a notice instead of the message.
 */
const DEFAULT_MAX_FORWARD_BYTES = 20 * 1024 * 1024;

/** Reading and re-sending a 20 MB message is not a 15-second job. */
const FORWARDER_TIMEOUT = Duration.seconds(60);
const FORWARDER_MEMORY_MB = 1_024;

/**
 * A public inbox is an open door. Capping concurrency means a flood costs a
 * bounded amount and cannot starve the rest of the account of Lambda capacity.
 */
const FORWARDER_RESERVED_CONCURRENCY = 5;

/** DNS time-to-live for the mail records; short enough to fix a mistake quickly. */
const RECORD_TTL = Duration.minutes(30);
const DKIM_RECORD_TTL_SECONDS = '1800';

export interface MailStackProps extends FoundationConsumerStackProps {
  /**
   * Zone hosting {@link EnvironmentConfig.domain}. Defaults to importing
   * `config.hostedZoneId` by attributes. Never looked up.
   */
  readonly hostedZone?: IHostedZone;
  /** Overrides `config.hostedZoneId` when no zone object is supplied. */
  readonly hostedZoneId?: string;
  /**
   * Region the receipt rule set, the spool bucket and the forwarder are created
   * in. Defaults to {@link DEFAULT_SES_REGION}. This overrides the region in
   * `env` — see the region note at the top of this file.
   */
  readonly sesRegion?: string;
  /** Local parts to forward. Defaults to {@link DEFAULT_FORWARDED_MAILBOXES}. */
  readonly forwardedMailboxes?: readonly string[];
  /**
   * Personal inboxes every forwarded copy is delivered to. Required: a
   * forwarder with nowhere to forward to is a black hole, and a support address
   * that silently swallows mail fails App Review.
   */
  readonly forwardTo: readonly string[];
  /**
   * Verified address the forwarded copy is sent from. Defaults to
   * `no-reply@<domain>`. Must not be an address this stack also receives.
   */
  readonly fromAddress?: string;
  /** Defaults to `v=spf1 include:amazonses.com -all`. */
  readonly spfRecordValue?: string;
  /** Set false to leave DMARC to an existing record. */
  readonly createDmarcRecord?: boolean;
  /** Defaults to `v=DMARC1; p=none;`. */
  readonly dmarcRecordValue?: string;
  /**
   * Subdomain used as the custom MAIL FROM domain, e.g. `mail` for
   * `mail.kinmap.app`. Set to an empty string to keep SES's default.
   */
  readonly mailFromSubdomain?: string;
  /** Days a raw message is kept in the spool bucket. Defaults to 30. */
  readonly retentionDays?: number;
  /** Defaults to {@link DEFAULT_MAX_FORWARD_BYTES}. */
  readonly maxForwardBytes?: number;
}

/** Resolved before `super`, so it cannot read `this`. */
function resolveSesRegion(props: MailStackProps): string {
  const candidate = (props.sesRegion ?? DEFAULT_SES_REGION).trim();
  return candidate.length > 0 ? candidate : DEFAULT_SES_REGION;
}

export class MailStack extends Stack {
  /** Region the receipt rule set actually lives in. */
  public readonly sesRegion: string;
  /** Domain identity with Easy DKIM; also the identity we are allowed to send as. */
  public readonly emailIdentity: EmailIdentity;
  /** Holds the forwarding rule. Must be activated once, out of band. */
  public readonly ruleSet: ReceiptRuleSet;
  public readonly receiptRule: ReceiptRule;
  /** Raw inbound messages, expired by a lifecycle rule. */
  public readonly mailBucket: SecureBucket;
  public readonly forwarderFunction: IFunction;
  public readonly forwarderDeadLetterQueue: Queue;
  /** Fully-qualified addresses this stack forwards, e.g. `support@kinmap.app`. */
  public readonly forwardedAddresses: readonly string[];

  public constructor(scope: Construct, id: string, props: MailStackProps) {
    super(scope, id, {
      ...props,
      // Deliberately overrides whatever `env` the caller passed: a receipt rule
      // only works in a region where SES can receive, and the bucket and the
      // function it drives must sit beside it.
      env: { account: props.config.account, region: resolveSesRegion(props) },
      terminationProtection: props.terminationProtection ?? props.config.isProduction,
      description:
        props.description ??
        'Kinmap inbound mail: SES receiving for support@, privacy@ and security@, forwarded to a person.',
    });

    const { config, foundation } = props;

    applyStandardTags(this, config);

    const sesRegion = resolveSesRegion(props);
    this.sesRegion = sesRegion;

    // Foundation resources live in the primary region. An SNS alarm action and
    // an S3 server-access-log target are both same-region-only, so they are
    // wired up only when this stack happens to share that region.
    const sharesPrimaryRegion = sesRegion === config.region;

    const retentionDays = props.retentionDays ?? DEFAULT_RETENTION_DAYS;
    const maxForwardBytes = props.maxForwardBytes ?? DEFAULT_MAX_FORWARD_BYTES;

    const mailboxes =
      props.forwardedMailboxes !== undefined && props.forwardedMailboxes.length > 0
        ? props.forwardedMailboxes
        : DEFAULT_FORWARDED_MAILBOXES;

    this.forwardedAddresses = mailboxes.map((mailbox) =>
      `${mailbox}@${config.domain}`.toLowerCase(),
    );

    const fromAddress = (
      props.fromAddress ?? `${DEFAULT_FROM_LOCAL_PART}@${config.domain}`
    ).toLowerCase();

    const forwardTo = props.forwardTo.map((address) => address.trim()).filter((a) => a.length > 0);

    this.validateConfiguration({ sesRegion, config, fromAddress, forwardTo });

    // -----------------------------------------------------------------------
    // DNS. Imported by attributes so synth needs no credentials.
    // -----------------------------------------------------------------------

    const zone: IHostedZone =
      props.hostedZone ??
      HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
        hostedZoneId: props.hostedZoneId ?? config.hostedZoneId,
        zoneName: config.domain,
      });

    // -----------------------------------------------------------------------
    // Domain identity
    //
    // A custom MAIL FROM subdomain is configured so that the envelope sender is
    // `<domain>` rather than `amazonses.com`, which gives DMARC an aligned SPF
    // result as well as an aligned DKIM one. The failure behaviour is
    // deliberately USE_DEFAULT_VALUE: if the MAIL FROM MX record is ever wrong,
    // SES falls back to amazonses.com and mail still goes out, instead of
    // rejecting every send.
    // -----------------------------------------------------------------------

    const mailFromSubdomain = props.mailFromSubdomain ?? 'mail';
    const mailFromDomain =
      mailFromSubdomain.length > 0 ? `${mailFromSubdomain}.${config.domain}` : undefined;

    // -----------------------------------------------------------------------
    // Bounces and complaints
    // -----------------------------------------------------------------------
    //
    // Account-level suppression already stops SES sending to an address that
    // hard-bounced or complained. What it does not do is tell anybody it
    // happened, so a domain's reputation can decay silently until sending is
    // paused — and by then the invitations that mattered have already failed.
    //
    // This configuration set publishes those events to their own SNS topic.
    // BOUNCE and COMPLAINT are the reputation-affecting ones; REJECT and
    // RENDERING_FAILURE mean the platform tried to send something malformed,
    // which is a bug rather than a recipient problem; DELIVERY_DELAY is the
    // early warning that usually precedes the other two.
    //
    // Attached as the identity's DEFAULT configuration set, so a caller cannot
    // send without it by forgetting to name it.
    // A key this stack owns, rather than the platform's operations key.
    //
    // SES publishes to the topic as a service principal, so it needs kms
    // permissions on whatever encrypts it:
    //
    //   MailEventDestination CREATE_FAILED — Access denied to KMS key for SNS topic
    //
    // The operations key is declared in the foundation stack, and granting SES
    // on it from here would mean this stack editing a policy the foundation
    // owns — the circular dependency the foundation exists to avoid. The
    // AWS-managed `alias/aws/sns` key fails the same way, because an
    // AWS-managed key's policy cannot be extended to another service.
    //
    // So the topic gets its own key with a policy that names SES. The events
    // carry recipient addresses and bounce reasons — never a coordinate — so
    // this key protects a genuinely different class of data from the one the
    // foundation's operations key does.
    const deliveryEventsKey = new Key(this, 'MailDeliveryEventsKey', {
      alias: `alias/${config.resourcePrefix}-mail-events`,
      description: 'Encrypts SES bounce and complaint notifications at rest',
      enableKeyRotation: true,
      removalPolicy: config.removalPolicy,
    });
    deliveryEventsKey.addToResourcePolicy(
      new PolicyStatement({
        sid: 'AllowSesToPublishDeliveryEvents',
        effect: Effect.ALLOW,
        principals: [new ServicePrincipal('ses.amazonaws.com')],
        actions: ['kms:GenerateDataKey*', 'kms:Decrypt'],
        resources: ['*'],
        conditions: { StringEquals: { 'aws:SourceAccount': Stack.of(this).account } },
      }),
    );

    const deliveryEvents = new Topic(this, 'MailDeliveryEvents', {
      topicName: `${config.resourcePrefix}-mail-events`,
      displayName: `Kinmap ${config.envName} mail delivery events`,
      masterKey: deliveryEventsKey,
    });
    deliveryEvents.grantPublish(new ServicePrincipal('ses.amazonaws.com'));

    const configurationSet = new ConfigurationSet(this, 'MailConfigurationSet', {
      configurationSetName: config.resourcePrefix,
      reputationMetrics: true,
      suppressionReasons: SuppressionReasons.BOUNCES_AND_COMPLAINTS,
    });

    const eventDestination = new CfnConfigurationSetEventDestination(this, 'MailEventDestination', {
      configurationSetName: configurationSet.configurationSetName,
      eventDestination: {
        name: 'sns',
        enabled: true,
        matchingEventTypes: [
          'BOUNCE',
          'COMPLAINT',
          'REJECT',
          'RENDERING_FAILURE',
          'DELIVERY_DELAY',
        ],
        snsDestination: { topicArn: deliveryEvents.topicArn },
      },
    });
    eventDestination.node.addDependency(configurationSet);

    this.emailIdentity = new EmailIdentity(this, 'DomainIdentity', {
      identity: Identity.domain(config.domain),
      dkimSigning: true,
      dkimIdentity: DkimIdentity.easyDkim(EasyDkimSigningKeyLength.RSA_2048_BIT),
      feedbackForwarding: true,
      mailFromDomain,
      mailFromBehaviorOnMxFailure: MailFromBehaviorOnMxFailure.USE_DEFAULT_VALUE,
      configurationSet,
    });
    this.emailIdentity.node.addDependency(eventDestination);

    // Easy DKIM publishes three CNAMEs. The token attributes are already
    // fully-qualified record names, so `CfnRecordSet` is used directly rather
    // than `CnameRecord`, which would try to append the zone name to a token.
    const dkimTokens: ReadonlyArray<{ readonly name: string; readonly value: string }> = [
      { name: this.emailIdentity.dkimDnsTokenName1, value: this.emailIdentity.dkimDnsTokenValue1 },
      { name: this.emailIdentity.dkimDnsTokenName2, value: this.emailIdentity.dkimDnsTokenValue2 },
      { name: this.emailIdentity.dkimDnsTokenName3, value: this.emailIdentity.dkimDnsTokenValue3 },
    ];

    for (const [index, token] of dkimTokens.entries()) {
      new CfnRecordSet(this, `DkimRecord${index + 1}`, {
        hostedZoneId: zone.hostedZoneId,
        name: token.name,
        type: 'CNAME',
        resourceRecords: [token.value],
        ttl: DKIM_RECORD_TTL_SECONDS,
      });
    }

    // Inbound mail. This is the record that decides whether support@ works at
    // all, and it is region-specific.
    new MxRecord(this, 'InboundMxRecord', {
      zone,
      recordName: config.domain,
      values: [{ priority: 10, hostName: `inbound-smtp.${sesRegion}.amazonaws.com` }],
      ttl: RECORD_TTL,
      comment: `Kinmap ${config.envName} inbound mail (SES receiving, ${sesRegion})`,
    });

    // SES is the only thing that ever sends as this domain, so the policy can
    // be strict. Loosen to `~all` before adding a second sender.
    new TxtRecord(this, 'SpfRecord', {
      zone,
      recordName: config.domain,
      values: [props.spfRecordValue ?? 'v=spf1 include:amazonses.com -all'],
      ttl: RECORD_TTL,
      comment: `Kinmap ${config.envName} SPF`,
    });

    if (mailFromDomain !== undefined) {
      // Bounce and complaint reports come back to the MAIL FROM domain, so it
      // needs its own MX, and its own SPF record for the envelope sender.
      new MxRecord(this, 'MailFromMxRecord', {
        zone,
        recordName: mailFromDomain,
        values: [{ priority: 10, hostName: `feedback-smtp.${sesRegion}.amazonses.com` }],
        ttl: RECORD_TTL,
        comment: `Kinmap ${config.envName} SES custom MAIL FROM`,
      });
      new TxtRecord(this, 'MailFromSpfRecord', {
        zone,
        recordName: mailFromDomain,
        values: ['v=spf1 include:amazonses.com ~all'],
        ttl: RECORD_TTL,
        comment: `Kinmap ${config.envName} SES custom MAIL FROM SPF`,
      });
    }

    if (props.createDmarcRecord ?? true) {
      // `p=none` monitors without ever discarding legitimate mail. Tighten to
      // quarantine or reject once the aggregate reports are clean.
      new TxtRecord(this, 'DmarcRecord', {
        zone,
        recordName: `_dmarc.${config.domain}`,
        values: [props.dmarcRecordValue ?? 'v=DMARC1; p=none;'],
        ttl: RECORD_TTL,
        comment: `Kinmap ${config.envName} DMARC`,
      });
    }

    // -----------------------------------------------------------------------
    // Spool bucket
    //
    // No customer-managed key on purpose. Handing a KMS key to the SES S3
    // action does NOT mean SSE-KMS: SES encrypts the message *client-side* with
    // the AWS Encryption SDK before the PUT, and the reader then needs that SDK
    // and an envelope-decrypt step rather than a plain GetObject. Bucket-level
    // SSE-S3 gives encryption at rest with none of that, and this bucket holds
    // support mail for at most 30 days — never a coordinate, never a token.
    // -----------------------------------------------------------------------

    this.mailBucket = new SecureBucket(this, 'MailBucket', {
      config,
      // Spool space, not a system of record: an overwrite is not a thing that
      // happens (keys are SES message ids) and a version history of other
      // people's mail is a liability, not a safety net.
      versioned: false,
      expirationDays: retentionDays,
      serverAccessLogsBucket: sharesPrimaryRegion ? foundation.accessLogBucket : undefined,
      serverAccessLogsPrefix: 'mail/',
    });

    // -----------------------------------------------------------------------
    // Forwarder
    // -----------------------------------------------------------------------

    this.forwarderDeadLetterQueue = new Queue(this, 'ForwarderDeadLetterQueue', {
      queueName: `${config.resourcePrefix}-mail-forwarder-dlq`,
      encryption: QueueEncryption.KMS_MANAGED,
      enforceSSL: true,
      retentionPeriod: Duration.days(14),
      removalPolicy: config.removalPolicy,
    });

    const forwarder = new NodeService(this, 'Forwarder', {
      config,
      serviceName: 'mail-forwarder',
      description: `mail-forwarder (${config.envName}) — forwards ${this.forwardedAddresses.join(', ')}`,
      memorySize: FORWARDER_MEMORY_MB,
      timeout: FORWARDER_TIMEOUT,
      reservedConcurrentExecutions: FORWARDER_RESERVED_CONCURRENCY,
      alarmTopic: sharesPrimaryRegion ? foundation.alarmTopic : undefined,
      deadLetterQueue: this.forwarderDeadLetterQueue,
      environment: {
        MAIL_BUCKET: this.mailBucket.bucketName,
        MAIL_OBJECT_PREFIX,
        MAIL_FORWARDED_ADDRESSES: this.forwardedAddresses.join(','),
        MAIL_FORWARD_FROM: fromAddress,
        MAIL_FORWARD_TO: forwardTo.join(','),
        MAIL_MAX_FORWARD_BYTES: String(maxForwardBytes),
      },
    });
    this.forwarderFunction = forwarder.fn;

    // Least privilege, spelled out rather than delegated to `grantRead`, which
    // would also hand over ListBucket and every other s3:Get*. The forwarder
    // reads one object per invocation, always under one prefix.
    forwarder.fn.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['s3:GetObject'],
        resources: [this.mailBucket.arnForObjects(`${MAIL_OBJECT_PREFIX}*`)],
      }),
    );

    // Send only, raw only, as one address only. `grantSendEmail` would also add
    // `ses:SendEmail`, which is a second way to send that nothing here needs.
    //
    // The resource is `*` and the restriction lives entirely in the condition,
    // because SES does not authorise this call against the sending identity
    // alone. While the account is in the sandbox it also evaluates the
    // *recipient* as an identity, so scoping the resource to our own domain
    // produced:
    //
    //   not authorized to perform `ses:SendRawEmail' on resource
    //   `arn:aws:ses:...:identity/<forwarding destination>'
    //
    // — - after SES had accepted the mail, stored it, and invoked this
    // function. Nothing failed until the last call, and the only visible
    // symptom was mail that never arrived.
    //
    // `ses:FromAddress` is the control that actually matters and it is
    // unchanged: this function can only ever send as one address, whatever the
    // resource says.
    forwarder.fn.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['ses:SendRawEmail'],
        resources: ['*'],
        conditions: { StringEquals: { 'ses:FromAddress': fromAddress } },
      }),
    );

    const deadLetterAlarm = new Alarm(this, 'ForwarderDeadLetterQueueDepthAlarm', {
      alarmName: `${config.resourcePrefix}-mail-forwarder-dlq-depth`,
      alarmDescription:
        'Inbound mail could not be forwarded. Each parked message is somebody who ' +
        'wrote to support, privacy or security and got no answer.',
      metric: this.forwarderDeadLetterQueue.metricApproximateNumberOfMessagesVisible({
        period: Duration.minutes(5),
        statistic: 'Maximum',
      }),
      threshold: config.alarmThresholds.deadLetterQueueDepth,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });

    if (sharesPrimaryRegion) {
      const action = new SnsAction(foundation.alarmTopic);
      deadLetterAlarm.addAlarmAction(action);
      deadLetterAlarm.addOkAction(action);
    }

    // -----------------------------------------------------------------------
    // Receipt rule set
    // -----------------------------------------------------------------------

    this.ruleSet = new ReceiptRuleSet(this, 'ReceiptRuleSet', {
      receiptRuleSetName: `${config.resourcePrefix}-inbound`,
      // `dropSpam` is not used: it adds a CDK-managed inline Lambda that this
      // repository's logging and retention standards do not cover. The
      // forwarder drops on the same verdicts, in code that is unit-tested.
    });

    this.receiptRule = this.ruleSet.addRule('ForwardedMailboxes', {
      receiptRuleName: `${config.resourcePrefix}-forwarded-mailboxes`,
      // Only these exact addresses. Matching the whole domain would turn every
      // typo and every harvested address into stored mail.
      recipients: [...this.forwardedAddresses],
      enabled: true,
      // Populates the spam and virus verdicts the forwarder refuses to forward
      // without. Without this they arrive as absent, not as PASS.
      scanEnabled: true,
      // OPTIONAL, not REQUIRE. REQUIRE bounces any sender that does not offer
      // STARTTLS, and losing a genuine support request to a badly configured
      // ISP is a worse outcome than accepting one unencrypted hop for mail that
      // is, by definition, addressed to a public inbox.
      tlsPolicy: TlsPolicy.OPTIONAL,
      actions: [
        // Order matters: the message must be in S3 before the function that
        // reads it is invoked. SES runs actions in sequence.
        new S3ReceiptAction({ bucket: this.mailBucket, objectKeyPrefix: MAIL_OBJECT_PREFIX }),
        new LambdaReceiptAction({
          function: forwarder.fn,
          // Asynchronous: nothing about the SMTP transaction depends on the
          // forward succeeding, and a failed invocation retries into the DLQ.
          invocationType: LambdaInvocationType.EVENT,
        }),
      ],
    });

    // -----------------------------------------------------------------------
    // Outputs — the manual steps CloudFormation cannot perform
    // -----------------------------------------------------------------------

    new CfnOutput(this, 'SesRegionOutput', {
      value: sesRegion,
      description: 'Region the receipt rule set, spool bucket and forwarder live in',
    });
    new CfnOutput(this, 'ActivateReceiptRuleSetCommandOutput', {
      value: `aws ses set-active-receipt-rule-set --rule-set-name ${this.ruleSet.receiptRuleSetName} --region ${sesRegion}`,
      description:
        'Run once after the first deploy. A receipt rule set is inert until it is the ' +
        'active one, and CloudFormation cannot activate it.',
    });
    new CfnOutput(this, 'ForwardedAddressesOutput', {
      value: this.forwardedAddresses.join(', '),
      description: 'Addresses accepted by the receipt rule',
    });
    new CfnOutput(this, 'MailBucketNameOutput', {
      value: this.mailBucket.bucketName,
      description: `Raw inbound mail, expired after ${retentionDays} days`,
    });
    new CfnOutput(this, 'SesProductionAccessReminderOutput', {
      value: `aws sesv2 get-account --region ${sesRegion}`,
      description:
        'Check ProductionAccessEnabled. In the SES sandbox, sending to an unverified ' +
        'destination is refused, so forwarding silently fails.',
    });
  }

  /**
   * Configuration mistakes that would produce a mail loop, a black hole or a
   * receipt rule in a region that cannot receive. Reported as annotations so
   * the message names the exact problem instead of surfacing as an opaque
   * deploy failure — or, worse, as mail nobody ever reads.
   */
  private validateConfiguration(args: {
    readonly sesRegion: string;
    readonly config: MailStackProps['config'];
    readonly fromAddress: string;
    readonly forwardTo: readonly string[];
  }): void {
    const { sesRegion, config, fromAddress, forwardTo } = args;

    if (!SES_INBOUND_REGIONS.includes(sesRegion)) {
      Annotations.of(this).addWarningV2(
        '@kinmap/mail-stack:ses-inbound-region',
        `SES cannot receive mail in every region, and ${sesRegion} is not in this stack's ` +
          `known-good list. If AWS has since added it, extend SES_INBOUND_REGIONS; otherwise ` +
          `set sesRegion to one of: ${SES_INBOUND_REGIONS.join(', ')}.`,
      );
    }

    if (sesRegion !== config.region) {
      Annotations.of(this).addInfoV2(
        '@kinmap/mail-stack:ses-region-split',
        `This stack deploys into ${sesRegion} rather than the application's primary region ` +
          `${config.region}, because the receipt rule, its spool bucket and the forwarder must ` +
          'all sit in a region where SES can receive.',
      );
    }

    if (forwardTo.length === 0) {
      Annotations.of(this).addError(
        'MailStack requires forwardTo: at least one inbox to deliver to. A support address ' +
          'that accepts mail and forwards it nowhere fails App Review the first time it is used.',
      );
    }

    const domainSuffix = `@${config.domain}`.toLowerCase();
    for (const destination of forwardTo) {
      if (destination.toLowerCase().endsWith(domainSuffix)) {
        Annotations.of(this).addWarningV2(
          '@kinmap/mail-stack:destination-on-own-domain',
          `A forwarding destination is on ${config.domain}, which this stack does not host ` +
            'mailboxes for. Forwarded mail will be delivered to an address nobody can read, ' +
            'or loop straight back into the receipt rule. Use a real personal inbox.',
        );
      }
    }

    if (this.forwardedAddresses.includes(fromAddress)) {
      Annotations.of(this).addError(
        `MailStack cannot send as ${fromAddress}: it is one of the addresses the receipt rule ` +
          'accepts, so every reply, bounce and vacation responder would come straight back in.',
      );
    }
  }
}
