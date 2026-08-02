import { z } from 'zod';

import {
  AuditActionSchema,
  FamilyIdSchema,
  UserIdSchema,
  type AuditAction,
  type FamilyId,
  type UserId,
} from '@family/contracts';
import { isRedactedKey, looksLikeCoordinateValue } from '@family/observability';
import { CoarseGeohashSchema, IsoDateTimeSchema } from '@family/schemas';

/**
 * Audit commands and the rows they become (spec §18).
 *
 * The audit trail is the record a user consults to answer "who has been looking
 * at me". That makes it a privacy control, and it makes an audit row that
 * itself contains a coordinate a self-defeating design: the trail would become
 * a second, longer-lived copy of the location history it exists to police.
 *
 * `sanitizeMetadata` is therefore not advisory. It drops every key on the
 * shared observability deny-list and every value that merely LOOKS like a
 * coordinate, and it accepts a coarse area only through `CoarseGeohashSchema`,
 * which caps precision at roughly a kilometre.
 */

export const AuditMetadataValueSchema = z.union([z.string(), z.number(), z.boolean()]);

export const AuditCommandSchema = z.strictObject({
  auditId: z.string().uuid(),
  action: AuditActionSchema,
  /** Who performed the action. */
  actorUserId: UserIdSchema,
  /** Who it was performed on. Null for account-level actions. */
  targetUserId: UserIdSchema.nullable(),
  familyId: FamilyIdSchema.nullable(),
  metadata: z.record(z.string(), AuditMetadataValueSchema).default({}),
  occurredAt: IsoDateTimeSchema,
  requestId: z.string().min(1).max(128),
  /** Hash only. A raw address would make the trail a tracking log. */
  sourceIpHash: z.string().min(1).max(128).nullable().default(null),
  /** Optional, already-coarsened area. Rejected if finer than six characters. */
  coarseArea: z.string().nullable().default(null),
});
export type AuditCommand = z.infer<typeof AuditCommandSchema>;

export function parseAuditCommand(body: unknown): AuditCommand {
  return AuditCommandSchema.parse(body);
}

/** Metadata keys the trail is allowed to carry, in addition to the deny-list check. */
const MAX_METADATA_ENTRIES = 20;
const MAX_METADATA_VALUE_LENGTH = 256;

export type SanitizedMetadata = Record<string, string | number | boolean>;

/**
 * Strips anything that could reconstitute a position or an identity.
 *
 * Fails safe by dropping rather than throwing: an over-eager caller attaching a
 * latitude must not be able to stop the audit row from being written, because a
 * sensitive read that is not recorded is worse than one recorded with less
 * detail.
 */
export function sanitizeMetadata(
  metadata: Readonly<Record<string, string | number | boolean>>,
): SanitizedMetadata {
  const clean: SanitizedMetadata = {};
  let kept = 0;

  for (const [key, value] of Object.entries(metadata)) {
    if (kept >= MAX_METADATA_ENTRIES) break;
    if (isRedactedKey(key)) continue;
    if (typeof value !== 'boolean' && looksLikeCoordinateValue(value)) continue;
    if (typeof value === 'string') {
      if (value.length > MAX_METADATA_VALUE_LENGTH) continue;
      if (looksLikeCoordinateValue(value)) continue;
    }
    if (typeof value === 'number' && !Number.isFinite(value)) continue;

    clean[key] = value;
    kept += 1;
  }

  return clean;
}

/** Only a genuinely coarse geohash survives. Anything else becomes null. */
export function sanitizeCoarseArea(candidate: string | null): string | null {
  if (candidate === null) return null;
  const parsed = CoarseGeohashSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export type AuditRecord = {
  /** Partition key: the person who was looked at, so "who saw me" is one query. */
  readonly targetUserId: string;
  /** Sort key: `<occurredAt>#<auditId>`, so a range query is chronological. */
  readonly sk: string;
  readonly auditId: string;
  readonly action: AuditAction;
  readonly actorUserId: UserId;
  readonly subjectUserId: UserId | null;
  readonly familyId: FamilyId | null;
  readonly metadata: SanitizedMetadata;
  readonly coarseArea: string | null;
  readonly occurredAt: string;
  readonly requestId: string;
  readonly sourceIpHash: string | null;
  /** Epoch seconds; DynamoDB TTL reaps the row. */
  readonly expiresAt: number;
};

/**
 * Partition key for an action with no target.
 *
 * Account-level actions are filed under the actor, because the person who
 * performed them is also the person entitled to see them.
 */
export function auditPartitionKey(command: AuditCommand): string {
  return command.targetUserId ?? command.actorUserId;
}

export function auditSortKey(command: Pick<AuditCommand, 'occurredAt' | 'auditId'>): string {
  return `${command.occurredAt}#${command.auditId}`;
}

export function buildAuditRecord(input: {
  command: AuditCommand;
  retentionDays: number;
  now: Date;
}): AuditRecord {
  const occurredMs = Date.parse(input.command.occurredAt);
  const anchor = Number.isNaN(occurredMs) ? input.now.getTime() : occurredMs;

  return {
    targetUserId: auditPartitionKey(input.command),
    sk: auditSortKey(input.command),
    auditId: input.command.auditId,
    action: input.command.action,
    actorUserId: input.command.actorUserId,
    subjectUserId: input.command.targetUserId,
    familyId: input.command.familyId,
    metadata: sanitizeMetadata(input.command.metadata),
    coarseArea: sanitizeCoarseArea(input.command.coarseArea),
    occurredAt: input.command.occurredAt,
    requestId: input.command.requestId,
    sourceIpHash: input.command.sourceIpHash,
    expiresAt: Math.floor(anchor / 1000) + Math.round(input.retentionDays * 24 * 3600),
  };
}
