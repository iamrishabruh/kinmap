import { vi } from 'vitest';

/**
 * A stand-in for the network.
 *
 * Requests are captured so a test can assert what was sent — which matters
 * more here than usual: several of the properties this feature has to hold are
 * about what does NOT appear on the wire.
 */

export type CapturedRequest = {
  readonly url: string;
  readonly target: string;
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly json: Record<string, unknown>;
  readonly form: Record<string, string>;
};

export type StubbedResponse = {
  readonly status?: number;
  readonly body?: unknown;
  /** Throw instead of responding, the way a dead connection does. */
  readonly transportFailure?: boolean;
};

export type FetchHarness = {
  readonly requests: CapturedRequest[];
  /** Every `X-Amz-Target` action seen, in order. */
  actions(): string[];
  restore(): void;
};

function parseForm(body: string): Record<string, string> {
  const values: Record<string, string> = {};
  if (!body.includes('=')) return values;
  for (const pair of body.split('&')) {
    const equals = pair.indexOf('=');
    if (equals < 0) continue;
    values[decodeURIComponent(pair.slice(0, equals))] = decodeURIComponent(
      pair.slice(equals + 1).replace(/\+/gu, ' '),
    );
  }
  return values;
}

export function installFetch(
  respond: (request: CapturedRequest, index: number) => StubbedResponse | Promise<StubbedResponse>,
): FetchHarness {
  const requests: CapturedRequest[] = [];
  const original = globalThis.fetch;

  const stub = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = typeof init?.body === 'string' ? init.body : '';
    const json = ((): Record<string, unknown> => {
      try {
        const parsed: unknown = body.length > 0 ? JSON.parse(body) : {};
        return typeof parsed === 'object' && parsed !== null
          ? (parsed as Record<string, unknown>)
          : {};
      } catch {
        return {};
      }
    })();

    const captured: CapturedRequest = {
      url: String(input),
      target: (headers['X-Amz-Target'] ?? '').split('.').pop() ?? '',
      headers,
      body,
      json,
      form: parseForm(body),
    };
    requests.push(captured);

    const stubbed = await respond(captured, requests.length - 1);
    if (stubbed.transportFailure === true) {
      throw new TypeError('Network request failed');
    }
    const status = stubbed.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => stubbed.body ?? {},
    } as unknown as Response;
  });

  globalThis.fetch = stub as unknown as typeof fetch;

  return {
    requests,
    actions: () => requests.map((request) => request.target).filter((target) => target.length > 0),
    restore: () => {
      globalThis.fetch = original;
    },
  };
}
