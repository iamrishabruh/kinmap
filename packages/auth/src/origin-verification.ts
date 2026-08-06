import { AppError } from '@family/contracts';

import type { HeaderSource } from './device-binding.js';

/**
 * Proof that a request came through the edge rather than around it.
 *
 * WHY THIS EXISTS. WAFv2 cannot attach to an API Gateway HTTP API, so the
 * WebACL lives on a CloudFront distribution and API Gateway answers on a
 * separate origin hostname behind it. That hostname resolves publicly — it has
 * to, for CloudFront to reach it — so anyone who finds it can skip the managed
 * rule groups and the IP rate limit entirely. Keeping the label out of the
 * repository raises the cost of finding it and is not a control.
 *
 * This is the control. CloudFront injects a shared secret as an origin request
 * header, and every service integrated with the API refuses a request that does
 * not carry it. The header cannot be forged from outside because a viewer's own
 * `x-kinmap-edge` is discarded: the origin request policy forwards the viewer's
 * headers, and CloudFront's custom origin headers OVERWRITE any header of the
 * same name rather than appending to it.
 *
 * WHAT IT IS NOT. It is not authentication and it is not authorisation. Every
 * route still requires a Cognito JWT and still authorises server-side against
 * family membership. This closes one specific hole: reaching Lambda without
 * passing WAF, whose cost is request volume and money rather than access.
 *
 * FAILING OPEN, DELIBERATELY. When no token is configured the check does
 * nothing. That is what lets a service run in a test, in a local invocation and
 * in an environment deployed before the secret existed, without every one of
 * them needing the shared secret. The risk of a silent misconfiguration is real,
 * and it is answered by a synth-time guard asserting that every API-integrated
 * function carries the variable — not by failing closed here, which would turn
 * one missing environment variable into a total outage.
 */

/** The header CloudFront sets. Lower-case: API Gateway normalises header keys. */
export const EDGE_VERIFICATION_HEADER = 'x-kinmap-edge';

/** The environment variable each service reads the expected value from. */
export const EDGE_VERIFICATION_ENV = 'EDGE_VERIFICATION_TOKEN';

/**
 * Constant-time comparison.
 *
 * `===` on a secret leaks its prefix through timing. The margin is small over a
 * network, but the whole value of this token is that it cannot be guessed, and
 * a cheap constant-time compare costs nothing to write.
 */
function equalsInConstantTime(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
}

/**
 * Throws unless the request carries the edge token, or none is configured.
 *
 * The error is deliberately `NOT_FOUND` rather than `FORBIDDEN`. A caller who
 * has found the origin hostname learns nothing from a 404: it looks exactly
 * like a hostname that serves nothing, which is the least useful answer to give
 * somebody probing for a way around the edge. `FORBIDDEN` would confirm both
 * that the host is live and that a header would satisfy it.
 */
export function assertRequestCameThroughEdge(
  headers: HeaderSource,
  expected: string | undefined = process.env[EDGE_VERIFICATION_ENV],
): void {
  if (expected === undefined || expected.length === 0) {
    return;
  }

  const presented = headerOf(headers, EDGE_VERIFICATION_HEADER);
  if (presented !== undefined && equalsInConstantTime(presented, expected)) {
    return;
  }

  throw new AppError('NOT_FOUND', 'The requested resource does not exist.');
}

/** Case-insensitive header read; API Gateway and Lambda disagree on casing. */
function headerOf(headers: HeaderSource, name: string): string | undefined {
  if (headers === null || headers === undefined) {
    return undefined;
  }
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target && typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return undefined;
}
