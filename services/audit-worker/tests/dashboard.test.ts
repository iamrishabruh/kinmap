import { describe, expect, it } from 'vitest';

import type { UserId } from '@family/contracts';
import { GetAuditLogQuerySchema } from '@family/schemas';

import {
  actorIdsToResolve,
  buildAuditLogResponse,
  decodeCursor,
  encodeCursor,
  planAuditQuery,
  toAuditLogEntry,
} from '../src/dashboard.js';
import { buildAuditRecord, parseAuditCommand, type AuditRecord } from '../src/records.js';

const CALLER_ID = '11111111-1111-4111-8111-111111111111' as UserId;
const OTHER_ID = '22222222-2222-4222-8222-222222222222' as UserId;
const FAMILY_ID = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-06-01T12:00:00.000Z');

function query(
  overrides: Record<string, unknown> = {},
): ReturnType<typeof GetAuditLogQuerySchema.parse> {
  return GetAuditLogQuerySchema.parse({ ...overrides });
}

function record(overrides: Partial<AuditRecord> = {}): AuditRecord {
  const base = buildAuditRecord({
    command: parseAuditCommand({
      auditId: '44444444-4444-4444-8444-444444444444',
      action: 'LOCATION_CURRENT_READ',
      actorUserId: OTHER_ID,
      targetUserId: CALLER_ID,
      familyId: FAMILY_ID,
      metadata: { freshness: 'LIVE' },
      occurredAt: '2026-06-01T11:00:00.000Z',
      requestId: 'req-1',
      sourceIpHash: 'sha256:abc',
      coarseArea: '9q8yy',
    }),
    retentionDays: 365,
    now: NOW,
  });
  return { ...base, ...overrides };
}

describe('planAuditQuery', () => {
  it('always partitions on the caller, with no request parameter to tamper with', () => {
    const plan = planAuditQuery({ callerUserId: CALLER_ID, query: query() });

    expect(plan.partitionKey).toBe(CALLER_ID);
    expect(plan.scanForward).toBe(false);
  });

  it('turns a date window into an inclusive sort-key range', () => {
    const plan = planAuditQuery({
      callerUserId: CALLER_ID,
      query: query({ from: '2026-05-01T00:00:00.000Z', to: '2026-06-01T00:00:00.000Z' }),
    });

    expect(plan.skFrom).toBe('2026-05-01T00:00:00.000Z#');
    // The upper bound sorts after every audit id for that instant.
    expect(plan.skTo?.startsWith('2026-06-01T00:00:00.000Z#')).toBe(true);
    expect(plan.skTo?.length).toBeGreaterThan('2026-06-01T00:00:00.000Z#'.length);
  });

  it('carries the action filter and the page size through', () => {
    const plan = planAuditQuery({
      callerUserId: CALLER_ID,
      query: query({ action: 'LOCATION_HISTORY_READ', limit: 25 }),
    });

    expect(plan.action).toBe('LOCATION_HISTORY_READ');
    expect(plan.limit).toBe(25);
  });

  it('defaults to no range when the caller asked for none', () => {
    const plan = planAuditQuery({ callerUserId: CALLER_ID, query: query() });

    expect(plan.skFrom).toBeNull();
    expect(plan.skTo).toBeNull();
    expect(plan.action).toBeNull();
  });
});

describe('pagination cursors', () => {
  it('round-trips a key belonging to the caller', () => {
    const cursor = encodeCursor({ targetUserId: CALLER_ID, sk: '2026-06-01T11:00:00.000Z#abc' });

    expect(decodeCursor(cursor, CALLER_ID)).toEqual({
      targetUserId: CALLER_ID,
      sk: '2026-06-01T11:00:00.000Z#abc',
    });
  });

  it('refuses a cursor pointing at somebody else´s partition', () => {
    const forged = encodeCursor({ targetUserId: OTHER_ID, sk: '2026-06-01T11:00:00.000Z#abc' });

    expect(decodeCursor(forged, CALLER_ID)).toBeNull();
  });

  it('refuses a malformed cursor instead of throwing', () => {
    expect(decodeCursor('not-base64-json', CALLER_ID)).toBeNull();
    expect(decodeCursor('', CALLER_ID)).toBeNull();
    expect(decodeCursor(null, CALLER_ID)).toBeNull();
  });

  it('drops a forged cursor from the plan entirely', () => {
    const forged = encodeCursor({ targetUserId: OTHER_ID, sk: 'x' });
    const plan = planAuditQuery({ callerUserId: CALLER_ID, query: query({ cursor: forged }) });

    expect(plan.exclusiveStartKey).toBeNull();
    expect(plan.partitionKey).toBe(CALLER_ID);
  });
});

describe('response projection', () => {
  it('exposes who looked and when, and nothing operator-facing', () => {
    const entry = toAuditLogEntry(record(), 'Ana');

    expect(entry.actorUserId).toBe(OTHER_ID);
    expect(entry.actorDisplayName).toBe('Ana');
    expect(entry.action).toBe('LOCATION_CURRENT_READ');
    expect(entry.coarseArea).toBe('9q8yy');
    expect(Object.keys(entry).sort()).toEqual([
      'action',
      'actorDisplayName',
      'actorUserId',
      'auditId',
      'coarseArea',
      'familyId',
      'occurredAt',
      'targetUserId',
    ]);
  });

  it('never leaks the request id, the ip hash or the metadata bag', () => {
    const serialized = JSON.stringify(toAuditLogEntry(record(), 'Ana'));

    expect(serialized).not.toContain('req-1');
    expect(serialized).not.toContain('sha256:abc');
    expect(serialized).not.toContain('freshness');
  });

  it('renders a page with an opaque cursor when there is more to read', () => {
    const response = buildAuditLogResponse({
      records: [record()],
      displayNames: new Map([[OTHER_ID, 'Ana']]),
      lastEvaluatedKey: { targetUserId: CALLER_ID, sk: '2026-06-01T11:00:00.000Z#abc' },
    });

    expect(response.entries).toHaveLength(1);
    expect(response.page.hasMore).toBe(true);
    expect(response.page.nextCursor).not.toBeNull();
    expect(decodeCursor(response.page.nextCursor, CALLER_ID)?.sk).toBe(
      '2026-06-01T11:00:00.000Z#abc',
    );
  });

  it('reports the end of the trail with no cursor', () => {
    const response = buildAuditLogResponse({
      records: [],
      displayNames: new Map(),
      lastEvaluatedKey: null,
    });

    expect(response.page).toEqual({ nextCursor: null, hasMore: false });
  });

  it('falls back to a null display name for an actor that no longer exists', () => {
    const response = buildAuditLogResponse({
      records: [record()],
      displayNames: new Map(),
      lastEvaluatedKey: null,
    });

    expect(response.entries[0]?.actorDisplayName).toBeNull();
  });

  it('deduplicates the actors whose names need resolving', () => {
    const ids = actorIdsToResolve([record(), record(), record({ actorUserId: CALLER_ID })]);

    expect(ids.sort()).toEqual([CALLER_ID, OTHER_ID].sort());
  });
});
