/**
 * Pure message-rewriting logic for services/mail-forwarder.
 *
 * Nothing in this module performs I/O, reads a clock, imports an AWS SDK client
 * or logs. Every input arrives as an argument, so the entire forwarding
 * decision — including the parts that must never happen, like forwarding a
 * message SES flagged as a virus — is unit-testable without a network.
 *
 * ---------------------------------------------------------------------------
 * Why the From header is rewritten
 * ---------------------------------------------------------------------------
 * The obvious implementation of a forwarder is to take the message SES stored
 * and re-send it unchanged. That does not work, and it fails in the way that is
 * hardest to notice: the mail is accepted and then filed as spam.
 *
 *   - SPF authorises the *envelope* sender's domain against the connecting IP.
 *     When we re-send, the connecting IP is Amazon SES, not the sender's mail
 *     provider. An unchanged `From: someone@gmail.com` therefore arrives from
 *     an IP that gmail.com's SPF record does not authorise, which is an SPF
 *     failure by definition.
 *   - The original DKIM signature covers headers we must change (and, via the
 *     body hash, a body we may prepend a notice to). A *broken* signature is
 *     scored worse than no signature at all, so the original `DKIM-Signature`
 *     must be stripped rather than left to fail.
 *   - With SPF failing and DKIM stripped, DMARC has nothing aligned to pass on,
 *     and a domain publishing `p=reject` (which gmail.com, outlook.com and most
 *     corporate senders do) instructs the receiving mailbox to discard the
 *     message outright.
 *
 * The fix — the standard "sender rewriting" approach — is to send the message
 * as ourselves and keep the original sender reachable:
 *
 *   From:     a verified address on our own domain, so SPF authorises SES and
 *             SES's Easy DKIM signs with `d=kinmap.app`. DMARC then passes on
 *             DKIM alignment.
 *   Reply-To: the ORIGINAL sender, so hitting reply in the personal inbox
 *             answers the person who wrote in rather than a no-reply mailbox.
 *   Subject:  untouched, byte for byte.
 *
 * The alias the message was addressed to (support@, privacy@, security@) would
 * otherwise be lost, so it is prepended as an `X-Kinmap-Original-To` header, is
 * carried in the From display name where every mail client shows it, and — only
 * where doing so cannot corrupt the message — as a two-line notice at the top
 * of the body.
 */

/** Canonical RFC 5322 line ending. */
export const CRLF = '\r\n';

export type LineEnding = '\r\n' | '\n';

/** Marks our own output so a message that comes back round is not forwarded twice. */
export const FORWARDED_BY_HEADER = 'X-Kinmap-Forwarded-By';
export const FORWARDED_BY_VALUE = 'kinmap-mail-forwarder';

const FORWARDED_BY_KEY = FORWARDED_BY_HEADER.toLowerCase();

// ---------------------------------------------------------------------------
// Header parsing
// ---------------------------------------------------------------------------

export interface HeaderField {
  /** Field name exactly as it appeared on the wire. */
  readonly name: string;
  /** Lower-cased {@link name}; header names are case-insensitive. */
  readonly key: string;
  /** Field value, with any folding still in place. */
  readonly value: string;
  /** The complete field, including folded continuation lines. */
  readonly raw: string;
}

export interface SplitMessage {
  readonly headerBlock: string;
  readonly body: string;
  /**
   * The line ending the message actually used. Re-assembly reuses it so a
   * forwarded message is not silently converted between CRLF and LF, which
   * would change every MIME boundary's meaning.
   */
  readonly lineEnding: LineEnding;
}

/** Splits a message at the first empty line, per RFC 5322 §2.1. */
export function splitMessage(raw: string): SplitMessage {
  const crlfIndex = raw.indexOf('\r\n\r\n');
  const lfIndex = raw.indexOf('\n\n');

  if (crlfIndex >= 0 && (lfIndex < 0 || crlfIndex < lfIndex)) {
    return {
      headerBlock: raw.slice(0, crlfIndex),
      body: raw.slice(crlfIndex + 4),
      lineEnding: CRLF,
    };
  }
  if (lfIndex >= 0) {
    return {
      headerBlock: raw.slice(0, lfIndex),
      body: raw.slice(lfIndex + 2),
      lineEnding: '\n',
    };
  }
  // Headers only. Still a legal message.
  return { headerBlock: raw, body: '', lineEnding: raw.includes(CRLF) ? CRLF : '\n' };
}

/**
 * Parses a header block into fields, keeping folded continuation lines attached
 * to the field they belong to so that re-emitting `field.raw` reproduces the
 * original bytes.
 */
export function parseHeaderFields(headerBlock: string, lineEnding: LineEnding): HeaderField[] {
  const fields: HeaderField[] = [];
  if (headerBlock.length === 0) {
    return fields;
  }

  let pending: { name: string; value: string; raw: string } | undefined;

  const flush = (): void => {
    if (pending === undefined) return;
    fields.push({
      name: pending.name,
      key: pending.name.toLowerCase(),
      value: pending.value,
      raw: pending.raw,
    });
    pending = undefined;
  };

  for (const line of headerBlock.split(lineEnding)) {
    if (pending !== undefined && (line.startsWith(' ') || line.startsWith('\t'))) {
      pending.value += `${lineEnding}${line}`;
      pending.raw += `${lineEnding}${line}`;
      continue;
    }

    const colon = line.indexOf(':');
    if (colon <= 0) {
      // Not a header field. Dropping it is safer than guessing where a
      // malformed line belongs.
      continue;
    }

    flush();
    const name = line.slice(0, colon);
    pending = {
      name,
      value: line.slice(colon + 1).replace(/^ /, ''),
      raw: line,
    };
  }

  flush();
  return fields;
}

/** First field with this name, or undefined. */
export function findHeader(fields: readonly HeaderField[], name: string): HeaderField | undefined {
  const key = name.toLowerCase();
  return fields.find((field) => field.key === key);
}

/** Collapses RFC 5322 folding into single spaces and trims the result. */
export function unfold(value: string): string {
  return value
    .replace(/\r\n[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, ' ')
    .trim();
}

/**
 * Removes anything that could terminate a header field early. Every value this
 * module synthesises passes through here, so an attacker-controlled recipient
 * or message id cannot inject a header — or a body — of their own.
 */
export function sanitiseHeaderValue(value: string): string {
  return unfold(value)
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

/** Builds a single-line header field with a sanitised value. */
export function headerField(name: string, value: string): HeaderField {
  const safe = sanitiseHeaderValue(value);
  return { name, key: name.toLowerCase(), value: safe, raw: `${name}: ${safe}` };
}

/** Renders fields and a body back into a complete message. */
export function assembleMessage(
  fields: readonly HeaderField[],
  body: string,
  lineEnding: LineEnding,
): string {
  const headerBlock = fields.map((field) => field.raw).join(lineEnding);
  return `${headerBlock}${lineEnding}${lineEnding}${body}`;
}

// ---------------------------------------------------------------------------
// Headers that must not survive the rewrite
// ---------------------------------------------------------------------------

/**
 * Authentication results computed for the ORIGINAL delivery. Every one of these
 * is either invalidated by the rewrite or, worse, would be trusted by the
 * receiving mailbox as if we had computed it — so all of them go.
 */
const AUTHENTICATION_HEADERS: ReadonlySet<string> = new Set([
  'dkim-signature',
  'domainkey-signature',
  'authentication-results',
  'x-original-authentication-results',
  'received-spf',
  'arc-seal',
  'arc-message-signature',
  'arc-authentication-results',
]);

/**
 * Envelope-scoped headers. `Return-Path` and `Sender` belong to the delivery we
 * are replacing; `Bcc` must never be echoed; `Message-ID` is dropped so that the
 * copy SES assigns is unique — Gmail hides a message whose Message-ID it has
 * already filed, which is exactly how a forwarded copy of your own mail
 * disappears.
 */
const ENVELOPE_HEADERS: ReadonlySet<string> = new Set([
  'return-path',
  'sender',
  'resent-sender',
  'bcc',
  'resent-bcc',
  'message-id',
]);

/** Replaced with our own values further down. */
const REPLACED_HEADERS: ReadonlySet<string> = new Set(['from', 'reply-to']);

function isStripped(key: string): boolean {
  return (
    AUTHENTICATION_HEADERS.has(key) ||
    ENVELOPE_HEADERS.has(key) ||
    REPLACED_HEADERS.has(key) ||
    // Anything claiming to be ours is not: strip inbound spoofs so the loop
    // guard below cannot be defeated by simply setting the header.
    key.startsWith('x-kinmap-')
  );
}

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

/** The five verdicts SES attaches to a received message. */
export interface SesVerdicts {
  readonly spam: string;
  readonly virus: string;
  readonly spf: string;
  readonly dkim: string;
  readonly dmarc: string;
}

export const UNKNOWN_VERDICT = 'UNKNOWN';

/** Normalises a raw verdict status; an absent verdict is never treated as PASS. */
export function normaliseVerdict(status: string | undefined): string {
  const trimmed = (status ?? '').trim().toUpperCase();
  return trimmed.length > 0 ? trimmed : UNKNOWN_VERDICT;
}

/** Compact, log-safe rendering of all five verdicts. */
export function formatVerdicts(verdicts: SesVerdicts): string {
  return [
    `spam=${verdicts.spam}`,
    `virus=${verdicts.virus}`,
    `spf=${verdicts.spf}`,
    `dkim=${verdicts.dkim}`,
    `dmarc=${verdicts.dmarc}`,
  ].join(' ');
}

// ---------------------------------------------------------------------------
// Policy and outcomes
// ---------------------------------------------------------------------------

export interface ForwardPolicy {
  /** Addresses this forwarder accepts, lower-cased (`support@kinmap.app`, ...). */
  readonly forwardedAddresses: readonly string[];
  /** Verified address on our own domain that every forwarded copy is sent from. */
  readonly fromAddress: string;
  /** Personal inboxes the copy is delivered to. */
  readonly destinations: readonly string[];
  /**
   * Above this many bytes only a notice is forwarded. SES itself accepts 40 MB,
   * but most consumer mailboxes reject anything much over 25 MB, and a bounce
   * from the destination is indistinguishable from mail we never received.
   */
  readonly maxForwardBytes: number;
}

export type DropReason =
  | 'VIRUS_VERDICT_FAILED'
  | 'SPAM_VERDICT_FAILED'
  | 'NO_FORWARDED_RECIPIENT'
  | 'FORWARD_LOOP'
  | 'EMPTY_MESSAGE';

export type ForwardOutcome =
  | { readonly kind: 'drop'; readonly reason: DropReason }
  | {
      readonly kind: 'forward';
      /** Complete RFC 5322 message to hand to `ses:SendRawEmail`. */
      readonly raw: string;
      /** Envelope sender; must be the same domain the From header uses. */
      readonly source: string;
      readonly destinations: readonly string[];
      /** True when the body was replaced by a size notice rather than forwarded. */
      readonly summarised: boolean;
      /** Aliases this delivery matched, for metrics and troubleshooting. */
      readonly matchedRecipients: readonly string[];
    };

export interface ScreenInput {
  readonly verdicts: SesVerdicts;
  /** Envelope recipients SES reported for this delivery. */
  readonly recipients: readonly string[];
  /** Envelope MAIL FROM, when SES reported one. */
  readonly source?: string;
  readonly policy: ForwardPolicy;
}

export interface ForwardInput extends ScreenInput {
  readonly messageId: string;
  /** S3 key the raw message is stored under; quoted in the oversize notice. */
  readonly objectKey: string;
  /** The raw message exactly as SES stored it. */
  readonly raw: string;
  /** Size in BYTES. Passed in because a JS string length counts UTF-16 units. */
  readonly sizeBytes: number;
}

/** Aliases in {@link allowed} that this delivery was addressed to, de-duplicated. */
export function matchForwardedRecipients(
  recipients: readonly string[],
  allowed: readonly string[],
): string[] {
  const delivered = new Set(recipients.map((recipient) => recipient.trim().toLowerCase()));
  const matched: string[] = [];
  for (const address of allowed) {
    const normalised = address.trim().toLowerCase();
    if (delivered.has(normalised) && !matched.includes(normalised)) {
      matched.push(normalised);
    }
  }
  return matched;
}

/**
 * Everything that can be decided from the SES event alone, before the message
 * body is fetched. Screening first is deliberate: a message SES flagged as
 * carrying a virus is never pulled into this process's memory at all.
 *
 * Only an explicit `FAIL` drops the message. `GRAY`, `PROCESSING_FAILED` and a
 * missing verdict are forwarded and reported in `X-Kinmap-Scan`, because
 * silently discarding a support request over a scanner that could not make up
 * its mind is a worse failure than a spam-scored one landing in the inbox.
 */
export function screenMessage(input: ScreenInput): DropReason | null {
  if (input.verdicts.virus === 'FAIL') return 'VIRUS_VERDICT_FAILED';
  if (input.verdicts.spam === 'FAIL') return 'SPAM_VERDICT_FAILED';

  if (matchForwardedRecipients(input.recipients, input.policy.forwardedAddresses).length === 0) {
    return 'NO_FORWARDED_RECIPIENT';
  }

  const source = (input.source ?? '').trim().toLowerCase();
  if (source.length > 0 && source === input.policy.fromAddress.trim().toLowerCase()) {
    return 'FORWARD_LOOP';
  }

  return null;
}

// ---------------------------------------------------------------------------
// Rewriting
// ---------------------------------------------------------------------------

/** Quotes a display name, escaping the two characters that can end the quote. */
function quotedDisplayName(text: string): string {
  const escaped = sanitiseHeaderValue(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}

/**
 * `"support@kinmap.app via Kinmap" <no-reply@kinmap.app>` — the alias is in the
 * display name because that is the one place every mail client, including the
 * iOS Mail app an App Review tester would use, actually renders.
 */
export function forwardFromHeaderValue(aliasLabel: string, fromAddress: string): string {
  const label = aliasLabel.length > 0 ? `${aliasLabel} via Kinmap` : 'Kinmap';
  return `${quotedDisplayName(label)} <${sanitiseHeaderValue(fromAddress)}>`;
}

/**
 * A body notice may only be prepended where it cannot corrupt the message.
 * Anything multipart is out (the first bytes belong to a boundary), and so is
 * base64 (plain text is not valid base64). Plain ASCII is legal inside 7bit,
 * 8bit, binary and quoted-printable bodies alike.
 */
export function canPrependBodyNotice(contentType: string, transferEncoding: string): boolean {
  const type = contentType.trim().length === 0 ? 'text/plain' : contentType.trim().toLowerCase();
  if (!type.startsWith('text/plain')) return false;

  const encoding =
    transferEncoding.trim().length === 0 ? '7bit' : transferEncoding.trim().toLowerCase();
  return (
    encoding === '7bit' ||
    encoding === '8bit' ||
    encoding === 'binary' ||
    encoding === 'quoted-printable'
  );
}

/** Two ASCII lines and a blank one; short enough not to bury the real message. */
function bodyNotice(aliasLabel: string, lineEnding: LineEnding): string {
  return [
    `Forwarded by Kinmap. Original recipient: ${sanitiseHeaderValue(aliasLabel)}`,
    'Reply to this message and your reply reaches the original sender.',
    '',
    '',
  ].join(lineEnding);
}

function noticeHeaders(input: ForwardInput, aliasLabel: string): HeaderField[] {
  return [
    headerField(FORWARDED_BY_HEADER, FORWARDED_BY_VALUE),
    headerField('X-Kinmap-Original-To', aliasLabel),
    headerField('X-Kinmap-Ses-Message-Id', input.messageId),
    headerField('X-Kinmap-Scan', formatVerdicts(input.verdicts)),
  ];
}

/**
 * Builds the message to send, or explains why nothing should be sent.
 *
 * Re-screens rather than trusting the caller: this is the last place a virus
 * verdict can be honoured, and a second cheap check is worth more than the
 * duplicated work costs.
 */
export function buildForwardedMessage(input: ForwardInput): ForwardOutcome {
  const screened = screenMessage(input);
  if (screened !== null) {
    return { kind: 'drop', reason: screened };
  }

  if (input.raw.trim().length === 0) {
    return { kind: 'drop', reason: 'EMPTY_MESSAGE' };
  }

  const { policy } = input;
  const matched = matchForwardedRecipients(input.recipients, policy.forwardedAddresses);
  const aliasLabel = matched.join(', ');

  const { headerBlock, body, lineEnding } = splitMessage(input.raw);
  const original = parseHeaderFields(headerBlock, lineEnding);

  // A copy we already produced has come back round — through a vacation
  // responder, a mailing list, or a misconfigured destination that redirects to
  // an address we receive. Forwarding it again is how a mail loop starts.
  if (original.some((field) => field.key === FORWARDED_BY_KEY)) {
    return { kind: 'drop', reason: 'FORWARD_LOOP' };
  }

  const originalFrom = unfold(findHeader(original, 'from')?.value ?? '');
  const replyTo =
    originalFrom.length > 0 ? [headerField('Reply-To', originalFrom)] : ([] as HeaderField[]);

  if (input.sizeBytes > policy.maxForwardBytes) {
    return {
      kind: 'forward',
      raw: buildOversizeNotice(input, { aliasLabel, original, replyTo }),
      source: policy.fromAddress,
      destinations: [...policy.destinations],
      summarised: true,
      matchedRecipients: matched,
    };
  }

  const kept = original.filter((field) => !isStripped(field.key));

  const rewritten: HeaderField[] = [
    ...noticeHeaders(input, aliasLabel),
    headerField('From', forwardFromHeaderValue(aliasLabel, policy.fromAddress)),
    ...replyTo,
    ...kept,
  ];

  const contentType = unfold(findHeader(kept, 'content-type')?.value ?? '');
  const transferEncoding = unfold(findHeader(kept, 'content-transfer-encoding')?.value ?? '');
  const finalBody = canPrependBodyNotice(contentType, transferEncoding)
    ? `${bodyNotice(aliasLabel, lineEnding)}${body}`
    : body;

  return {
    kind: 'forward',
    raw: assembleMessage(rewritten, finalBody, lineEnding),
    source: policy.fromAddress,
    destinations: [...policy.destinations],
    summarised: false,
    matchedRecipients: matched,
  };
}

/**
 * A message too large to forward becomes a short ASCII notice that carries the
 * original Subject and Reply-To. The point is that somebody still finds out
 * they were written to — silence would be the only outcome worse than a
 * truncated copy. The body is never included, so nothing about its content
 * leaves the account through this path.
 */
function buildOversizeNotice(
  input: ForwardInput,
  context: {
    readonly aliasLabel: string;
    readonly original: readonly HeaderField[];
    readonly replyTo: readonly HeaderField[];
  },
): string {
  const { policy } = input;

  const subject = findHeader(context.original, 'subject') ?? headerField('Subject', '(no subject)');
  const to = findHeader(context.original, 'to') ?? headerField('To', context.aliasLabel);
  const date = findHeader(context.original, 'date');

  const fields: HeaderField[] = [
    ...noticeHeaders(input, context.aliasLabel),
    headerField('X-Kinmap-Truncated', 'oversize'),
    headerField('From', forwardFromHeaderValue(context.aliasLabel, policy.fromAddress)),
    ...context.replyTo,
    to,
    subject,
    ...(date === undefined ? [] : [date]),
    headerField('MIME-Version', '1.0'),
    headerField('Content-Type', 'text/plain; charset=us-ascii'),
    headerField('Content-Transfer-Encoding', '7bit'),
  ];

  const body = [
    `A message was delivered to ${sanitiseHeaderValue(context.aliasLabel)} but was too`,
    'large to forward, so only this notice was sent.',
    '',
    `  size          ${input.sizeBytes} bytes`,
    `  forward limit ${policy.maxForwardBytes} bytes`,
    `  stored object ${sanitiseHeaderValue(input.objectKey)}`,
    '',
    'The complete message is in the Kinmap inbound-mail bucket until its',
    'lifecycle rule expires it. Reply to this notice to answer the sender.',
    '',
  ].join(CRLF);

  return assembleMessage(fields, body, CRLF);
}
