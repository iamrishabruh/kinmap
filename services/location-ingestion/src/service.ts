import type { AuthContext } from '@family/auth';
import { AppError, LIMITS, type DeviceId, type UserId } from '@family/contracts';
import { coordinatesFromLocationEvent } from '@family/crypto';
import type { Logger } from '@family/observability';
import type { LocationBatchRequest, LocationBatchResponse } from '@family/schemas';

import { planIngestion } from './domain/ingestion.js';
import {
  buildCurrentLocationRecord,
  buildHistoryRecord,
  type RecordBuildInput,
  type StoredCurrentLocation,
  type StoredHistoryPoint,
} from './domain/records.js';
import { resolveCoordinateScope, resolveDisposition } from './domain/sharing.js';
import type {
  AcceptedLocationEvent,
  AcceptedLocationPublisher,
  AccountReader,
  CoordinateSealer,
  CurrentLocationStore,
  DeviceReader,
  HistoryWriter,
  MembershipReader,
  UploadWindowGate,
} from './ports.js';

/**
 * The ingestion pipeline: authorise the device -> gate the upload rate ->
 * resolve consent -> plan acceptance -> encrypt -> persist -> publish.
 *
 * Nothing in this module logs a position, an accuracy-bearing payload, or a
 * whole event object. The only location-derived values that reach the logger are
 * counts and `LocationRejectionReason` constants, which are digit-free by
 * construction.
 */

export type IngestionDependencies = {
  readonly accounts: AccountReader;
  /**
   * Null when the device registry is not wired into this function. The token's
   * own device binding is checked either way, so a batch can never be uploaded
   * for a device the caller does not hold a credential for.
   */
  readonly devices: DeviceReader | null;
  readonly memberships: MembershipReader;
  readonly uploadWindow: UploadWindowGate;
  readonly currentLocations: CurrentLocationStore;
  readonly history: HistoryWriter;
  readonly publisher: AcceptedLocationPublisher;
  readonly sealer: CoordinateSealer;
  readonly logger: Logger;
  readonly retentionDays: number;
  readonly now: () => Date;
};

const FORBIDDEN_MESSAGE = 'You do not have access to this resource.';

/**
 * A device that is unknown, revoked, or owned by someone else is one answer.
 * The caller only ever learns about their *own* device, so this is not a probing
 * channel, but there is still no reason to distinguish "never registered" from
 * "belongs to another account".
 */
function deviceNotRegistered(): AppError {
  return new AppError('DEVICE_NOT_REGISTERED', 'This device is not registered for your account.');
}

async function assertDeviceIsUsable(
  auth: AuthContext,
  batchDeviceId: DeviceId,
  devices: DeviceReader | null,
): Promise<void> {
  // The token's device binding is the primary control: `custom:device_id` is
  // written at sign-in from the device registry and is signed by the pool.
  if (auth.deviceId === null || auth.deviceId !== batchDeviceId) {
    throw deviceNotRegistered();
  }
  if (devices === null) {
    return;
  }

  const device = await devices.getDevice(auth.userId, batchDeviceId);
  if (device === null || device.userId !== auth.userId) {
    throw deviceNotRegistered();
  }
  if (device.status === 'REVOKED') {
    // Distinguished from "not registered" on purpose: a revoked device must stop
    // uploading permanently, and the client needs to know to re-enrol.
    throw new AppError('DEVICE_REVOKED', 'This device has been signed out. Please sign in again.');
  }
  if (device.status !== 'ACTIVE') {
    throw deviceNotRegistered();
  }
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

export async function ingestLocationBatch(
  input: { readonly auth: AuthContext; readonly batch: LocationBatchRequest },
  deps: IngestionDependencies,
): Promise<LocationBatchResponse> {
  const { auth, batch } = input;
  const now = deps.now();
  const receivedAt = now.toISOString();
  const userId: UserId = auth.userId;

  await assertDeviceIsUsable(auth, batch.deviceId, deps.devices);

  const account = await deps.accounts.getAccount(userId);
  if (account === null) {
    throw new AppError('FORBIDDEN', FORBIDDEN_MESSAGE);
  }

  // Reserved after the identity checks so a bogus device cannot burn a real
  // device's window, and before any expensive work so a flooding client is cheap.
  const window = await deps.uploadWindow.reserve(batch.deviceId, now);
  if (!window.allowed) {
    throw new AppError(
      'RATE_LIMITED',
      'Too many requests. Please try again shortly.',
      undefined,
      window.retryAfterSeconds,
    );
  }

  const memberships = await deps.memberships.listForUser(userId);
  const consent = resolveDisposition({ accountStatus: account.status, memberships });

  const plan = planIngestion({
    events: batch.events,
    // Ingestion holds an encrypt-only grant on the coordinate key, so the stored
    // fix cannot be read back for comparison. Cross-batch regression is prevented
    // by the conditional current-fix write instead.
    previousFix: null,
    disposition: consent.disposition,
    now,
  });

  if (plan.suppressed) {
    // The upload succeeded; the points were dropped. Telling the device its
    // account is being deleted, or that its owner paused, would leak state that
    // the app has no right to infer from an upload response.
    deps.logger.info('location batch discarded', {
      userId,
      deviceId: batch.deviceId,
      eventCount: batch.events.length,
      suppressionReason: consent.reason,
    });
    return buildResponse(plan, receivedAt);
  }

  const scopeFamilyId = resolveCoordinateScope(userId, consent.sharingMemberships);

  const currentRecords: StoredCurrentLocation[] = [];
  const historyRecords: StoredHistoryPoint[] = [];
  const busEvents: AcceptedLocationEvent[] = [];

  for (const event of plan.accepted) {
    const sealed = await deps.sealer.encryptCoordinates(coordinatesFromLocationEvent(event), {
      familyId: scopeFamilyId,
      userId,
    });

    const build: RecordBuildInput = {
      event,
      userId,
      receivedAt,
      coordinateScopeFamilyId: scopeFamilyId,
      sealed,
    };

    historyRecords.push(buildHistoryRecord(build, deps.retentionDays));
    if (plan.newestAccepted !== null && plan.newestAccepted.eventId === event.eventId) {
      currentRecords.push(buildCurrentLocationRecord(build));
    }
    busEvents.push({
      subjectUserId: userId,
      deviceId: event.deviceId,
      eventId: event.eventId,
      sequenceNumber: event.sequenceNumber,
      capturedAt: event.capturedAt,
      receivedAt,
      trackingMode: event.trackingMode,
      motionState: event.motionState ?? 'UNKNOWN',
      horizontalAccuracy: event.horizontalAccuracy,
      coordinateScopeFamilyId: scopeFamilyId,
      sealed,
    });
  }

  // Current fix first: it is the value a family member is waiting on, and it is
  // a single conditional write that either advances the position or is a no-op.
  let currentAdvanced = false;
  for (const record of currentRecords) {
    currentAdvanced = await deps.currentLocations.putIfNewer(record);
  }

  // History is append-only and idempotent: the key is derived from the event id,
  // so replaying a batch overwrites identical rows rather than duplicating them.
  for (const batchOfRows of chunk(historyRecords, 25)) {
    await deps.history.append(batchOfRows);
  }

  // Published last, and allowed to fail the request. The points are already
  // durable, so a retry re-writes identical rows; losing the event silently
  // would mean a missed arrival alert with no signal that it happened.
  for (const batchOfEvents of chunk(busEvents, 10)) {
    await deps.publisher.publish(batchOfEvents);
  }

  deps.logger.info('location batch stored', {
    userId,
    deviceId: batch.deviceId,
    acceptedCount: plan.accepted.length,
    rejectedCount: plan.rejected.length,
    currentFixAdvanced: currentAdvanced,
    rejectionReasons: plan.rejected.map((entry) => entry.reason),
  });

  return buildResponse(plan, receivedAt);
}

function buildResponse(
  plan: ReturnType<typeof planIngestion>,
  serverTime: string,
): LocationBatchResponse {
  return {
    acceptedCount: plan.accepted.length,
    rejectedCount: plan.rejected.length,
    rejected: [...plan.rejected],
    highWaterMarkSequenceNumber: plan.highWaterMarkSequenceNumber,
    serverTime,
    nextUploadAfterSeconds: LIMITS.MIN_UPLOAD_INTERVAL_SECONDS,
    // Remote configuration is served by a separate endpoint; ingestion never
    // reaches the configuration table, so it has nothing newer to advertise.
    configVersionAvailable: null,
  };
}
