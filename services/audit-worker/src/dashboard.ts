import { AuditActionSchema, type AuditAction, type UserId } from '@family/contracts';
import {
  AuditLogEntrySchema,
  GetAuditLogResponseSchema,
  type AuditLogEntry,
  type GetAuditLogQuery,
  type GetAuditLogResponse,
} from '@family/schemas';

import type { AuditRecord } from './records.js';

/**
 * The "who viewed my location" privacy dashboard.
 *
 * ONE authorization rule governs this whole module and it is structural rather
 * than conditional: the partition key of every query is the CALLER's own user
 * id, taken from the verified token. There is no code path that accepts a
 * target from the request, so there is no code path that can be tricked into
 * reading somebody else's trail — including via a hand-crafted pagination
 * cursor, which is re-checked against the caller before it is used.
 *
 * Everything here is pure. The DynamoDB call is assembled from the plan by the
 * adapter.
 */

/** Highest code unit, used to make a prefix range inclusive of the whole day. */
const SORT_KEY_UPPER_BOUND = '￿';

export type AuditQueryPlan = {
  /** Always the caller. Never anything supplied by the request. */
  readonly partitionKey: UserId;
  readonly skFrom: string | null;
  readonly skTo: string | null;
  readonly action: AuditAction | null;
  readonly limit: number;
  readonly exclusiveStartKey: Readonly<Record<string, unknown>> | null;
  /** Newest first: the question is "who looked at me lately". */
  readonly scanForward: false;
};

export type CursorKey = { readonly targetUserId: string; readonly sk: string };

export function encodeCursor(key: CursorKey): string {
  return Buffer.from(JSON.stringify(key), 'utf8').toString('base64url');
}

/**
 * Decodes an opaque cursor and refuses one that points at another user's
 * partition. A cursor is client-held state, and client-held state is an input.
 */
export function decodeCursor(cursor: string | null, callerUserId: UserId): CursorKey | null {
  if (cursor === null || cursor.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const candidate = parsed as Partial<CursorKey>;
    if (typeof candidate.targetUserId !== 'string' || typeof candidate.sk !== 'string') return null;
    if (candidate.targetUserId !== callerUserId) return null;
    return { targetUserId: candidate.targetUserId, sk: candidate.sk };
  } catch {
    return null;
  }
}

export function planAuditQuery(input: {
  callerUserId: UserId;
  query: GetAuditLogQuery;
}): AuditQueryPlan {
  const cursor = decodeCursor(input.query.cursor, input.callerUserId);
  const action = AuditActionSchema.safeParse(input.query.action);

  return {
    partitionKey: input.callerUserId,
    skFrom: input.query.from === null ? null : `${input.query.from}#`,
    skTo: input.query.to === null ? null : `${input.query.to}#${SORT_KEY_UPPER_BOUND}`,
    action: action.success ? action.data : null,
    limit: input.query.limit,
    exclusiveStartKey: cursor === null ? null : { ...cursor },
    scanForward: false,
  };
}

/**
 * Projects a stored row onto the public entry shape.
 *
 * Note what does not survive: `metadata`, `requestId` and `sourceIpHash` are
 * operator-facing and stay server-side. The only location-derived field that
 * reaches the user is `coarseArea`, which the schema caps at six characters.
 */
export function toAuditLogEntry(
  record: AuditRecord,
  actorDisplayName: string | null,
): AuditLogEntry {
  return AuditLogEntrySchema.parse({
    auditId: record.auditId,
    action: record.action,
    actorUserId: record.actorUserId,
    actorDisplayName,
    targetUserId: record.subjectUserId,
    familyId: record.familyId,
    occurredAt: record.occurredAt,
    coarseArea: record.coarseArea,
  } satisfies AuditLogEntry);
}

export function buildAuditLogResponse(input: {
  records: readonly AuditRecord[];
  displayNames: ReadonlyMap<string, string | null>;
  lastEvaluatedKey: CursorKey | null;
}): GetAuditLogResponse {
  const entries = input.records.map((record) =>
    toAuditLogEntry(record, input.displayNames.get(record.actorUserId) ?? null),
  );

  return GetAuditLogResponseSchema.parse({
    entries,
    page: {
      nextCursor: input.lastEvaluatedKey === null ? null : encodeCursor(input.lastEvaluatedKey),
      hasMore: input.lastEvaluatedKey !== null,
    },
  } satisfies GetAuditLogResponse);
}

/** Actor ids to resolve display names for, deduplicated. */
export function actorIdsToResolve(records: readonly AuditRecord[]): string[] {
  return [...new Set(records.map((record) => record.actorUserId))];
}
