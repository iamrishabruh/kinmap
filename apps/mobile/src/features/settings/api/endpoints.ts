import { type z } from 'zod';

import { LIMITS } from '@family/contracts';

import { apiRequest, newIdempotencyKey } from './client';
import {
  AbuseReportResponseSchema,
  AccountDeletionPreviewSchema,
  DataExportSchema,
  DataRetentionSummarySchema,
  DeleteAccountResponseSchema,
  DeleteHistoryResponseSchema,
  ListDevicesResponseSchema,
  NotificationPreferencesSchema,
  PrivacyAuditPageSchema,
  RevokeDeviceResponseSchema,
  ServerEntitlementsSchema,
  SharingSettingsSchema,
  SupportTicketSchema,
  type AbuseReportResponse,
  type AccountDeletionPreview,
  type CreateAbuseReportRequest,
  type CreateSupportTicketRequest,
  type DataExport,
  type DataRetentionSummary,
  type DeleteAccountRequest,
  type DeleteAccountResponse,
  type DeleteHistoryResponse,
  type NotificationPreferences,
  type PrivacyAuditPage,
  type RegisteredDevice,
  type RevokeDeviceResponse,
  type ServerEntitlements,
  type SharingSettings,
  type SupportTicket,
  type UpdateNotificationPreferencesRequest,
  type UpdateSharingRequest,
} from './contracts';

/**
 * Typed calls for every endpoint the settings surface touches. One function per
 * endpoint, each validating its own response, so a screen never sees an
 * unparsed body.
 */

const DEFAULT_AUDIT_PAGE_SIZE = 50;

// ---------------------------------------------------------------------------
// Privacy dashboard
// ---------------------------------------------------------------------------

export async function fetchPrivacyAudit(params: {
  familyId?: string | null;
  cursor?: string | null;
  signal?: AbortSignal;
}): Promise<PrivacyAuditPage> {
  return apiRequest(
    {
      method: 'GET',
      path: '/v1/privacy/audit',
      query: {
        familyId: params.familyId ?? undefined,
        cursor: params.cursor ?? undefined,
        limit: Math.min(DEFAULT_AUDIT_PAGE_SIZE, LIMITS.MAX_HISTORY_PAGE_SIZE),
      },
      signal: params.signal,
    },
    PrivacyAuditPageSchema,
  );
}

// ---------------------------------------------------------------------------
// Sharing
// ---------------------------------------------------------------------------

export async function fetchSharingSettings(signal?: AbortSignal): Promise<SharingSettings> {
  return apiRequest({ method: 'GET', path: '/v1/sharing', signal }, SharingSettingsSchema);
}

export async function updateSharingSettings(body: UpdateSharingRequest): Promise<SharingSettings> {
  return apiRequest(
    { method: 'PATCH', path: '/v1/sharing', body, idempotencyKey: newIdempotencyKey() },
    SharingSettingsSchema,
  );
}

/**
 * `durationMinutes: null` pauses until the user explicitly resumes. The server
 * is the authority on `pausedUntil` — the client never computes it, because a
 * device with a wrong clock must not be able to un-pause itself.
 */
export async function pauseSharing(durationMinutes: number | null): Promise<SharingSettings> {
  return apiRequest(
    {
      method: 'POST',
      path: '/v1/sharing/pause',
      body: { durationMinutes },
      idempotencyKey: newIdempotencyKey(),
    },
    SharingSettingsSchema,
  );
}

export async function resumeSharing(): Promise<SharingSettings> {
  return apiRequest(
    { method: 'POST', path: '/v1/sharing/resume', idempotencyKey: newIdempotencyKey() },
    SharingSettingsSchema,
  );
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

export async function fetchDevices(signal?: AbortSignal): Promise<RegisteredDevice[]> {
  const response = await apiRequest(
    { method: 'GET', path: '/v1/devices', signal },
    ListDevicesResponseSchema,
  );
  return response.devices;
}

export async function revokeDevice(deviceId: string): Promise<RevokeDeviceResponse> {
  return apiRequest(
    {
      method: 'DELETE',
      path: `/v1/devices/${encodeURIComponent(deviceId)}`,
      idempotencyKey: newIdempotencyKey(),
    },
    RevokeDeviceResponseSchema,
  );
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export async function fetchNotificationPreferences(
  signal?: AbortSignal,
): Promise<NotificationPreferences> {
  return apiRequest(
    { method: 'GET', path: '/v1/notifications/preferences', signal },
    NotificationPreferencesSchema,
  );
}

export async function updateNotificationPreferences(
  body: UpdateNotificationPreferencesRequest,
): Promise<NotificationPreferences> {
  return apiRequest(
    {
      method: 'PATCH',
      path: '/v1/notifications/preferences',
      body,
      idempotencyKey: newIdempotencyKey(),
    },
    NotificationPreferencesSchema,
  );
}

// ---------------------------------------------------------------------------
// Data and history
// ---------------------------------------------------------------------------

export async function fetchRetentionSummary(signal?: AbortSignal): Promise<DataRetentionSummary> {
  return apiRequest(
    { method: 'GET', path: '/v1/privacy/retention', signal },
    DataRetentionSummarySchema,
  );
}

export async function deleteLocationHistory(params: {
  familyId: string | null;
}): Promise<DeleteHistoryResponse> {
  return apiRequest(
    {
      method: 'POST',
      path: '/v1/privacy/history/delete',
      body: { confirmation: 'DELETE', familyId: params.familyId },
      idempotencyKey: newIdempotencyKey(),
    },
    DeleteHistoryResponseSchema,
  );
}

export async function requestDataExport(): Promise<DataExport> {
  return apiRequest(
    {
      method: 'POST',
      path: '/v1/privacy/exports',
      idempotencyKey: newIdempotencyKey(),
    },
    DataExportSchema,
  );
}

export async function fetchDataExport(exportId: string, signal?: AbortSignal): Promise<DataExport> {
  return apiRequest(
    {
      method: 'GET',
      path: `/v1/privacy/exports/${encodeURIComponent(exportId)}`,
      signal,
    },
    DataExportSchema,
  );
}

// ---------------------------------------------------------------------------
// Account deletion (spec §16)
// ---------------------------------------------------------------------------

export async function fetchAccountDeletionPreview(
  signal?: AbortSignal,
): Promise<AccountDeletionPreview> {
  return apiRequest(
    { method: 'GET', path: '/v1/account/deletion/preview', signal },
    AccountDeletionPreviewSchema,
  );
}

/**
 * The destructive call. It is deliberately NOT exported to screens directly —
 * `@/features/settings/account/delete-account-flow` is the only caller, and it
 * refuses to invoke this without a fresh reauthentication.
 */
export async function deleteAccount(body: DeleteAccountRequest): Promise<DeleteAccountResponse> {
  return apiRequest(
    {
      method: 'DELETE',
      path: '/v1/account',
      body,
      idempotencyKey: newIdempotencyKey(),
    },
    DeleteAccountResponseSchema,
  );
}

// ---------------------------------------------------------------------------
// Subscriptions — the server is the only authority (spec §23)
// ---------------------------------------------------------------------------

export async function fetchServerEntitlements(signal?: AbortSignal): Promise<ServerEntitlements> {
  return apiRequest(
    { method: 'GET', path: '/v1/subscriptions/entitlements', signal },
    ServerEntitlementsSchema,
  );
}

/**
 * Nudges the server to re-read the store receipt. Used right after a purchase
 * or a restore so the authoritative value catches up with what the user just
 * did, instead of leaving them staring at a stale tier.
 */
export async function syncSubscription(revenueCatAppUserId: string): Promise<ServerEntitlements> {
  return apiRequest(
    {
      method: 'POST',
      path: '/v1/subscriptions/sync',
      body: { revenueCatAppUserId },
      idempotencyKey: newIdempotencyKey(),
    },
    ServerEntitlementsSchema,
  );
}

// ---------------------------------------------------------------------------
// Support and reporting
// ---------------------------------------------------------------------------

export async function createSupportTicket(
  body: CreateSupportTicketRequest,
): Promise<SupportTicket> {
  return apiRequest(
    {
      method: 'POST',
      path: '/v1/support/tickets',
      body,
      idempotencyKey: newIdempotencyKey(),
    },
    SupportTicketSchema,
  );
}

export async function createAbuseReport(
  body: CreateAbuseReportRequest,
): Promise<AbuseReportResponse> {
  return apiRequest(
    {
      method: 'POST',
      path: '/v1/safety/reports',
      body,
      idempotencyKey: newIdempotencyKey(),
    },
    AbuseReportResponseSchema,
  );
}

/** Re-exported so screens import one module for both calls and their types. */
export const schemas = {
  PrivacyAuditPageSchema,
  SharingSettingsSchema,
  ListDevicesResponseSchema,
  NotificationPreferencesSchema,
  DataRetentionSummarySchema,
  ServerEntitlementsSchema,
} satisfies Record<string, z.ZodType>;
