import { describe, expect, it } from 'vitest';

import {
  buildForwardedMessage,
  canPrependBodyNotice,
  CRLF,
  findHeader,
  forwardFromHeaderValue,
  formatVerdicts,
  matchForwardedRecipients,
  normaliseVerdict,
  parseHeaderFields,
  screenMessage,
  splitMessage,
  unfold,
  type ForwardInput,
  type ForwardOutcome,
  type ForwardPolicy,
  type SesVerdicts,
} from '../src/forward.js';

const POLICY: ForwardPolicy = {
  forwardedAddresses: ['support@kinmap.app', 'privacy@kinmap.app', 'security@kinmap.app'],
  fromAddress: 'no-reply@kinmap.app',
  destinations: ['owner@example.com'],
  maxForwardBytes: 1024,
};

const PASSING: SesVerdicts = {
  spam: 'PASS',
  virus: 'PASS',
  spf: 'PASS',
  dkim: 'PASS',
  dmarc: 'PASS',
};

function verdicts(overrides: Partial<SesVerdicts> = {}): SesVerdicts {
  return { ...PASSING, ...overrides };
}

function rawMessage(lines: readonly string[], body: string, lineEnding = CRLF): string {
  return `${lines.join(lineEnding)}${lineEnding}${lineEnding}${body}`;
}

const PLAIN_TEXT_MESSAGE = rawMessage(
  [
    'Return-Path: <reviewer@apple.com>',
    'Received: from mail.apple.com (mail.apple.com [17.0.0.1]) by inbound-smtp.us-east-1.amazonaws.com',
    'DKIM-Signature: v=1; a=rsa-sha256; d=apple.com; s=selector; bh=abc; b=def',
    'Authentication-Results: amazonses.com; spf=pass; dkim=pass',
    'Received-SPF: pass (amazonses.com: domain of apple.com designates 17.0.0.1)',
    'Message-ID: <original-message-id@apple.com>',
    'From: App Review <reviewer@apple.com>',
    'To: support@kinmap.app',
    'Subject: =?utf-8?q?App_Review_=E2=80=94_Kinmap_1.0?=',
    'Date: Sun, 02 Aug 2026 09:15:00 +0000',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 7bit',
  ],
  `We are reviewing your submission.${CRLF}Please confirm the demo account.${CRLF}`,
);

function input(overrides: Partial<ForwardInput> = {}): ForwardInput {
  const raw = overrides.raw ?? PLAIN_TEXT_MESSAGE;
  return {
    messageId: 'ses-message-id-000000000001',
    objectKey: 'inbound/ses-message-id-000000000001',
    raw,
    sizeBytes: Buffer.byteLength(raw, 'latin1'),
    verdicts: PASSING,
    recipients: ['support@kinmap.app'],
    source: 'reviewer@apple.com',
    policy: POLICY,
    ...overrides,
  };
}

/** Narrows to the forwarding branch and fails the test if the message was dropped. */
function forwarded(outcome: ForwardOutcome): Extract<ForwardOutcome, { kind: 'forward' }> {
  if (outcome.kind !== 'forward') {
    throw new Error(`Expected the message to be forwarded, but it was dropped: ${outcome.reason}`);
  }
  return outcome;
}

function headersOf(raw: string): ReturnType<typeof parseHeaderFields> {
  const split = splitMessage(raw);
  return parseHeaderFields(split.headerBlock, split.lineEnding);
}

function headerValue(raw: string, name: string): string {
  return unfold(findHeader(headersOf(raw), name)?.value ?? '');
}

// ---------------------------------------------------------------------------

describe('splitMessage and parseHeaderFields', () => {
  it('keeps a folded header attached to the field it continues', () => {
    const raw = rawMessage(
      ['Subject: a very long subject', ' that continues here', 'To: support@kinmap.app'],
      'body',
    );

    const fields = headersOf(raw);

    expect(fields.map((field) => field.name)).toEqual(['Subject', 'To']);
    expect(unfold(fields[0]?.value ?? '')).toBe('a very long subject that continues here');
    expect(fields[0]?.raw).toBe(`Subject: a very long subject${CRLF} that continues here`);
  });

  it('handles a bare-LF message and a message with no body', () => {
    const lf = splitMessage('Subject: hi\nTo: support@kinmap.app\n\nbody');
    expect(lf.lineEnding).toBe('\n');
    expect(lf.body).toBe('body');

    const headersOnly = splitMessage('Subject: hi\r\nTo: support@kinmap.app');
    expect(headersOnly.body).toBe('');
    expect(headersOnly.lineEnding).toBe(CRLF);
  });
});

describe('header rewriting', () => {
  it('sends as our own verified address so SPF and DKIM can pass', () => {
    const result = forwarded(buildForwardedMessage(input()));

    // Naively re-sending with `From: reviewer@apple.com` would be an SPF
    // failure from an SES IP and would be discarded under apple.com's DMARC
    // policy. The alias travels in the display name instead.
    expect(headerValue(result.raw, 'from')).toBe(
      '"support@kinmap.app via Kinmap" <no-reply@kinmap.app>',
    );
    expect(result.source).toBe('no-reply@kinmap.app');
    expect(result.destinations).toEqual(['owner@example.com']);
  });

  it('points Reply-To at the original sender, display name included', () => {
    const result = forwarded(buildForwardedMessage(input()));

    expect(headerValue(result.raw, 'reply-to')).toBe('App Review <reviewer@apple.com>');
  });

  it('preserves the original Subject byte for byte', () => {
    const result = forwarded(buildForwardedMessage(input()));

    expect(findHeader(headersOf(result.raw), 'subject')?.raw).toBe(
      'Subject: =?utf-8?q?App_Review_=E2=80=94_Kinmap_1.0?=',
    );
  });

  it('prepends a header naming the alias the message was addressed to', () => {
    const result = forwarded(buildForwardedMessage(input()));
    const fields = headersOf(result.raw);

    expect(fields[0]?.name).toBe('X-Kinmap-Forwarded-By');
    expect(headerValue(result.raw, 'x-kinmap-original-to')).toBe('support@kinmap.app');
    expect(headerValue(result.raw, 'x-kinmap-ses-message-id')).toBe('ses-message-id-000000000001');
    expect(headerValue(result.raw, 'x-kinmap-scan')).toBe(formatVerdicts(PASSING));
  });

  it('strips the authentication headers the rewrite invalidates', () => {
    const result = forwarded(buildForwardedMessage(input()));
    const keys = headersOf(result.raw).map((field) => field.key);

    // A broken DKIM signature scores worse than no signature at all.
    expect(keys).not.toContain('dkim-signature');
    expect(keys).not.toContain('authentication-results');
    expect(keys).not.toContain('received-spf');
    expect(keys).not.toContain('return-path');
    // Dropped so SES assigns a fresh one; Gmail hides a duplicate Message-ID.
    expect(keys).not.toContain('message-id');
    // Trace and threading headers are harmless and stay.
    expect(keys).toContain('received');
    expect(keys).toContain('date');
    expect(keys).toContain('to');
  });

  it('lists both aliases when one delivery matched two of them', () => {
    const result = forwarded(
      buildForwardedMessage(input({ recipients: ['security@kinmap.app', 'privacy@kinmap.app'] })),
    );

    // Ordered by the policy, not by the envelope.
    expect(headerValue(result.raw, 'x-kinmap-original-to')).toBe(
      'privacy@kinmap.app, security@kinmap.app',
    );
    expect(result.matchedRecipients).toEqual(['privacy@kinmap.app', 'security@kinmap.app']);
  });

  it('cannot be made to inject a header through the recipient list', () => {
    const value = forwardFromHeaderValue(
      `support@kinmap.app${CRLF}Bcc: attacker@example.com`,
      'no-reply@kinmap.app',
    );

    expect(value).not.toContain('\r');
    expect(value).not.toContain('\n');
    expect(value).toBe(
      '"support@kinmap.app Bcc: attacker@example.com via Kinmap" <no-reply@kinmap.app>',
    );
  });

  it('escapes quotes in a display name instead of ending it early', () => {
    expect(forwardFromHeaderValue('a"b', 'no-reply@kinmap.app')).toBe(
      '"a\\"b via Kinmap" <no-reply@kinmap.app>',
    );
  });

  it('omits Reply-To when the original had no From to reply to', () => {
    const raw = rawMessage(
      ['To: support@kinmap.app', 'Subject: bounce', 'Content-Type: text/plain'],
      'delivery status notification',
    );

    const result = forwarded(buildForwardedMessage(input({ raw })));

    expect(findHeader(headersOf(result.raw), 'reply-to')).toBeUndefined();
  });
});

describe('body notice', () => {
  it('prepends a visible notice to a plain-text body', () => {
    const result = forwarded(buildForwardedMessage(input()));
    const body = splitMessage(result.raw).body;

    expect(body.startsWith('Forwarded by Kinmap. Original recipient: support@kinmap.app')).toBe(
      true,
    );
    expect(body).toContain('We are reviewing your submission.');
  });

  it('leaves a multipart body untouched, boundary and all', () => {
    const body = [
      '--boundary42',
      'Content-Type: text/plain',
      '',
      'hello',
      '--boundary42--',
      '',
    ].join(CRLF);
    const raw = rawMessage(
      [
        'From: someone@example.com',
        'To: support@kinmap.app',
        'Subject: with an attachment',
        'MIME-Version: 1.0',
        'Content-Type: multipart/mixed; boundary="boundary42"',
      ],
      body,
    );

    const result = forwarded(buildForwardedMessage(input({ raw })));

    expect(splitMessage(result.raw).body).toBe(body);
  });

  it('leaves a base64 body untouched', () => {
    const raw = rawMessage(
      [
        'From: someone@example.com',
        'To: support@kinmap.app',
        'Subject: encoded',
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: base64',
      ],
      'aGVsbG8gd29ybGQ=',
    );

    const result = forwarded(buildForwardedMessage(input({ raw })));

    expect(splitMessage(result.raw).body).toBe('aGVsbG8gd29ybGQ=');
  });

  it('knows which bodies it is allowed to touch', () => {
    expect(canPrependBodyNotice('', '')).toBe(true);
    expect(canPrependBodyNotice('text/plain; charset=UTF-8', 'quoted-printable')).toBe(true);
    expect(canPrependBodyNotice('TEXT/PLAIN', '8BIT')).toBe(true);
    expect(canPrependBodyNotice('text/html', '7bit')).toBe(false);
    expect(canPrependBodyNotice('multipart/mixed; boundary="x"', '')).toBe(false);
    expect(canPrependBodyNotice('text/plain', 'base64')).toBe(false);
  });
});

describe('verdict handling', () => {
  it('drops a message that failed the virus scan without reading it', () => {
    expect(
      screenMessage({
        verdicts: verdicts({ virus: 'FAIL' }),
        recipients: ['support@kinmap.app'],
        policy: POLICY,
      }),
    ).toBe('VIRUS_VERDICT_FAILED');

    expect(buildForwardedMessage(input({ verdicts: verdicts({ virus: 'FAIL' }) }))).toEqual({
      kind: 'drop',
      reason: 'VIRUS_VERDICT_FAILED',
    });
  });

  it('drops a message that failed the spam scan', () => {
    expect(buildForwardedMessage(input({ verdicts: verdicts({ spam: 'FAIL' }) }))).toEqual({
      kind: 'drop',
      reason: 'SPAM_VERDICT_FAILED',
    });
  });

  it('prefers the virus reason when both scans failed', () => {
    expect(
      buildForwardedMessage(input({ verdicts: verdicts({ spam: 'FAIL', virus: 'FAIL' }) })),
    ).toEqual({ kind: 'drop', reason: 'VIRUS_VERDICT_FAILED' });
  });

  it('still forwards when a scan was inconclusive, and says so in a header', () => {
    for (const status of ['GRAY', 'PROCESSING_FAILED', 'UNKNOWN']) {
      const scan = verdicts({ spam: status, virus: status });
      const result = forwarded(buildForwardedMessage(input({ verdicts: scan })));

      expect(headerValue(result.raw, 'x-kinmap-scan')).toBe(formatVerdicts(scan));
    }
  });

  it('treats an absent verdict as unknown rather than as a pass', () => {
    expect(normaliseVerdict(undefined)).toBe('UNKNOWN');
    expect(normaliseVerdict('  ')).toBe('UNKNOWN');
    expect(normaliseVerdict('fail')).toBe('FAIL');
  });
});

describe('recipient and loop screening', () => {
  it('drops a delivery to an address this forwarder does not serve', () => {
    expect(buildForwardedMessage(input({ recipients: ['ceo@kinmap.app'] }))).toEqual({
      kind: 'drop',
      reason: 'NO_FORWARDED_RECIPIENT',
    });
  });

  it('matches an alias regardless of the case SES reported it in', () => {
    expect(matchForwardedRecipients([' SUPPORT@Kinmap.App '], POLICY.forwardedAddresses)).toEqual([
      'support@kinmap.app',
    ]);
  });

  it('drops a message we sent ourselves', () => {
    expect(buildForwardedMessage(input({ source: 'NO-REPLY@kinmap.app' }))).toEqual({
      kind: 'drop',
      reason: 'FORWARD_LOOP',
    });
  });

  it('drops a copy that already carries our forwarding header', () => {
    const raw = rawMessage(
      [
        'X-Kinmap-Forwarded-By: kinmap-mail-forwarder',
        'From: someone@example.com',
        'To: support@kinmap.app',
        'Subject: round two',
      ],
      'looping',
    );

    expect(buildForwardedMessage(input({ raw }))).toEqual({
      kind: 'drop',
      reason: 'FORWARD_LOOP',
    });
  });

  it('drops an empty message', () => {
    expect(buildForwardedMessage(input({ raw: '   ' }))).toEqual({
      kind: 'drop',
      reason: 'EMPTY_MESSAGE',
    });
  });
});

describe('oversized messages', () => {
  const oversized = () =>
    forwarded(
      buildForwardedMessage(
        input({
          sizeBytes: 41_943_040,
          raw: rawMessage(
            [
              'From: App Review <reviewer@apple.com>',
              'To: support@kinmap.app',
              'Subject: crash logs attached',
              'Date: Sun, 02 Aug 2026 09:15:00 +0000',
              'Content-Type: text/plain; charset=UTF-8',
            ],
            'forty megabytes of confidential crash logs',
          ),
        }),
      ),
    );

  it('sends a notice instead of the message', () => {
    const result = oversized();

    expect(result.summarised).toBe(true);
    expect(headerValue(result.raw, 'x-kinmap-truncated')).toBe('oversize');
    expect(splitMessage(result.raw).body).toContain('41943040 bytes');
    expect(splitMessage(result.raw).body).toContain('1024 bytes');
    expect(splitMessage(result.raw).body).toContain('inbound/ses-message-id-000000000001');
  });

  it('never puts any of the original body in the notice', () => {
    expect(oversized().raw).not.toContain('forty megabytes of confidential crash logs');
  });

  it('still lets the recipient see and answer the sender', () => {
    const result = oversized();

    expect(headerValue(result.raw, 'subject')).toBe('crash logs attached');
    expect(headerValue(result.raw, 'reply-to')).toBe('App Review <reviewer@apple.com>');
    expect(headerValue(result.raw, 'from')).toBe(
      '"support@kinmap.app via Kinmap" <no-reply@kinmap.app>',
    );
    expect(headerValue(result.raw, 'content-type')).toBe('text/plain; charset=us-ascii');
  });

  it('is a scan verdict decision first: an oversized virus is still dropped', () => {
    expect(
      buildForwardedMessage(
        input({ sizeBytes: 41_943_040, verdicts: verdicts({ virus: 'FAIL' }) }),
      ),
    ).toEqual({ kind: 'drop', reason: 'VIRUS_VERDICT_FAILED' });
  });

  it('forwards the whole message when it is exactly at the limit', () => {
    const result = forwarded(buildForwardedMessage(input({ sizeBytes: POLICY.maxForwardBytes })));

    expect(result.summarised).toBe(false);
  });
});
