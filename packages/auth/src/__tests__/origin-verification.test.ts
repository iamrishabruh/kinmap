import { describe, expect, it } from 'vitest';

import { AppError } from '@family/contracts';

import { assertRequestCameThroughEdge, EDGE_VERIFICATION_HEADER } from '../origin-verification.js';

/**
 * The check that decides whether a request reached Lambda through the edge or
 * around it. Its failure modes are asymmetric: too strict takes the whole API
 * down, too lax silently reopens the WAF bypass it exists to close.
 */

const TOKEN = 'a-long-enough-edge-token-value';

describe('assertRequestCameThroughEdge', () => {
  it('allows a request carrying the token', () => {
    expect(() =>
      assertRequestCameThroughEdge({ [EDGE_VERIFICATION_HEADER]: TOKEN }, TOKEN),
    ).not.toThrow();
  });

  it('allows any request when no token is configured', () => {
    // Every test, every local invocation and every environment deployed before
    // the secret existed goes through this branch. Failing closed here would
    // turn one missing environment variable into a total outage.
    expect(() => assertRequestCameThroughEdge({}, undefined)).not.toThrow();
    expect(() => assertRequestCameThroughEdge({}, '')).not.toThrow();
  });

  it('refuses a request with no header once a token is configured', () => {
    expect(() => assertRequestCameThroughEdge({}, TOKEN)).toThrow(AppError);
  });

  it('refuses a wrong token', () => {
    expect(() =>
      assertRequestCameThroughEdge({ [EDGE_VERIFICATION_HEADER]: 'not-it' }, TOKEN),
    ).toThrow(AppError);
  });

  it('refuses a token that is only a prefix of the real one', () => {
    expect(() =>
      assertRequestCameThroughEdge({ [EDGE_VERIFICATION_HEADER]: TOKEN.slice(0, -1) }, TOKEN),
    ).toThrow(AppError);
  });

  it('reads the header whatever case it arrives in', () => {
    // API Gateway lower-cases header keys; a direct Lambda invocation does not.
    for (const key of ['X-Kinmap-Edge', 'X-KINMAP-EDGE', 'x-kinmap-edge']) {
      expect(() => assertRequestCameThroughEdge({ [key]: TOKEN }, TOKEN), key).not.toThrow();
    }
  });

  it('answers NOT_FOUND rather than FORBIDDEN', () => {
    // A caller probing for the origin hostname learns nothing from a 404: it
    // looks exactly like a host that serves nothing. FORBIDDEN would confirm
    // both that the host is live and that some header would satisfy it.
    const thrown = (() => {
      try {
        assertRequestCameThroughEdge({}, TOKEN);
      } catch (error) {
        return error;
      }
      return undefined;
    })();

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe('NOT_FOUND');
    expect((thrown as AppError).message).not.toMatch(/edge|header|token|origin/i);
  });

  it('tolerates absent headers entirely', () => {
    expect(() => assertRequestCameThroughEdge(null, TOKEN)).toThrow(AppError);
    expect(() => assertRequestCameThroughEdge(null, undefined)).not.toThrow();
  });

  it('never puts the expected token into the error', () => {
    const thrown = (() => {
      try {
        assertRequestCameThroughEdge({ [EDGE_VERIFICATION_HEADER]: 'wrong' }, TOKEN);
      } catch (error) {
        return error;
      }
      return undefined;
    })();

    expect(JSON.stringify(thrown) + String(thrown)).not.toContain(TOKEN);
  });
});
