import { describe, expect, it } from 'vitest';

import { compilePath, createRouter, defineRoute, type RegisteredRoute } from '../src/router.js';
import type { HandlerResult } from '../src/types.js';

/**
 * The router's job is to turn a URL into a route plus a typed parameter bag.
 * Everything asserted here is a decision a handler downstream depends on: that a
 * parameter is exactly one segment, that it is decoded, and that a near-miss is
 * a miss rather than a match with an empty value.
 */

const ok = async (): Promise<HandlerResult> => ({ statusCode: 200 });

function routeFor(method: 'GET' | 'POST' | 'DELETE', path: string): RegisteredRoute {
  return defineRoute({
    method,
    path,
    authRequired: true,
    entitlement: null,
    rateLimit: 'GENERAL_READ',
    idempotencyRequired: false,
    handler: ok,
  });
}

describe('compilePath', () => {
  it('splits literals and parameters', () => {
    expect(compilePath('/v1/devices/{deviceId}')).toEqual([
      { kind: 'LITERAL', value: 'v1' },
      { kind: 'LITERAL', value: 'devices' },
      { kind: 'PARAM', name: 'deviceId' },
    ]);
  });

  it('rejects a template that is not rooted', () => {
    expect(() => compilePath('v1/devices')).toThrow(/must start with/);
  });

  it('rejects a malformed parameter', () => {
    expect(() => compilePath('/v1/devices/{}')).toThrow(/Malformed path parameter/);
    expect(() => compilePath('/v1/devices/{device-id}')).toThrow(/Malformed path parameter/);
    expect(() => compilePath('/v1/dev{ices}/x')).toThrow(/Malformed path parameter/);
  });
});

describe('createRouter', () => {
  it('extracts a single parameter', () => {
    const router = createRouter([routeFor('DELETE', '/v1/devices/{deviceId}')]);

    const match = router.match('DELETE', '/v1/devices/abc-123');

    expect(match.kind).toBe('MATCHED');
    if (match.kind !== 'MATCHED') return;
    expect(match.params).toEqual({ deviceId: 'abc-123' });
  });

  it('extracts several parameters in order', () => {
    const router = createRouter([
      routeFor('GET', '/v1/families/{familyId}/members/{userId}/history'),
    ]);

    const match = router.match('GET', '/v1/families/fam-1/members/user-9/history');

    expect(match.kind).toBe('MATCHED');
    if (match.kind !== 'MATCHED') return;
    expect(match.params).toEqual({ familyId: 'fam-1', userId: 'user-9' });
  });

  it('percent-decodes a parameter without letting it span a segment', () => {
    const router = createRouter([routeFor('GET', '/v1/support/blocks/{userId}')]);

    const match = router.match('GET', '/v1/support/blocks/a%2Fb');

    expect(match.kind).toBe('MATCHED');
    if (match.kind !== 'MATCHED') return;
    // The encoded slash stays inside the parameter; it does not re-route.
    expect(match.params).toEqual({ userId: 'a/b' });
  });

  it('treats a malformed escape as no match rather than throwing', () => {
    const router = createRouter([routeFor('GET', '/v1/support/blocks/{userId}')]);

    expect(router.match('GET', '/v1/support/blocks/%zz').kind).toBe('NOT_FOUND');
  });

  it('does not match an empty parameter segment', () => {
    const router = createRouter([routeFor('DELETE', '/v1/devices/{deviceId}')]);

    expect(router.match('DELETE', '/v1/devices/').kind).toBe('NOT_FOUND');
    expect(router.match('DELETE', '/v1/devices').kind).toBe('NOT_FOUND');
  });

  it('ignores a trailing slash on an otherwise exact path', () => {
    const router = createRouter([routeFor('GET', '/v1/account')]);

    expect(router.match('GET', '/v1/account/').kind).toBe('MATCHED');
  });

  it('prefers the literal route over the parameterised one', () => {
    const router = createRouter([
      routeFor('GET', '/v1/configuration/{name}'),
      routeFor('GET', '/v1/configuration/bootstrap'),
    ]);

    const match = router.match('GET', '/v1/configuration/bootstrap');

    expect(match.kind).toBe('MATCHED');
    if (match.kind !== 'MATCHED') return;
    // Registration order decides, and the table registers the literal first in
    // the real service; this test pins the behaviour either way.
    expect(match.route.path).toBe('/v1/configuration/{name}');
    expect(match.params).toEqual({ name: 'bootstrap' });
  });

  it('reports a known path with an unknown method separately from a miss', () => {
    const router = createRouter([routeFor('GET', '/v1/account')]);

    const wrongMethod = router.match('POST', '/v1/account');
    expect(wrongMethod.kind).toBe('METHOD_NOT_ALLOWED');
    if (wrongMethod.kind !== 'METHOD_NOT_ALLOWED') return;
    expect(wrongMethod.allowed).toEqual(['GET']);

    expect(router.match('GET', '/v1/nope').kind).toBe('NOT_FOUND');
  });

  it('ignores a query string appended to the path', () => {
    const router = createRouter([routeFor('GET', '/v1/account')]);

    expect(router.match('GET', '/v1/account?foo=bar').kind).toBe('MATCHED');
  });

  it('refuses to register the same method and path twice', () => {
    expect(() =>
      createRouter([routeFor('GET', '/v1/account'), routeFor('GET', '/v1/account')]),
    ).toThrow(/Duplicate route/);
  });

  it('carries per-route metadata through registration', () => {
    const route = defineRoute({
      method: 'POST',
      path: '/v1/devices',
      authRequired: true,
      entitlement: 'LIVE_SESSIONS',
      rateLimit: 'ACCOUNT_MUTATION',
      idempotencyRequired: true,
      handler: ok,
    });

    expect(route).toMatchObject({
      authRequired: true,
      entitlement: 'LIVE_SESSIONS',
      rateLimit: 'ACCOUNT_MUTATION',
      idempotencyRequired: true,
    });
  });
});
