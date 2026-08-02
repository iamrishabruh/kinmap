import { describe, expect, it, vi } from 'vitest';

import { createLogger, createMemorySink } from './logger.js';
import {
  CoordinateLeakError,
  MetricValidationError,
  buildEmfPayload,
  createMetrics,
  putMetric,
} from './metrics.js';
import { buildSentryBeforeBreadcrumb, buildSentryBeforeSend } from './sentry.js';
import { sanitizeAttributes, withSpan, type SpanLike, type TracerLike } from './tracing.js';

const LAT = 37.774929;
const LNG = -122.419418;

describe('createLogger', () => {
  it('emits one JSON object per record carrying level, service, env and requestId', () => {
    const { sink, lines } = createMemorySink();
    const logger = createLogger({
      service: 'location-api',
      env: 'staging',
      requestId: 'req-42',
      sink,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });

    logger.info('batch.accepted', { acceptedCount: 12 });

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toEqual({
      level: 'info',
      time: '2026-01-01T00:00:00.000Z',
      service: 'location-api',
      env: 'staging',
      message: 'batch.accepted',
      requestId: 'req-42',
      acceptedCount: 12,
    });
  });

  it('drops records below the configured level', () => {
    const { sink, records } = createMemorySink();
    const logger = createLogger({ service: 's', env: 'production', sink });

    logger.debug('noisy');
    logger.info('kept');

    expect(records.map((record) => record.message)).toEqual(['kept']);
  });

  it('redacts context, bindings and the message itself', () => {
    const { sink, lines } = createMemorySink();
    const logger = createLogger({
      service: 's',
      env: 'development',
      sink,
      bindings: { deviceId: 'device-1', accessToken: 'secret-value' },
    });

    logger.warn(`fix rejected near ${LAT},${LNG}`, {
      reason: 'ACCURACY',
      event: { eventId: 'e1', latitude: LAT, longitude: LNG },
    });

    const line = lines[0] as string;
    expect(line).not.toContain('37.774');
    expect(line).not.toContain('122.419');
    expect(line).not.toContain('secret-value');
    expect(line).not.toContain('"latitude"');
    expect(line).toContain('"deviceId":"device-1"');
    expect(line).toContain('"reason":"ACCURACY"');
    expect(line).toContain('"eventId":"e1"');
  });

  it('child() inherits bindings and withRequestId() stamps every record', () => {
    const { sink, records } = createMemorySink();
    const root = createLogger({ service: 's', env: 'development', sink, bindings: { a: 1 } });

    root.child({ b: 2 }).withRequestId('req-9').info('hello');

    expect(records[0]).toMatchObject({ a: 1, b: 2, requestId: 'req-9', message: 'hello' });
    // The parent is untouched.
    root.info('again');
    expect(records[1]).not.toHaveProperty('b');
    expect(records[1]).not.toHaveProperty('requestId');
  });
});

describe('putMetric', () => {
  it('builds an EMF document with the value keyed by the metric name', () => {
    const payload = buildEmfPayload({
      namespace: 'FamilyLocation/Ingestion',
      name: 'EventsAccepted',
      value: 12,
      unit: 'Count',
      dimensions: { Env: 'staging', Outcome: 'ACCEPTED' },
      timestamp: 1_767_225_600_000,
    });

    expect(payload._aws.Timestamp).toBe(1_767_225_600_000);
    expect(payload._aws.CloudWatchMetrics[0]).toEqual({
      Namespace: 'FamilyLocation/Ingestion',
      Dimensions: [['Env', 'Outcome']],
      Metrics: [{ Name: 'EventsAccepted', Unit: 'Count' }],
    });
    expect(payload.EventsAccepted).toBe(12);
    expect(payload.Env).toBe('staging');
  });

  it('rejects a dimension value that looks like a coordinate', () => {
    expect(() =>
      buildEmfPayload({
        namespace: 'N',
        name: 'M',
        value: 1,
        dimensions: { Place: String(LAT) },
      }),
    ).toThrow(CoordinateLeakError);

    expect(() =>
      buildEmfPayload({
        namespace: 'N',
        name: 'M',
        value: 1,
        dimensions: { Place: `${LAT},${LNG}` },
      }),
    ).toThrow(CoordinateLeakError);

    expect(() =>
      buildEmfPayload({ namespace: 'N', name: 'M', value: 1, dimensions: { Fix: LAT } }),
    ).toThrow(CoordinateLeakError);
  });

  it('rejects a dimension named after a denied key', () => {
    expect(() =>
      buildEmfPayload({ namespace: 'N', name: 'M', value: 1, dimensions: { latitude: 'x' } }),
    ).toThrow(CoordinateLeakError);
    expect(() =>
      buildEmfPayload({ namespace: 'N', name: 'M', value: 1, dimensions: { access_token: 'x' } }),
    ).toThrow(CoordinateLeakError);
  });

  it('allows coarse, low-cardinality dimensions', () => {
    const payload = buildEmfPayload({
      namespace: 'N',
      name: 'M',
      value: 1,
      dimensions: { Geohash: '9q8yy', Bucket: 'FRESH', Retries: 3, Cold: true },
    });
    expect(payload.Geohash).toBe('9q8yy');
    expect(payload.Retries).toBe('3');
  });

  it('rejects non-finite values', () => {
    expect(() => buildEmfPayload({ namespace: 'N', name: 'M', value: Number.NaN })).toThrow(
      MetricValidationError,
    );
  });

  it('redacts non-dimensional properties instead of throwing', () => {
    const payload = buildEmfPayload({
      namespace: 'N',
      name: 'M',
      value: 1,
      properties: { requestId: 'req-1', latitude: LAT },
    });
    expect(payload.requestId).toBe('req-1');
    expect(payload).not.toHaveProperty('latitude');
  });

  it('writes through the provided sink', () => {
    const sink = vi.fn();
    putMetric({ namespace: 'N', name: 'M', value: 2 }, sink);
    expect(sink).toHaveBeenCalledTimes(1);
    expect(JSON.parse(sink.mock.calls[0]?.[1] as string).M).toBe(2);
  });

  it('createMetrics merges default dimensions', () => {
    const sink = vi.fn();
    const metrics = createMetrics({ namespace: 'N', dimensions: { Env: 'test' }, sink });
    metrics.count('Uploads', 1, { Outcome: 'OK' });

    const payload = sink.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.Env).toBe('test');
    expect(payload.Outcome).toBe('OK');
    expect(payload.Uploads).toBe(1);
  });
});

describe('tracing', () => {
  function fakeTracer(): {
    tracer: TracerLike;
    spans: Array<{ name: string; attributes: unknown }>;
  } {
    const spans: Array<{ name: string; attributes: unknown }> = [];
    const tracer: TracerLike = {
      startSpan: (name, options) => {
        // Annotated so recordException below can widen it beyond SpanAttributes.
        const record: { name: string; attributes: unknown } = {
          name,
          attributes: options?.attributes,
        };
        spans.push(record);
        const span: SpanLike = {
          setAttribute: () => undefined,
          setAttributes: () => undefined,
          setStatus: () => undefined,
          recordException: (exception) => {
            record.attributes = { ...(record.attributes as object), exception };
          },
          end: () => undefined,
        };
        return span;
      },
    };
    return { tracer, spans };
  }

  it('drops denied and coordinate-shaped attributes', () => {
    expect(
      sanitizeAttributes({
        'family.id': 'fam-1',
        latitude: LAT,
        // Dotted OTel-style keys still normalise onto the deny-list.
        'place.name': 'Home',
        'geo.point': `${LAT},${LNG}`,
        'place.category': 'HOME',
        'http.status': 200,
        'accuracy.m': 12,
      }),
    ).toEqual({
      'family.id': 'fam-1',
      'place.category': 'HOME',
      'http.status': 200,
      'accuracy.m': 12,
    });
  });

  it('drops an array attribute if any element looks like a coordinate', () => {
    expect(sanitizeAttributes({ points: [String(LAT), 'a'] })).toEqual({});
    expect(sanitizeAttributes({ tags: ['a', 'b'] })).toEqual({ tags: ['a', 'b'] });
  });

  it('withSpan sanitises attributes and scrubs a thrown message', async () => {
    const { tracer, spans } = fakeTracer();

    await expect(
      withSpan(tracer, 'ingest', { latitude: LAT, 'family.id': 'fam-1' }, () => {
        throw new Error(`bad fix at ${LAT},${LNG}`);
      }),
    ).rejects.toThrow();

    expect(spans[0]?.name).toBe('ingest');
    const serialized = JSON.stringify(spans[0]?.attributes);
    expect(serialized).not.toContain('37.774');
    expect(serialized).not.toContain('122.419');
    expect(serialized).toContain('fam-1');
  });
});

describe('sentry scrubbers', () => {
  it('scrubs extra, tags, user, request, breadcrumbs and exception values', () => {
    const beforeSend = buildSentryBeforeSend();

    const event = beforeSend({
      event_id: 'abc',
      message: `upload failed at ${LAT},${LNG}`,
      tags: { placeName: 'Home', route: 'POST /v1/locations' },
      extra: {
        payload: { events: [{ eventId: 'e1', latitude: LAT, longitude: LNG }] },
        attempt: 2,
      },
      user: { id: 'user-1', email: 'someone@example.com', ip_address: '10.0.0.1' },
      request: {
        method: 'POST',
        url: 'https://api.example.com/v1/families/fam-1/locations?token=abc',
        headers: { authorization: 'Bearer abc', 'x-request-id': 'req-1' },
        data: { latitude: LAT },
      },
      breadcrumbs: [
        { category: 'fetch', message: 'GET /current', data: { url: 'https://x/y?token=t' } },
        { category: 'console', message: `coords ${LAT},${LNG}` },
      ],
      exception: { values: [{ type: 'Error', value: `no fix near ${LAT},${LNG}` }] },
    });

    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain('37.774');
    expect(serialized).not.toContain('122.419');
    expect(serialized).not.toContain('someone@example.com');
    expect(serialized).not.toContain('Bearer abc');
    expect(serialized).not.toContain('token=abc');
    expect(serialized).not.toContain('placeName');

    expect(event?.user).toEqual({ id: 'user-1' });
    expect(event?.tags).toEqual({ route: 'POST /v1/locations' });
    expect(event?.extra?.attempt).toBe(2);
    // console breadcrumbs are dropped wholesale.
    expect(event?.breadcrumbs).toHaveLength(1);
    expect(event?.exception?.values?.[0]?.type).toBe('Error');
  });

  it('shares the deny-list with the logger', () => {
    const beforeSend = buildSentryBeforeSend();
    const event = beforeSend({ extra: { inviteToken: 'i-123', familyName: 'Chouhan', ok: true } });

    expect(event?.extra).toEqual({ ok: true });
  });

  it('fails closed when scrubbing throws', () => {
    const beforeSend = buildSentryBeforeSend();
    const hostile = {
      get tags(): Record<string, unknown> {
        throw new Error('boom');
      },
    } as unknown as Parameters<typeof beforeSend>[0];

    expect(beforeSend(hostile)).toBeNull();
  });

  it('drops console breadcrumbs and strips URLs from the rest', () => {
    const beforeBreadcrumb = buildSentryBeforeBreadcrumb();

    expect(beforeBreadcrumb({ category: 'console', message: 'anything' })).toBeNull();

    const crumb = beforeBreadcrumb({
      category: 'xhr',
      message: 'request',
      data: { url: 'https://api/x?lat=37.7&lng=-122.4', status: 200 },
    });
    expect(JSON.stringify(crumb)).not.toContain('lat=');
    expect(crumb?.data?.status).toBe(200);
  });
});
