import { beforeEach, describe, expect, it } from 'vitest';

import { CUSTOM_MESSAGE_SOURCES } from '../src/events.js';

import { createHarness, customMessageEvent, type Harness } from './support/harness.js';

/**
 * Custom messages are the one place this service produces text a human reads,
 * so the tests are about what must and must not be in it: the code placeholder
 * verbatim, and nothing that identifies the recipient.
 */

describe('customMessage', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness();
  });

  it('fills subject, email body and SMS for every trigger source', async () => {
    for (const triggerSource of CUSTOM_MESSAGE_SOURCES) {
      const result = await harness.handle(customMessageEvent({ triggerSource }));
      const response = result.response as {
        emailSubject?: string;
        emailMessage?: string;
        smsMessage?: string;
      };

      expect(response.emailSubject).toBeTruthy();
      expect(response.emailMessage).toBeTruthy();
      expect(response.smsMessage).toBeTruthy();
    }
  });

  it('reproduces the code placeholder verbatim', async () => {
    for (const triggerSource of CUSTOM_MESSAGE_SOURCES) {
      const result = await harness.handle(customMessageEvent({ triggerSource }));
      const response = result.response as { emailMessage?: string; smsMessage?: string };

      // Cognito substitutes the real code after the trigger returns; a message
      // without this placeholder is delivered with no code in it.
      expect(response.emailMessage).toContain('{####}');
      expect(response.smsMessage).toContain('{####}');
    }
  });

  it('never puts the recipient in the message', async () => {
    for (const triggerSource of CUSTOM_MESSAGE_SOURCES) {
      const result = await harness.handle(
        customMessageEvent({
          triggerSource,
          userAttributes: {
            sub: '000000a1-0000-4000-8000-000000000001',
            email: 'person@example.test',
            name: 'Alex Doe',
            phone_number: '+447700900000',
          },
        }),
      );
      const serialised = JSON.stringify(result.response);

      expect(serialised).not.toContain('person@example.test');
      expect(serialised).not.toContain('Alex Doe');
      expect(serialised).not.toContain('+447700900000');
      expect(serialised).not.toContain('000000a1-0000-4000-8000-000000000001');
    }
  });

  it('uses the configured domain for links', async () => {
    const result = await harness.handle(
      customMessageEvent({ triggerSource: 'CustomMessage_SignUp' }),
    );
    const response = result.response as { emailMessage?: string };

    expect(response.emailMessage).toContain('https://kinmap.test/security');
  });

  it('distinguishes a password reset from a sign-up verification', async () => {
    const signUp = await harness.handle(
      customMessageEvent({ triggerSource: 'CustomMessage_SignUp' }),
    );
    const reset = await harness.handle(
      customMessageEvent({ triggerSource: 'CustomMessage_ForgotPassword' }),
    );

    expect((signUp.response as { emailSubject?: string }).emailSubject).toBe(
      'KinMap verification code',
    );
    expect((reset.response as { emailSubject?: string }).emailSubject).toBe(
      'KinMap password reset code',
    );
  });
});

describe('dispatch', () => {
  it('passes an unrecognised trigger source through untouched', async () => {
    const harness = createHarness();
    const event = {
      version: '1',
      region: 'eu-west-2',
      userPoolId: 'eu-west-2_testpool',
      userName: 'test-user',
      callerContext: { clientId: 'test-client' },
      triggerSource: 'SomeFutureTrigger_Thing',
      request: {},
      response: {},
    };

    const result = await harness.handle(event);

    expect(result).toEqual(event);
    expect(harness.logs.some((record) => record['message'] === 'unhandled_trigger_source')).toBe(
      true,
    );
  });
});
