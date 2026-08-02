import { describe, expect, it } from 'vitest';

import { LIMITS } from '@family/contracts';

import {
  invitationDeadlineMs,
  isDeviceLive,
  isJobName,
  isLiveSessionExpired,
  isStaleEligible,
  JOB_NAMES,
  limitBatch,
  liveSessionDeadlineMs,
  parseInstantMs,
  planEndpointReconciliation,
  planHistorySweep,
  planStaleMarking,
  queueNameFromUrl,
  retentionCutoffDay,
  selectExpiredInvitations,
  selectExpiredLiveSessions,
  shouldMarkStale,
  summarise,
  type CurrentLocationRow,
  type DeviceEndpointRef,
  type HistoryRow,
  type InvitationRow,
  type LiveSessionRow,
} from '../src/jobs.js';

const NOW = Date.parse('2026-06-01T12:00:00.000Z');
const at = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString();

const userId = '00000000-0000-4000-8000-000000000001' as never;
const deviceId = '00000000-0000-4000-8000-000000000002' as never;
const familyId = '00000000-0000-4000-8000-000000000003' as never;

describe('job registry', () => {
  it('accepts every declared job and rejects anything else', () => {
    for (const name of JOB_NAMES) expect(isJobName(name)).toBe(true);
    expect(isJobName('expire-everything')).toBe(false);
    expect(isJobName(undefined)).toBe(false);
  });
});

describe('parseInstantMs', () => {
  it('reads epoch seconds and milliseconds without confusing them', () => {
    // A 1000x error here would be a 1000x error in a deadline.
    expect(parseInstantMs(1_780_000_000)).toBe(1_780_000_000_000);
    expect(parseInstantMs(1_780_000_000_000)).toBe(1_780_000_000_000);
  });

  it('reads ISO strings and rejects junk', () => {
    expect(parseInstantMs('2026-06-01T12:00:00.000Z')).toBe(NOW);
    expect(parseInstantMs('whenever')).toBeNull();
    expect(parseInstantMs(null)).toBeNull();
    expect(parseInstantMs(0)).toBeNull();
  });
});

describe('live session expiry', () => {
  const open: LiveSessionRow = {
    sessionId: 's1',
    targetUserId: userId,
    status: 'ACTIVE',
    startedAt: at(-60_000),
    expiresAt: at(60_000),
  };

  it('leaves a session that is still within its deadline', () => {
    expect(isLiveSessionExpired(open, NOW)).toBe(false);
  });

  it('expires a session past its deadline', () => {
    expect(isLiveSessionExpired({ ...open, expiresAt: at(-1) }, NOW)).toBe(true);
  });

  it('ignores a session that is already closed', () => {
    expect(isLiveSessionExpired({ ...open, status: 'STOPPED', expiresAt: at(-1) }, NOW)).toBe(
      false,
    );
  });

  it('lets the platform ceiling override a longer stored deadline', () => {
    // A row claiming a longer window is a bug or tampering; either way it must
    // not buy extra minutes of watching someone.
    const forged: LiveSessionRow = {
      ...open,
      startedAt: at(-(LIMITS.MAX_LIVE_SESSION_SECONDS * 1000 + 1000)),
      expiresAt: at(86_400_000),
    };
    expect(isLiveSessionExpired(forged, NOW)).toBe(true);
    expect(liveSessionDeadlineMs(forged)).toBeLessThan(NOW);
  });

  it('fails closed on an undateable session', () => {
    // Nobody can say when it ends, so it ends now.
    expect(isLiveSessionExpired({ ...open, startedAt: null, expiresAt: null }, NOW)).toBe(true);
  });

  it('is idempotent — expiring the selection again selects nothing', () => {
    const rows = [{ ...open, expiresAt: at(-1) }];
    const first = selectExpiredLiveSessions(rows, NOW);
    expect(first).toHaveLength(1);
    const applied = first.map((row) => ({ ...row, status: 'EXPIRED' }));
    expect(selectExpiredLiveSessions(applied, NOW)).toHaveLength(0);
  });
});

describe('invitation expiry', () => {
  const pending: InvitationRow = {
    tokenHash: 'a'.repeat(64),
    familyId,
    status: 'PENDING',
    createdAt: at(-3_600_000),
    expiresAt: at(3_600_000),
  };

  it('expires only pending invitations past their deadline', () => {
    expect(selectExpiredInvitations([{ ...pending, expiresAt: at(-1) }], NOW)).toHaveLength(1);
    expect(selectExpiredInvitations([pending], NOW)).toHaveLength(0);
    expect(
      selectExpiredInvitations([{ ...pending, status: 'ACCEPTED', expiresAt: at(-1) }], NOW),
    ).toHaveLength(0);
  });

  it('caps an over-long stored deadline at the invitation TTL', () => {
    // An invitation is a bearer credential to see where a family is; its
    // lifetime is not negotiable by the row itself.
    const forged = { ...pending, expiresAt: at(365 * 86_400_000) };
    const deadline = invitationDeadlineMs(forged);
    expect(deadline).not.toBeNull();
    expect(deadline!).toBeLessThanOrEqual(
      Date.parse(pending.createdAt!) + LIMITS.INVITATION_TTL_HOURS * 3_600_000,
    );
  });

  it('fails closed on an undateable invitation', () => {
    expect(
      selectExpiredInvitations([{ ...pending, createdAt: null, expiresAt: null }], NOW),
    ).toHaveLength(1);
  });
});

describe('stale marking', () => {
  const row: CurrentLocationRow = {
    userId,
    deviceId,
    capturedAt: at(-60_000),
    trackingState: 'PASSIVE',
  };

  it('does not mark a recent fix', () => {
    expect(shouldMarkStale(row, NOW)).toBe(false);
  });

  it('marks a fix older than the freshness horizon', () => {
    expect(shouldMarkStale({ ...row, capturedAt: at(-4 * 3_600_000) }, NOW)).toBe(true);
  });

  it('never overwrites DISABLED or PERMISSION_REQUIRED with STALE', () => {
    // Those states tell the viewer the real reason there is no fix; STALE would
    // replace an actionable message with a misleading one.
    expect(isStaleEligible('DISABLED')).toBe(false);
    expect(isStaleEligible('PERMISSION_REQUIRED')).toBe(false);
    for (const state of ['DISABLED', 'PERMISSION_REQUIRED'] as const) {
      expect(shouldMarkStale({ ...row, trackingState: state, capturedAt: at(-9e6) }, NOW)).toBe(
        false,
      );
    }
  });

  it('treats an undateable fix as stale rather than fresh', () => {
    // A confident dot backed by nothing is the worst outcome for a viewer.
    expect(shouldMarkStale({ ...row, capturedAt: null }, NOW)).toBe(true);
  });

  it('is idempotent', () => {
    expect(shouldMarkStale({ ...row, trackingState: 'STALE', capturedAt: at(-9e6) }, NOW)).toBe(
      false,
    );
  });

  it('tallies a freshness histogram with no per-user dimension', () => {
    const plan = planStaleMarking({
      rows: [row, { ...row, capturedAt: at(-4 * 3_600_000) }],
      nowMs: NOW,
    });
    expect(plan.scanned).toBe(2);
    expect(plan.mark).toHaveLength(1);
    expect(Object.values(plan.freshness).reduce((a, b) => a + b, 0)).toBe(2);
  });
});

describe('history sweep', () => {
  const row = (pk: string, expiresAt: number | null): HistoryRow => ({
    pk,
    sk: 'TIME#2026-01-01T00:00:00.000Z#EVENT#e1',
    expiresAt,
  });

  it('deletes partitions older than the retention window', () => {
    const plan = planHistorySweep({
      rows: [row('USER#u1#DAY#2026-01-01', null), row('USER#u1#DAY#2026-05-31', null)],
      now: new Date(NOW),
      retentionDays: LIMITS.HISTORY_RETENTION_DAYS,
    });
    expect(plan.delete).toHaveLength(1);
    expect(plan.delete[0]?.pk).toBe('USER#u1#DAY#2026-01-01');
  });

  it('never deletes a row whose key it cannot parse', () => {
    // Deleting data we cannot identify is a worse failure than keeping it.
    const plan = planHistorySweep({
      rows: [row('GARBAGE', null)],
      now: new Date(NOW),
      retentionDays: 30,
    });
    expect(plan.delete).toHaveLength(0);
    expect(plan.unparseable).toBe(1);
  });

  it('still deletes an unparseable row whose TTL is overdue', () => {
    const plan = planHistorySweep({
      rows: [row('GARBAGE', Math.floor(NOW / 1000) - 60)],
      now: new Date(NOW),
      retentionDays: 30,
    });
    expect(plan.delete).toHaveLength(1);
  });

  it('computes a retention cutoff day', () => {
    expect(retentionCutoffDay({ now: new Date(NOW), retentionDays: 30 })).toMatch(
      /^\d{4}-\d{2}-\d{2}$/,
    );
  });
});

describe('push endpoint reconciliation', () => {
  const device: DeviceEndpointRef = {
    userId,
    deviceId,
    pushEndpointArn: 'arn:aws:sns:us-east-1:000000000000:endpoint/APNS/kinmap/abc',
    status: 'ACTIVE',
    revokedAt: null,
  };

  it('keeps an enabled endpoint claimed by a live device', () => {
    const plan = planEndpointReconciliation({
      devices: [device],
      endpoints: [{ endpointArn: device.pushEndpointArn!, enabled: true }],
    });
    expect(plan.deleteEndpoints).toHaveLength(0);
  });

  it('deletes an endpoint whose device was revoked', () => {
    // An endpoint outliving its device is a live push channel to a phone whose
    // owner believes they revoked it.
    const plan = planEndpointReconciliation({
      devices: [{ ...device, status: 'REVOKED' }],
      endpoints: [{ endpointArn: device.pushEndpointArn!, enabled: true }],
    });
    expect(plan.deleteEndpoints).toEqual([device.pushEndpointArn]);
  });

  it('deletes an endpoint no device claims at all', () => {
    const plan = planEndpointReconciliation({
      devices: [],
      endpoints: [{ endpointArn: 'arn:orphan', enabled: true }],
    });
    expect(plan.deleteEndpoints).toEqual(['arn:orphan']);
  });

  it('clears a device row pointing at a disabled endpoint', () => {
    const plan = planEndpointReconciliation({
      devices: [device],
      endpoints: [{ endpointArn: device.pushEndpointArn!, enabled: false }],
    });
    expect(plan.deleteEndpoints).toContain(device.pushEndpointArn);
    expect(plan.clearDevices).toHaveLength(1);
  });

  it('treats a revokedAt timestamp as not-live', () => {
    expect(isDeviceLive({ status: 'ACTIVE', revokedAt: at(-1000) })).toBe(false);
    expect(isDeviceLive({ status: 'ACTIVE', revokedAt: null })).toBe(true);
  });

  it('is idempotent — re-planning against the applied result proposes nothing', () => {
    const plan = planEndpointReconciliation({
      devices: [{ ...device, status: 'REVOKED' }],
      endpoints: [{ endpointArn: device.pushEndpointArn!, enabled: true }],
    });
    expect(plan.deleteEndpoints).toHaveLength(1);
    const after = planEndpointReconciliation({
      devices: [{ ...device, status: 'REVOKED', pushEndpointArn: null }],
      endpoints: [],
    });
    expect(after.deleteEndpoints).toHaveLength(0);
    expect(after.clearDevices).toHaveLength(0);
  });
});

describe('helpers', () => {
  it('extracts a queue name for use as a metric dimension', () => {
    expect(
      queueNameFromUrl('https://sqs.us-east-1.amazonaws.com/000000000000/kinmap-dev-geo'),
    ).toBe('kinmap-dev-geo');
  });

  it('caps a batch and tolerates a nonsensical limit', () => {
    expect(limitBatch([1, 2, 3, 4], 2)).toEqual([1, 2]);
    expect(limitBatch([1, 2, 3], -5)).toEqual([]);
  });

  it('counts truncation as backlog, not just leftover rows', () => {
    const summary = summarise([
      {
        job: 'expire-invitations',
        examined: 5,
        changed: 2,
        remaining: 0,
        truncated: false,
        durationMs: 1,
      },
      {
        job: 'mark-stale-users',
        examined: 9,
        changed: 3,
        remaining: 0,
        truncated: true,
        durationMs: 1,
      },
      {
        job: 'expire-live-sessions',
        examined: 0,
        changed: 0,
        remaining: 0,
        truncated: false,
        durationMs: 1,
        error: 'ProvisionedThroughputExceededException',
      },
    ]);
    expect(summary).toEqual({ changed: 5, failed: 1, hasBacklog: true });
  });
});
