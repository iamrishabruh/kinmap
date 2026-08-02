import { describe, expect, it } from 'vitest';

import {
  auditPartitionKey,
  auditSortKey,
  buildAuditRecord,
  parseAuditCommand,
  sanitizeCoarseArea,
  sanitizeMetadata,
  type AuditCommand,
} from '../src/records.js';

const ACTOR_ID = '11111111-1111-4111-8111-111111111111';
const TARGET_ID = '22222222-2222-4222-8222-222222222222';
const FAMILY_ID = '33333333-3333-4333-8333-333333333333';
const AUDIT_ID = '44444444-4444-4444-8444-444444444444';
const NOW = new Date('2026-06-01T12:00:00.000Z');

function command(overrides: Partial<AuditCommand> = {}): AuditCommand {
  return parseAuditCommand({
    auditId: AUDIT_ID,
    action: 'LOCATION_CURRENT_READ',
    actorUserId: ACTOR_ID,
    targetUserId: TARGET_ID,
    familyId: FAMILY_ID,
    metadata: {},
    occurredAt: '2026-06-01T11:59:00.000Z',
    requestId: 'req-1',
    sourceIpHash: 'sha256:abc',
    coarseArea: null,
    ...overrides,
  });
}

describe('sanitizeMetadata', () => {
  it('drops every key on the shared observability deny-list', () => {
    const clean = sanitizeMetadata({
      latitude: 37.7749,
      longitude: -122.4194,
      lat: 1.5,
      lng: 2.5,
      address: '1 Infinite Loop',
      email: 'someone@example.com',
      placeName: 'Home',
      familyName: 'The Smiths',
      freshness: 'FRESH',
    });

    expect(clean).toEqual({ freshness: 'FRESH' });
  });

  it('drops a coordinate hiding under an innocent key name', () => {
    const clean = sanitizeMetadata({
      value: 37.774929,
      note: '37.7749,-122.4194',
      pair: '(37.7749, -122.4194)',
      count: 3,
    });

    expect(clean).toEqual({ count: 3 });
  });

  it('keeps ordinary enums, counts and flags', () => {
    const clean = sanitizeMetadata({
      action: 'LOCATION_CURRENT_READ',
      resultCount: 12,
      cached: false,
      freshness: 'RECENT',
    });

    expect(clean).toEqual({
      action: 'LOCATION_CURRENT_READ',
      resultCount: 12,
      cached: false,
      freshness: 'RECENT',
    });
  });

  it('caps the number of entries and the length of a value', () => {
    const wide: Record<string, string> = {};
    for (let index = 0; index < 40; index += 1) wide[`key${String(index)}`] = 'value';
    expect(Object.keys(sanitizeMetadata(wide))).toHaveLength(20);

    expect(sanitizeMetadata({ note: 'x'.repeat(300) })).toEqual({});
  });

  it('drops a non-finite number rather than storing NaN', () => {
    expect(sanitizeMetadata({ ratio: Number.NaN, ok: 1 })).toEqual({ ok: 1 });
  });
});

describe('sanitizeCoarseArea', () => {
  it('accepts a geohash at or under the six-character cap', () => {
    expect(sanitizeCoarseArea('9q8yy')).toBe('9q8yy');
    expect(sanitizeCoarseArea('9q8yyk')).toBe('9q8yyk');
  });

  it('refuses anything more precise than the cap', () => {
    expect(sanitizeCoarseArea('9q8yykd')).toBeNull();
    expect(sanitizeCoarseArea('9q8yykdvr9')).toBeNull();
  });

  it('refuses a value that is not a geohash at all', () => {
    expect(sanitizeCoarseArea('37.77')).toBeNull();
    expect(sanitizeCoarseArea('AAAAA')).toBeNull();
    expect(sanitizeCoarseArea(null)).toBeNull();
  });
});

describe('buildAuditRecord', () => {
  it('files the event under the person who was looked at', () => {
    const record = buildAuditRecord({ command: command(), retentionDays: 365, now: NOW });

    expect(record.targetUserId).toBe(TARGET_ID);
    expect(record.actorUserId).toBe(ACTOR_ID);
    expect(record.sk).toBe(`2026-06-01T11:59:00.000Z#${AUDIT_ID}`);
  });

  it('files an event with no target under the actor, who may still read it', () => {
    const record = buildAuditRecord({
      command: command({ action: 'DEVICE_REGISTERED', targetUserId: null }),
      retentionDays: 365,
      now: NOW,
    });

    expect(record.targetUserId).toBe(ACTOR_ID);
    expect(record.subjectUserId).toBeNull();
  });

  it('sets a TTL measured from when the action happened', () => {
    const record = buildAuditRecord({ command: command(), retentionDays: 30, now: NOW });
    const occurred = Math.floor(Date.parse('2026-06-01T11:59:00.000Z') / 1000);

    expect(record.expiresAt).toBe(occurred + 30 * 24 * 3600);
  });

  it('never stores a coordinate, whatever the caller attached', () => {
    const record = buildAuditRecord({
      command: command({
        metadata: { latitude: 37.7749, longitude: -122.4194, freshness: 'LIVE' },
        coarseArea: '9q8yykdvr9',
      }),
      retentionDays: 365,
      now: NOW,
    });

    expect(record.metadata).toEqual({ freshness: 'LIVE' });
    expect(record.coarseArea).toBeNull();
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain('37.7749');
    expect(serialized).not.toContain('-122.4194');
  });

  it('produces sort keys that order chronologically', () => {
    const early = auditSortKey({ occurredAt: '2026-06-01T10:00:00.000Z', auditId: 'b' });
    const late = auditSortKey({ occurredAt: '2026-06-01T11:00:00.000Z', auditId: 'a' });

    expect([late, early].sort()).toEqual([early, late]);
  });

  it('rejects a command that is missing its required identifiers', () => {
    expect(() => parseAuditCommand({ action: 'LOCATION_CURRENT_READ' })).toThrow();
  });

  it('rejects an unknown key rather than silently dropping it', () => {
    expect(() =>
      parseAuditCommand({
        auditId: AUDIT_ID,
        action: 'LOCATION_CURRENT_READ',
        actorUserId: ACTOR_ID,
        targetUserId: TARGET_ID,
        familyId: FAMILY_ID,
        occurredAt: '2026-06-01T11:59:00.000Z',
        requestId: 'req-1',
        latitude: 37.7749,
      }),
    ).toThrow();
  });

  it('defaults the partition key helper to the target when one exists', () => {
    expect(auditPartitionKey(command())).toBe(TARGET_ID);
  });
});
