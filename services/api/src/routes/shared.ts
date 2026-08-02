import { createHmac } from 'node:crypto';

import { unauthenticatedError, type AuthContext } from '@family/auth';
import type { AuditAction, FamilyId, UserId } from '@family/contracts';
import type { AcknowledgedResponse } from '@family/schemas';

import type { AuditMetadata } from '../repositories/audit.js';
import type { AnyRouteContext } from '../types.js';

/**
 * Helpers every route module shares.
 */

/**
 * Narrows the context's principal.
 *
 * The pipeline has already rejected an unauthenticated request to a route whose
 * metadata requires one, so this never fires in practice — it exists so that a
 * route cannot silently proceed with a null principal if that metadata is ever
 * changed by mistake.
 */
export function requireAuth(context: AnyRouteContext): AuthContext {
  if (context.auth === null) {
    throw unauthenticatedError();
  }
  return context.auth;
}

/**
 * Hashes the caller's address for the audit trail.
 *
 * Keyed with a per-environment secret, because a bare SHA-256 of an IPv4
 * address is reversible by exhausting the four-billion-entry space. With no
 * secret configured we store nothing at all rather than a digest that only
 * looks anonymous.
 */
export function hashSourceIp(sourceIp: string | null, secret: string | null): string | null {
  if (sourceIp === null || secret === null) {
    return null;
  }
  return createHmac('sha256', secret).update(sourceIp, 'utf8').digest('hex').slice(0, 32);
}

/**
 * Writes one audit event.
 *
 * Every sensitive action in this service goes through here, and the metadata
 * type admits only scalars — there is no shape in which a coordinate could be
 * attached, which is the property spec §20 asks for.
 */
export async function writeAudit(
  context: AnyRouteContext,
  input: {
    action: AuditAction;
    targetUserId: UserId;
    familyId?: FamilyId | null;
    metadata?: AuditMetadata;
  },
): Promise<void> {
  const auth = requireAuth(context);
  await context.services.audit.record({
    auditId: context.services.newId(),
    action: input.action,
    actorUserId: auth.userId,
    targetUserId: input.targetUserId,
    familyId: input.familyId ?? null,
    metadata: input.metadata ?? {},
    requestId: context.requestId,
    sourceIpHash: hashSourceIp(context.request.sourceIp, context.services.config.auditIpHashSecret),
    occurredAt: context.now,
  });
}

export function acknowledged(requestId: string): AcknowledgedResponse {
  return { ok: true, requestId };
}
