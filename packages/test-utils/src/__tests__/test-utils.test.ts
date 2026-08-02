import { describe, expect, it } from 'vitest';

import { assertNoCoordinates, findCoordinates } from '../assertions.js';
import { createClock, MINUTE } from '../clock.js';
import {
  ConditionalCheckFailedException,
  DeleteCommand,
  GetCommand,
  InMemoryDocumentClient,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '../dynamo/client.js';
import { buildEventSequence, buildLocationEvent } from '../factories.js';
import { createSequence, userId } from '../ids.js';

/**
 * These helpers are what every other suite trusts. If assertNoCoordinates
 * silently returns for a leaking payload, every privacy test in the repository
 * becomes worthless — so it is tested harder than the code that uses it.
 */
describe('assertNoCoordinates', () => {
  it('finds a coordinate key at the top level', () => {
    expect(findCoordinates({ latitude: 37.7 })).toHaveLength(1);
  });

  it('finds coordinate keys nested arbitrarily deep', () => {
    const payload = { a: { b: { c: [{ d: { longitude: -122.4 } }] } } };
    const findings = findCoordinates(payload);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.path).toBe('a.b.c[0].d.longitude');
  });

  it('finds coordinate keys inside Maps and Sets', () => {
    expect(findCoordinates(new Map([['x', { lat: 1 }]]))).toHaveLength(1);
    expect(findCoordinates(new Set([{ coords: {} }]))).toHaveLength(1);
  });

  it('catches a coordinate pair embedded in a string', () => {
    expect(findCoordinates({ note: 'seen at 37.7793, -122.4193' })).toHaveLength(1);
  });

  it('catches a labelled coordinate in a string', () => {
    expect(findCoordinates({ q: 'lat=37.77931' })).toHaveLength(1);
  });

  it('ignores ordinary numbers that are not coordinates', () => {
    // Accuracy in metres, radii, versions and counts must not trip the check,
    // or teams will start disabling it.
    expect(findCoordinates({ accuracyMeters: 12.5, radius: 150, version: 2.1 })).toHaveLength(0);
  });

  it('does not flag keys that merely begin with a denied word', () => {
    expect(findCoordinates({ latencyMs: 12, positionalRank: 3 })).toHaveLength(0);
  });

  it('terminates on a cyclic structure', () => {
    const cyclic: Record<string, unknown> = { name: 'x' };
    cyclic.self = cyclic;
    expect(() => findCoordinates(cyclic)).not.toThrow();
  });

  it('throws with every offending path listed', () => {
    expect(() => assertNoCoordinates({ a: { lat: 1 }, b: { lng: 2 } }, 'payload')).toThrow(
      /payload leaked 2 coordinate/,
    );
  });

  it('passes a payload that only carries opaque identifiers', () => {
    expect(() =>
      assertNoCoordinates({ userId: userId(1), placeId: 'p-1', transition: 'ARRIVAL' }),
    ).not.toThrow();
  });
});

describe('createClock', () => {
  it('is deterministic and advances only when told to', () => {
    const clock = createClock('2026-01-01T00:00:00.000Z');
    const first = clock.nowMs();
    expect(clock.nowMs()).toBe(first);
    clock.advance(5 * MINUTE);
    expect(clock.nowMs()).toBe(first + 300_000);
  });
});

describe('factories', () => {
  it('produces ordered, monotonically sequenced events', () => {
    const events = buildEventSequence(4, { stepSeconds: 30 });
    expect(events.map((e) => e.sequenceNumber)).toEqual([0, 1, 2, 3]);
    const times = events.map((e) => Date.parse(e.capturedAt));
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('applies overrides', () => {
    expect(buildLocationEvent({ horizontalAccuracy: 900 }).horizontalAccuracy).toBe(900);
  });

  it('createSequence increments', () => {
    const next = createSequence(5);
    expect([next(), next(), next()]).toEqual([5, 6, 7]);
  });
});

describe('InMemoryDocumentClient', () => {
  const TABLE = 'CurrentLocations';
  const build = () =>
    new InMemoryDocumentClient([
      { name: TABLE, keySchema: { partitionKey: 'userId' } },
      { name: 'History', keySchema: { partitionKey: 'pk', sortKey: 'sk' } },
    ]);

  it('round-trips a put and get', async () => {
    const db = build();
    await db.send(PutCommand({ TableName: TABLE, Item: { userId: 'u1', capturedAt: 100 } }));
    const result = await db.send(GetCommand({ TableName: TABLE, Key: { userId: 'u1' } }));
    expect(result.Item).toMatchObject({ userId: 'u1', capturedAt: 100 });
  });

  it('enforces attribute_not_exists so a create cannot clobber', async () => {
    const db = build();
    await db.send(PutCommand({ TableName: TABLE, Item: { userId: 'u1' } }));
    await expect(
      db.send(
        PutCommand({
          TableName: TABLE,
          Item: { userId: 'u1' },
          ConditionExpression: 'attribute_not_exists(userId)',
        }),
      ),
    ).rejects.toBeInstanceOf(ConditionalCheckFailedException);
  });

  it('enforces a "only if newer" guard, so a late retry cannot regress a fix', async () => {
    // This is the exact condition location-ingestion relies on to keep an
    // out-of-order upload from overwriting a fresher position.
    const db = build();
    await db.send(PutCommand({ TableName: TABLE, Item: { userId: 'u1', capturedAt: 200 } }));

    await expect(
      db.send(
        PutCommand({
          TableName: TABLE,
          Item: { userId: 'u1', capturedAt: 100 },
          ConditionExpression: 'capturedAt < :incoming',
          ExpressionAttributeValues: { ':incoming': 100 },
        }),
      ),
    ).rejects.toBeInstanceOf(ConditionalCheckFailedException);

    const stored = await db.send(GetCommand({ TableName: TABLE, Key: { userId: 'u1' } }));
    expect((stored.Item as { capturedAt: number }).capturedAt).toBe(200);
  });

  it('applies SET and REMOVE update expressions', async () => {
    const db = build();
    await db.send(PutCommand({ TableName: TABLE, Item: { userId: 'u1', a: 1, b: 2 } }));
    await db.send(
      UpdateCommand({
        TableName: TABLE,
        Key: { userId: 'u1' },
        UpdateExpression: 'SET a = :a REMOVE b',
        ExpressionAttributeValues: { ':a': 9 },
      }),
    );
    const stored = (await db.send(GetCommand({ TableName: TABLE, Key: { userId: 'u1' } }))).Item;
    expect(stored).toMatchObject({ userId: 'u1', a: 9 });
    expect(stored).not.toHaveProperty('b');
  });

  it('rolls the whole transaction back when one condition fails', async () => {
    // The invitation flow depends on this: consuming a token and creating a
    // membership must be atomic, or a race could double-join a family.
    const db = build();
    await db.send(PutCommand({ TableName: TABLE, Item: { userId: 'consumed' } }));

    await expect(
      db.send(
        TransactWriteCommand({
          TransactItems: [
            { Put: { TableName: TABLE, Item: { userId: 'new-member' } } },
            {
              Put: {
                TableName: TABLE,
                Item: { userId: 'consumed' },
                ConditionExpression: 'attribute_not_exists(userId)',
              },
            },
          ],
        }),
      ),
    ).rejects.toThrow(/Transaction cancelled/);

    const orphan = await db.send(GetCommand({ TableName: TABLE, Key: { userId: 'new-member' } }));
    expect(orphan.Item).toBeUndefined();
  });

  it('queries a sort-key range in order', async () => {
    const db = build();
    for (const sk of ['TIME#3', 'TIME#1', 'TIME#2']) {
      await db.send(PutCommand({ TableName: 'History', Item: { pk: 'USER#1#DAY#x', sk } }));
    }
    const page = await db.send(
      QueryCommand({
        TableName: 'History',
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': 'USER#1#DAY#x' },
      }),
    );
    expect((page.Items as Array<{ sk: string }>).map((i) => i.sk)).toEqual([
      'TIME#1',
      'TIME#2',
      'TIME#3',
    ]);
  });

  it('paginates with a LastEvaluatedKey', async () => {
    const db = build();
    for (const sk of ['TIME#1', 'TIME#2', 'TIME#3']) {
      await db.send(PutCommand({ TableName: 'History', Item: { pk: 'p', sk } }));
    }
    const first = await db.send(
      QueryCommand({
        TableName: 'History',
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': 'p' },
        Limit: 2,
      }),
    );
    expect(first.Count).toBe(2);
    expect(first.LastEvaluatedKey).toBeDefined();

    const second = await db.send(
      QueryCommand({
        TableName: 'History',
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': 'p' },
        Limit: 2,
        ExclusiveStartKey: first.LastEvaluatedKey,
      }),
    );
    expect(second.Count).toBe(1);
  });

  it('deletes only when the condition holds', async () => {
    const db = build();
    await db.send(PutCommand({ TableName: TABLE, Item: { userId: 'u1', status: 'ACTIVE' } }));
    await expect(
      db.send(
        DeleteCommand({
          TableName: TABLE,
          Key: { userId: 'u1' },
          ConditionExpression: '#s = :s',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':s': 'REMOVED' },
        }),
      ),
    ).rejects.toBeInstanceOf(ConditionalCheckFailedException);
    expect(db.size(TABLE)).toBe(1);
  });

  it('isolates stored items from later mutation of the caller’s object', async () => {
    const db = build();
    const item: Record<string, unknown> = { userId: 'u1', nested: { value: 1 } };
    await db.send(PutCommand({ TableName: TABLE, Item: item }));
    (item.nested as { value: number }).value = 99;
    const stored = (await db.send(GetCommand({ TableName: TABLE, Key: { userId: 'u1' } }))).Item;
    expect((stored as { nested: { value: number } }).nested.value).toBe(1);
  });
});
