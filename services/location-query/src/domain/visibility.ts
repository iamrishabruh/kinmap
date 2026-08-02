import { isVisibleTo } from '@family/auth';
import { FRESHNESS_THRESHOLDS, ACCEPTANCE, type Freshness, type UserId } from '@family/contracts';
import type { HiddenSharingStatus } from '@family/schemas';

import type { FamilyMemberRow } from '../ports.js';

/**
 * Who may see whom, and how fresh the answer is.
 *
 * Pure and total: every ACTIVE member of the family resolves to exactly one of
 * two outcomes, and only one of them can carry a position. That is what makes
 * the response schema's guarantee — a coordinate is unreachable unless
 * `sharingStatus === 'SHARING'` — hold at runtime and not merely on paper.
 */

export type MemberVisibility =
  | { readonly kind: 'VISIBLE' }
  | { readonly kind: 'HIDDEN'; readonly sharingStatus: HiddenSharingStatus };

/**
 * A member who has hidden themselves from *this* requester is reported as
 * DISABLED rather than with their true status.
 *
 * Reporting `SHARING` in the hidden arm would be a contradiction, and reporting
 * a distinct "hidden from you" status would tell the requester they have been
 * singled out — which is exactly the signal a controlling family member would
 * use. One indistinguishable answer covers "off", "paused for everyone" and
 * "not shared with you".
 */
const EXCLUDED_STATUS: HiddenSharingStatus = 'DISABLED';

export function classifyMember(member: FamilyMemberRow, requesterUserId: UserId): MemberVisibility {
  if (member.userId === requesterUserId) {
    // Your own card always shows your own position.
    return { kind: 'VISIBLE' };
  }
  if (member.sharingStatus !== 'SHARING') {
    return { kind: 'HIDDEN', sharingStatus: member.sharingStatus };
  }
  if (!isVisibleTo(member, requesterUserId)) {
    return { kind: 'HIDDEN', sharingStatus: EXCLUDED_STATUS };
  }
  return { kind: 'VISIBLE' };
}

/** Only ACTIVE membership rows are rendered at all. */
export function isRenderableMember(member: FamilyMemberRow): boolean {
  return member.status === 'ACTIVE';
}

/**
 * Freshness band (spec §19). Viewers see a band rather than a raw age so that
 * "last seen" copy stays honest without exposing second-level movement detail.
 *
 * A capture time in the future by more than the tolerated clock skew is UNKNOWN:
 * any age computed from it would be fiction.
 */
export function classifyFreshness(capturedAt: string, nowMs: number): Freshness {
  const capturedMs = Date.parse(capturedAt);
  if (Number.isNaN(capturedMs) || !Number.isFinite(nowMs)) {
    return 'UNKNOWN';
  }
  const ageSeconds = (nowMs - capturedMs) / 1000;
  if (ageSeconds < 0) {
    if (-ageSeconds > ACCEPTANCE.MAX_CLOCK_SKEW_FUTURE_SECONDS) {
      return 'UNKNOWN';
    }
    return 'LIVE';
  }
  if (ageSeconds <= FRESHNESS_THRESHOLDS.LIVE_SECONDS) return 'LIVE';
  if (ageSeconds <= FRESHNESS_THRESHOLDS.FRESH_SECONDS) return 'FRESH';
  if (ageSeconds <= FRESHNESS_THRESHOLDS.RECENT_SECONDS) return 'RECENT';
  return 'STALE';
}
