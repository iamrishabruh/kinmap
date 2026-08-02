import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { SendRawEmailCommand, SESClient } from '@aws-sdk/client-ses';

import { createLogger, createMetrics } from '@family/observability';

import { loadConfig } from './env.js';
import {
  buildForwardedMessage,
  normaliseVerdict,
  screenMessage,
  type SesVerdicts,
} from './forward.js';

/**
 * services/mail-forwarder — the delivery path for support@, privacy@ and
 * security@.
 *
 * The SES receipt rule runs two actions in order: an S3 action that spools the
 * raw message, then an asynchronous Lambda action that invokes this function.
 * SES's Lambda event carries the verdicts and the envelope but NOT the message,
 * so the object key is reconstructed as `${MAIL_OBJECT_PREFIX}${messageId}` —
 * the same key the S3 action wrote.
 *
 * Privacy: this function handles other people's mail. It logs the SES message
 * id, the five scan verdicts, the message size and the outcome — and nothing
 * else. No subject, no sender, no recipient, no body, ever, in any branch,
 * including the error branches.
 */

interface SesVerdictStatus {
  readonly status?: string;
}

interface SesReceipt {
  readonly recipients?: readonly string[];
  readonly spamVerdict?: SesVerdictStatus;
  readonly virusVerdict?: SesVerdictStatus;
  readonly spfVerdict?: SesVerdictStatus;
  readonly dkimVerdict?: SesVerdictStatus;
  readonly dmarcVerdict?: SesVerdictStatus;
}

interface SesMail {
  readonly messageId?: string;
  /** Envelope MAIL FROM. */
  readonly source?: string;
}

interface SesEventRecord {
  readonly ses?: {
    readonly mail?: SesMail;
    readonly receipt?: SesReceipt;
  };
}

export interface SesLambdaEvent {
  readonly Records?: readonly SesEventRecord[];
}

const config = loadConfig();

const logger = createLogger({
  service: config.serviceName,
  env: config.appEnv,
  bindings: { component: 'mail-forwarder' },
});

const metrics = createMetrics({
  namespace: config.metricsNamespace,
  dimensions: { service: config.serviceName, env: config.appEnv },
});

const s3 = new S3Client({});
// No explicit region: the receipt rule, the spool bucket and this function all
// live in the SES receiving region, so the ambient region is the right one.
const ses = new SESClient({});

export async function handler(event: SesLambdaEvent): Promise<void> {
  for (const record of event.Records ?? []) {
    await handleRecord(record);
  }
}

async function handleRecord(record: SesEventRecord): Promise<void> {
  const notification = record.ses;
  const messageId = notification?.mail?.messageId ?? '';

  if (messageId.length === 0) {
    logger.warn('Ignored an SES record that carried no message id.');
    metrics.count('InboundMailIgnored', 1, { reason: 'NO_MESSAGE_ID' });
    return;
  }

  const verdicts = readVerdicts(notification?.receipt);
  const recipients = notification?.receipt?.recipients ?? [];
  const source = notification?.mail?.source;

  // Screen before fetching. A message SES flagged as carrying a virus is never
  // read into this process at all.
  const screened = screenMessage({ verdicts, recipients, source, policy: config.policy });
  if (screened !== null) {
    logger.warn('Dropped an inbound message.', { messageId, reason: screened, ...verdicts });
    metrics.count('InboundMailDropped', 1, { reason: screened });
    return;
  }

  const objectKey = `${config.objectKeyPrefix}${messageId}`;
  const stored = await readStoredMessage(objectKey);

  const outcome = buildForwardedMessage({
    messageId,
    objectKey,
    raw: stored.raw,
    sizeBytes: stored.sizeBytes,
    verdicts,
    recipients,
    source,
    policy: config.policy,
  });

  if (outcome.kind === 'drop') {
    logger.warn('Dropped an inbound message after reading it.', {
      messageId,
      reason: outcome.reason,
      sizeBytes: stored.sizeBytes,
      ...verdicts,
    });
    metrics.count('InboundMailDropped', 1, { reason: outcome.reason });
    return;
  }

  await ses.send(
    new SendRawEmailCommand({
      // Envelope sender on our own domain, so SPF authorises SES for this hop
      // and bounces come back to us rather than to the original sender.
      Source: outcome.source,
      Destinations: [...outcome.destinations],
      RawMessage: { Data: Buffer.from(outcome.raw, 'latin1') },
    }),
  );

  logger.info('Forwarded an inbound message.', {
    messageId,
    sizeBytes: stored.sizeBytes,
    summarised: outcome.summarised,
    destinationCount: outcome.destinations.length,
    ...verdicts,
  });
  metrics.count('InboundMailForwarded', 1, {
    summarised: outcome.summarised ? 'true' : 'false',
  });
}

function readVerdicts(receipt: SesReceipt | undefined): SesVerdicts {
  return {
    spam: normaliseVerdict(receipt?.spamVerdict?.status),
    virus: normaliseVerdict(receipt?.virusVerdict?.status),
    spf: normaliseVerdict(receipt?.spfVerdict?.status),
    dkim: normaliseVerdict(receipt?.dkimVerdict?.status),
    dmarc: normaliseVerdict(receipt?.dmarcVerdict?.status),
  };
}

/**
 * Reads the spooled message.
 *
 * `latin1` is not a guess about the message's character set — it is the one
 * decoding where every byte maps to exactly one code unit, so header surgery
 * cannot corrupt an 8-bit or binary MIME part and `Buffer.from(text, 'latin1')`
 * reproduces the original bytes exactly. Decoding as UTF-8 would replace every
 * invalid sequence with U+FFFD and quietly mangle attachments.
 *
 * Failures throw: SES invokes this function asynchronously, so Lambda retries
 * and a message that still cannot be forwarded lands on the dead-letter queue
 * instead of disappearing.
 */
async function readStoredMessage(
  objectKey: string,
): Promise<{ readonly raw: string; readonly sizeBytes: number }> {
  const response = await s3.send(
    new GetObjectCommand({ Bucket: config.bucketName, Key: objectKey }),
  );

  const body = response.Body;
  if (body === undefined) {
    throw new Error('The spooled message has no body.');
  }

  const bytes = await body.transformToByteArray();
  return { raw: Buffer.from(bytes).toString('latin1'), sizeBytes: bytes.byteLength };
}
