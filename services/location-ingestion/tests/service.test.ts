import { beforeEach, describe, expect, it } from 'vitest';

import type {
  AuthContext,
  DeviceRecord,
  FamilyMembershipRecord,
  UserAccountRecord,
} from '@family/auth';
import { AppError, LIMITS, type DeviceId, type UserId } from '@family/contracts';
import { EncryptionService, InMemoryKmsStub } from '@family/crypto';
import { createLogger, createMemorySink } from '@family/observability';
import { LocationBatchRequestSchema, LocationBatchResponseSchema } from '@family/schemas';

import type { StoredCurrentLocation, StoredHistoryPoint } from '../src/domain/records.js';
import type {
  AcceptedLocationEvent,
  AcceptedLocationPublisher,
  AccountReader,
  CurrentLocationStore,
  DeviceReader,
  HistoryWriter,
  MembershipReader,
  UploadWindowGate,
} from '../src/ports.js';
import { ingestLocationBatch, type IngestionDependencies } from '../src/service.js';

import {
  activeAccount,
  activeDevice,
  DEVICE_ID,
  makeEvent,
  NOW,
  sharingMembership,
  USER_ID,
} from './fixtures.js';

/**
 * The whole pipeline, exercised with in-memory ports and a real
 * `EncryptionService` over the offline KMS stub. Nothing here touches AWS, so
 * the privacy assertions below are about the code that actually ships.
 */

class FakeAccounts implements AccountReader {
  constructor(private record: UserAccountRecord | null = activeAccount()) {}
  setAccount(record: UserAccountRecord | null): void {
    this.record = record;
  }
  getAccount(): Promise<UserAccountRecord | null> {
    return Promise.resolve(this.record);
  }
}

class FakeDevices implements DeviceReader {
  constructor(private record: DeviceRecord | null = activeDevice()) {}
  setDevice(record: DeviceRecord | null): void {
    this.record = record;
  }
  getDevice(): Promise<DeviceRecord | null> {
    return Promise.resolve(this.record);
  }
}

class FakeMemberships implements MembershipReader {
  records: FamilyMembershipRecord[] = [sharingMembership()];
  listForUser(): Promise<FamilyMembershipRecord[]> {
    return Promise.resolve(this.records);
  }
}

class FakeUploadWindow implements UploadWindowGate {
  allowed = true;
  reservations: DeviceId[] = [];
  reserve(deviceId: DeviceId): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
    this.reservations.push(deviceId);
    return Promise.resolve({
      allowed: this.allowed,
      retryAfterSeconds: LIMITS.MIN_UPLOAD_INTERVAL_SECONDS,
    });
  }
}

/** Reproduces the table's conditional write: only a strictly newer fix wins. */
class FakeCurrentLocations implements CurrentLocationStore {
  stored: StoredCurrentLocation | null = null;
  attempts: StoredCurrentLocation[] = [];

  readCapturedAt(): Promise<string | null> {
    return Promise.resolve(this.stored?.capturedAt ?? null);
  }

  putIfNewer(record: StoredCurrentLocation): Promise<boolean> {
    this.attempts.push(record);
    if (this.stored !== null && this.stored.capturedAt >= record.capturedAt) {
      return Promise.resolve(false);
    }
    this.stored = record;
    return Promise.resolve(true);
  }
}

class FakeHistory implements HistoryWriter {
  rows: StoredHistoryPoint[] = [];
  append(records: readonly StoredHistoryPoint[]): Promise<void> {
    this.rows.push(...records);
    return Promise.resolve();
  }
}

class FakePublisher implements AcceptedLocationPublisher {
  published: AcceptedLocationEvent[] = [];
  publish(events: readonly AcceptedLocationEvent[]): Promise<void> {
    this.published.push(...events);
    return Promise.resolve();
  }
}

function authContext(deviceId: DeviceId | null = DEVICE_ID): AuthContext {
  return {
    userId: USER_ID as UserId,
    deviceId,
    tokenUse: 'access',
    claims: {
      sub: USER_ID,
      token_use: 'access',
      iss: 'https://cognito-idp.test/pool',
      exp: 4_102_444_800,
      iat: 1_700_000_000,
    },
    requestId: 'req-1',
  };
}

type Harness = {
  deps: IngestionDependencies;
  accounts: FakeAccounts;
  devices: FakeDevices;
  memberships: FakeMemberships;
  uploadWindow: FakeUploadWindow;
  currentLocations: FakeCurrentLocations;
  history: FakeHistory;
  publisher: FakePublisher;
  logLines: string[];
};

function harness(): Harness {
  const accounts = new FakeAccounts();
  const devices = new FakeDevices();
  const memberships = new FakeMemberships();
  const uploadWindow = new FakeUploadWindow();
  const currentLocations = new FakeCurrentLocations();
  const history = new FakeHistory();
  const publisher = new FakePublisher();
  const memory = createMemorySink();

  return {
    accounts,
    devices,
    memberships,
    uploadWindow,
    currentLocations,
    history,
    publisher,
    logLines: memory.lines,
    deps: {
      accounts,
      devices,
      memberships,
      uploadWindow,
      currentLocations,
      history,
      publisher,
      sealer: new EncryptionService({ keyProvider: new InMemoryKmsStub() }),
      logger: createLogger({
        service: 'location-ingestion',
        env: 'development',
        sink: memory.sink,
      }),
      retentionDays: LIMITS.HISTORY_RETENTION_DAYS,
      now: () => NOW,
    },
  };
}

function batchOf(
  events: Array<ReturnType<typeof makeEvent>>,
): ReturnType<typeof LocationBatchRequestSchema.parse> {
  return LocationBatchRequestSchema.parse({
    deviceId: DEVICE_ID,
    uploadedAt: NOW.toISOString(),
    events,
    configVersion: null,
  });
}

describe('ingestLocationBatch', () => {
  let context: Harness;

  beforeEach(() => {
    context = harness();
  });

  it('stores, seals and publishes every accepted point', async () => {
    const events = [
      makeEvent({ sequenceNumber: 1, capturedAt: '2026-08-02T11:00:00.000Z', latitude: 37.4 }),
      makeEvent({ sequenceNumber: 2, capturedAt: '2026-08-02T11:30:00.000Z', latitude: 37.5 }),
    ];

    const response = await ingestLocationBatch(
      { auth: authContext(), batch: batchOf(events) },
      context.deps,
    );

    expect(LocationBatchResponseSchema.parse(response)).toEqual(response);
    expect(response.acceptedCount).toBe(2);
    expect(response.rejectedCount).toBe(0);
    expect(response.highWaterMarkSequenceNumber).toBe(2);
    expect(response.nextUploadAfterSeconds).toBe(LIMITS.MIN_UPLOAD_INTERVAL_SECONDS);

    expect(context.history.rows).toHaveLength(2);
    expect(context.publisher.published).toHaveLength(2);
    // Only the newest point may advance the current fix.
    expect(context.currentLocations.attempts).toHaveLength(1);
    expect(context.currentLocations.stored?.capturedAt).toBe('2026-08-02T11:30:00.000Z');
  });

  it('never persists or publishes a plaintext coordinate', async () => {
    const events = [makeEvent({ sequenceNumber: 1, latitude: 51.500729, longitude: -0.124625 })];

    await ingestLocationBatch({ auth: authContext(), batch: batchOf(events) }, context.deps);

    const written = JSON.stringify({
      history: context.history.rows,
      current: context.currentLocations.stored,
      published: context.publisher.published,
      logs: context.logLines,
    });

    expect(written).not.toContain('51.500729');
    expect(written).not.toContain('-0.124625');
    expect(written).not.toContain('"latitude"');
    expect(written).not.toContain('"longitude"');

    const row = context.history.rows[0];
    expect(row).toBeDefined();
    expect(row?.sealed.algorithm).toBe('AES-256-GCM');
    expect(row?.expiresAt).toBeGreaterThan(Math.floor(NOW.getTime() / 1000));
  });

  it('accepts the request but discards the points while sharing is paused', async () => {
    context.memberships.records = [sharingMembership(undefined, { sharingStatus: 'PAUSED' })];

    const response = await ingestLocationBatch(
      { auth: authContext(), batch: batchOf([makeEvent({ sequenceNumber: 7 })]) },
      context.deps,
    );

    expect(response.acceptedCount).toBe(0);
    expect(response.rejected.map((entry) => entry.reason)).toEqual(['SHARING_NOT_ACTIVE']);
    expect(response.highWaterMarkSequenceNumber).toBeNull();
    expect(context.history.rows).toHaveLength(0);
    expect(context.currentLocations.stored).toBeNull();
    expect(context.publisher.published).toHaveLength(0);
  });

  it('accepts the request but discards the points while the account is pending deletion', async () => {
    context.accounts.setAccount({ userId: USER_ID, status: 'PENDING_DELETION' });

    const response = await ingestLocationBatch(
      { auth: authContext(), batch: batchOf([makeEvent({ sequenceNumber: 3 })]) },
      context.deps,
    );

    expect(response.acceptedCount).toBe(0);
    expect(context.history.rows).toHaveLength(0);
  });

  it('does not let an out-of-order retry regress the current fix', async () => {
    const newer = makeEvent({ sequenceNumber: 9, capturedAt: '2026-08-02T11:45:00.000Z' });
    await ingestLocationBatch({ auth: authContext(), batch: batchOf([newer]) }, context.deps);
    expect(context.currentLocations.stored?.capturedAt).toBe('2026-08-02T11:45:00.000Z');

    const older = makeEvent({
      sequenceNumber: 4,
      capturedAt: '2026-08-02T10:00:00.000Z',
      latitude: 38.9,
      longitude: -77.0,
    });
    const response = await ingestLocationBatch(
      { auth: authContext(), batch: batchOf([older]) },
      context.deps,
    );

    // The point is still archived...
    expect(response.acceptedCount).toBe(1);
    expect(context.history.rows).toHaveLength(2);
    // ...but the current position is unchanged.
    expect(context.currentLocations.stored?.capturedAt).toBe('2026-08-02T11:45:00.000Z');
  });

  it('rejects a batch whose device does not match the caller credential', async () => {
    await expect(
      ingestLocationBatch({ auth: authContext(null), batch: batchOf([makeEvent()]) }, context.deps),
    ).rejects.toMatchObject({ code: 'DEVICE_NOT_REGISTERED' });
  });

  it('rejects a revoked device', async () => {
    context.devices.setDevice({ userId: USER_ID, deviceId: DEVICE_ID, status: 'REVOKED' });

    await expect(
      ingestLocationBatch({ auth: authContext(), batch: batchOf([makeEvent()]) }, context.deps),
    ).rejects.toMatchObject({ code: 'DEVICE_REVOKED' });
  });

  it('rejects an unregistered device', async () => {
    context.devices.setDevice(null);

    await expect(
      ingestLocationBatch({ auth: authContext(), batch: batchOf([makeEvent()]) }, context.deps),
    ).rejects.toMatchObject({ code: 'DEVICE_NOT_REGISTERED' });
  });

  it('enforces the per-device upload interval before doing any work', async () => {
    context.uploadWindow.allowed = false;

    const error = await ingestLocationBatch(
      { auth: authContext(), batch: batchOf([makeEvent()]) },
      context.deps,
    ).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('RATE_LIMITED');
    expect((error as AppError).retryAfterSeconds).toBe(LIMITS.MIN_UPLOAD_INTERVAL_SECONDS);
    expect(context.history.rows).toHaveLength(0);
  });

  it('does not burn the upload window on a request that fails the device check', async () => {
    context.devices.setDevice(null);

    await expect(
      ingestLocationBatch({ auth: authContext(), batch: batchOf([makeEvent()]) }, context.deps),
    ).rejects.toBeInstanceOf(AppError);

    expect(context.uploadWindow.reservations).toHaveLength(0);
  });

  it('binds every sealed coordinate to the same deterministic key scope', async () => {
    await ingestLocationBatch(
      {
        auth: authContext(),
        batch: batchOf([
          makeEvent({ sequenceNumber: 1, capturedAt: '2026-08-02T11:00:00.000Z' }),
          makeEvent({
            sequenceNumber: 2,
            capturedAt: '2026-08-02T11:20:00.000Z',
            latitude: 40.1,
            longitude: -80.2,
          }),
        ]),
      },
      context.deps,
    );

    const scopes = new Set(context.history.rows.map((row) => row.coordinateScopeFamilyId));
    expect(scopes.size).toBe(1);
  });
});
