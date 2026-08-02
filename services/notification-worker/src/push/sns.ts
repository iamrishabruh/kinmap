import {
  CreatePlatformEndpointCommand,
  DeleteEndpointCommand,
  PublishCommand,
  SetEndpointAttributesCommand,
  type SNSClient,
} from '@aws-sdk/client-sns';

import type { Platform, PushPayload } from '@family/schemas';

import type { EndpointRegistry, PushSendOutcome, PushSender, PushTarget } from '../ports.js';

/**
 * Delivery through SNS mobile push (APNs and FCM platform applications).
 *
 * The payload that crosses the provider boundary is exactly the strict
 * `PushPayload`: ids, a place name the recipient's own family authored, and
 * pre-rendered copy. Nothing is added here.
 *
 * A rejected token is not a transient failure. APNs and FCM report a token that
 * was uninstalled, reissued or revoked as `EndpointDisabled` /
 * `InvalidParameter`, and continuing to publish to it wastes quota and, worse,
 * risks the endpoint being recycled onto a different device. Those two are
 * therefore reported as INVALID_ENDPOINT so the pipeline retires them.
 */

export type SnsPlatformApplications = {
  readonly apns: string | undefined;
  readonly apnsSandbox: string | undefined;
  readonly fcm: string | undefined;
};

/** Error names/messages that mean "this endpoint is dead", not "try again". */
const INVALID_ENDPOINT_ERROR_NAMES = new Set([
  'EndpointDisabledException',
  'InvalidParameterException',
  'NotFoundException',
]);

const INVALID_ENDPOINT_MESSAGE_FRAGMENTS = [
  'endpoint is disabled',
  'no endpoint found',
  'endpoint does not exist',
  'token is not valid',
];

function classify(error: unknown): PushSendOutcome {
  const name = error instanceof Error ? error.name : 'UnknownError';
  const message = error instanceof Error ? error.message.toLowerCase() : '';

  if (INVALID_ENDPOINT_ERROR_NAMES.has(name)) {
    if (name !== 'InvalidParameterException') {
      return { status: 'INVALID_ENDPOINT', reason: name };
    }
    // InvalidParameter is overloaded: it also covers a malformed publish. Only
    // the endpoint-shaped variants retire a token.
    if (INVALID_ENDPOINT_MESSAGE_FRAGMENTS.some((fragment) => message.includes(fragment))) {
      return { status: 'INVALID_ENDPOINT', reason: name };
    }
  }
  return { status: 'RETRYABLE', reason: name };
}

function buildMessage(
  platform: Platform,
  title: string,
  body: string,
  payload: PushPayload,
  useSandbox: boolean,
): string {
  const message: Record<string, string> = { default: body };

  if (platform === 'IOS') {
    const apns = JSON.stringify({
      aps: {
        alert: { title, body },
        sound: 'default',
        'thread-id': payload.familyId ?? 'account',
      },
      payload,
    });
    message[useSandbox ? 'APNS_SANDBOX' : 'APNS'] = apns;
  } else {
    message.GCM = JSON.stringify({
      notification: { title, body },
      // FCM data values must be strings; the structured payload is carried as
      // one JSON string the app parses after the tap.
      data: { payload: JSON.stringify(payload) },
    });
  }

  return JSON.stringify(message);
}

export class SnsPushSender implements PushSender {
  constructor(
    private readonly sns: SNSClient,
    private readonly platformApplications: SnsPlatformApplications,
    private readonly useApnsSandbox: boolean = false,
  ) {}

  async send(input: {
    target: PushTarget;
    payload: PushPayload;
    title: string;
    body: string;
  }): Promise<PushSendOutcome> {
    const endpointArn = await this.resolveEndpoint(input.target);
    if (endpointArn === null) {
      return { status: 'INVALID_ENDPOINT', reason: 'NoEndpoint' };
    }

    try {
      const response = await this.sns.send(
        new PublishCommand({
          TargetArn: endpointArn,
          MessageStructure: 'json',
          Message: buildMessage(
            input.target.platform,
            input.title,
            input.body,
            input.payload,
            this.useApnsSandbox,
          ),
        }),
      );
      return { status: 'DELIVERED', providerMessageId: response.MessageId ?? null };
    } catch (error) {
      return classify(error);
    }
  }

  /** Uses the stored endpoint, or mints one from a raw token if we only have that. */
  private async resolveEndpoint(target: PushTarget): Promise<string | null> {
    if (target.endpointArn !== null) return target.endpointArn;
    if (target.pushToken === null) return null;

    const applicationArn = this.platformApplicationFor(target.platform);
    if (applicationArn === undefined) return null;

    try {
      const created = await this.sns.send(
        new CreatePlatformEndpointCommand({
          PlatformApplicationArn: applicationArn,
          Token: target.pushToken,
          // Deliberately no CustomUserData: SNS endpoint attributes are readable
          // by anyone with sns:GetEndpointAttributes, so no user id goes in.
        }),
      );
      return created.EndpointArn ?? null;
    } catch {
      return null;
    }
  }

  private platformApplicationFor(platform: Platform): string | undefined {
    if (platform === 'ANDROID') return this.platformApplications.fcm;
    return this.useApnsSandbox
      ? (this.platformApplications.apnsSandbox ?? this.platformApplications.apns)
      : (this.platformApplications.apns ?? this.platformApplications.apnsSandbox);
  }
}

/** SNS half of the endpoint registry: disable, then delete. */
export class SnsEndpointDisabler {
  constructor(private readonly sns: SNSClient) {}

  async disableEndpoint(input: { endpointArn: string }): Promise<void> {
    try {
      await this.sns.send(
        new SetEndpointAttributesCommand({
          EndpointArn: input.endpointArn,
          Attributes: { Enabled: 'false' },
        }),
      );
      await this.sns.send(new DeleteEndpointCommand({ EndpointArn: input.endpointArn }));
    } catch {
      // A retirement that fails is retried the next time the token is rejected;
      // it must never turn a successful notification run into a batch failure.
    }
  }
}

/** Combines the SNS endpoint teardown with the device-row token removal. */
export class CompositeEndpointRegistry implements EndpointRegistry {
  constructor(
    private readonly disabler: SnsEndpointDisabler,
    private readonly tokens: Pick<EndpointRegistry, 'removeToken'>,
  ) {}

  async disableEndpoint(input: { endpointArn: string }): Promise<void> {
    await this.disabler.disableEndpoint(input);
  }

  async removeToken(input: Parameters<EndpointRegistry['removeToken']>[0]): Promise<void> {
    await this.tokens.removeToken(input);
  }
}
