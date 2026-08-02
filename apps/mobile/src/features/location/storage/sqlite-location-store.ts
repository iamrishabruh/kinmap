import * as SQLite from 'expo-sqlite';

import { LIMITS, type LocationEvent, LocationEventSchema } from '@family/contracts';

import { createFieldCipher, type FieldCipher } from '../crypto/field-cipher';
import { loadOrCreateLocalStoreKey } from '../crypto/key-store';
import { isUploadErrorCode, LocationFeatureError, type UploadErrorCode } from '../errors';
import { isoToEpochMs } from '../internal/clock';

import {
  CIPHER_LABELS,
  DATABASE_NAME,
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  OWNED_TABLES,
} from './schema';
import {
  type AcceptanceVersions,
  type CachedFamilyMetadata,
  type CachedFamilyMetadataPayload,
  type CachedMarker,
  type LocationStore,
  type PendingEventRecord,
  type PendingMutation,
  type PendingMutationKind,
  type PersistedEngineState,
  type QueueStats,
  type StoredLocationPoint,
  type StoredRemoteConfig,
} from './types';

/**
 * `expo-sqlite` implementation of the local persistence port.
 *
 * Two invariants hold everywhere in this file:
 *  1. nothing personal is written to a non-`sealed_` column;
 *  2. a row that fails to decrypt is discarded, never surfaced. A record we
 *     cannot authenticate is either corrupt or forged, and in both cases the
 *     safe answer for a location product is "we have no data" rather than
 *     "here is something that might be a location".
 */

type PendingEventRow = {
  event_id: string;
  attempts: number;
  queued_at: string;
  next_attempt_at: string;
  last_error_code: string | null;
  sealed_payload: string;
};

type EngineStateRow = {
  tracking_state: string;
  sharing_status: string;
  sharing_enabled: number;
  sharing_paused: number;
  last_sequence_number: number;
  last_upload_attempt_at: string | null;
  last_upload_error: string | null;
  updated_at: string;
};

type MutationRow = {
  mutation_id: string;
  kind: string;
  idempotency_key: string;
  created_at: string;
  attempts: number;
  next_attempt_at: string;
  last_error_code: string | null;
  sealed_payload: string;
};

const DEFAULT_ENGINE_STATE: PersistedEngineState = {
  trackingState: 'DISABLED',
  sharingStatus: 'NEVER_ENABLED',
  sharingEnabled: false,
  sharingPaused: false,
  lastSequenceNumber: 0,
  lastUploadAttemptAt: null,
  lastUploadError: null,
  updatedAt: new Date(0).toISOString(),
};

function toErrorCode(value: string | null): UploadErrorCode | null {
  return isUploadErrorCode(value) ? value : null;
}

export type SqliteLocationStoreOptions = {
  databaseName?: string;
  /** Injected in tests; production derives it from the platform keystore. */
  cipher?: FieldCipher;
};

export class SqliteLocationStore implements LocationStore {
  private database: SQLite.SQLiteDatabase | null = null;
  private cipher: FieldCipher | null = null;
  private readonly databaseName: string;
  private readonly injectedCipher: FieldCipher | undefined;
  private initializing: Promise<void> | null = null;

  constructor(options: SqliteLocationStoreOptions = {}) {
    this.databaseName = options.databaseName ?? DATABASE_NAME;
    this.injectedCipher = options.cipher;
  }

  async initialize(): Promise<void> {
    if (this.database) {
      return;
    }
    this.initializing ??= this.doInitialize();
    try {
      await this.initializing;
    } finally {
      this.initializing = null;
    }
  }

  private async doInitialize(): Promise<void> {
    this.cipher = this.injectedCipher ?? createFieldCipher(await loadOrCreateLocalStoreKey());

    let database: SQLite.SQLiteDatabase;
    try {
      database = await SQLite.openDatabaseAsync(this.databaseName);
    } catch {
      throw new LocationFeatureError('STORAGE_UNAVAILABLE', 'open');
    }

    // WAL keeps the background-location writer from blocking the UI reader.
    // `foreign_keys` is on for correctness even though the schema is flat today.
    await database.execAsync('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

    const versionRow = await database.getFirstAsync<{ user_version: number }>(
      'PRAGMA user_version;',
    );
    let currentVersion = versionRow?.user_version ?? 0;

    for (const migration of MIGRATIONS) {
      if (migration.version <= currentVersion) {
        continue;
      }
      await database.withTransactionAsync(async () => {
        for (const statement of migration.statements) {
          await database.execAsync(statement);
        }
      });
      // PRAGMA cannot be parameterised; the value is an integer literal from
      // our own migration table, never user input.
      await database.execAsync(`PRAGMA user_version = ${migration.version};`);
      currentVersion = migration.version;
    }

    if (currentVersion > LATEST_SCHEMA_VERSION) {
      // A downgrade installed over a newer build. Reading rows written by a
      // schema we do not understand risks mis-typing a coordinate column.
      throw new LocationFeatureError('STORAGE_CORRUPT', 'schema-ahead');
    }

    this.database = database;
  }

  async close(): Promise<void> {
    const database = this.database;
    this.database = null;
    this.cipher = null;
    await database?.closeAsync();
  }

  private db(): SQLite.SQLiteDatabase {
    if (!this.database) {
      throw new LocationFeatureError('NOT_INITIALIZED', 'store');
    }
    return this.database;
  }

  private seal(): FieldCipher {
    if (!this.cipher) {
      throw new LocationFeatureError('NOT_INITIALIZED', 'cipher');
    }
    return this.cipher;
  }

  // -------------------------------------------------------------------------
  // Pending location events
  // -------------------------------------------------------------------------

  async enqueueEvents(events: readonly LocationEvent[], now: string): Promise<{ dropped: number }> {
    if (events.length === 0) {
      return { dropped: 0 };
    }
    const database = this.db();
    const cipher = this.seal();

    const sealedRows = await Promise.all(
      events.map(async (event) => ({
        event,
        sealed: await cipher.seal(CIPHER_LABELS.pendingEvent, JSON.stringify(event)),
      })),
    );

    let dropped = 0;
    await database.withTransactionAsync(async () => {
      for (const { event, sealed } of sealedRows) {
        await database.runAsync(
          `INSERT OR REPLACE INTO pending_events
             (event_id, device_id, sequence_number, captured_at, queued_at,
              tracking_mode, attempts, next_attempt_at, last_error_code, sealed_payload)
           VALUES (?, ?, ?, ?, ?, ?, 0, ?, NULL, ?);`,
          [
            event.eventId,
            event.deviceId,
            event.sequenceNumber,
            event.capturedAt,
            now,
            event.trackingMode,
            now,
            sealed,
          ],
        );
      }

      // Bounded queue (spec §11): a device that has been offline for a week
      // must not grow without limit. Oldest points go first — the newest fix
      // is the one the family actually needs.
      const overflow = await database.runAsync(
        `DELETE FROM pending_events WHERE event_id IN (
           SELECT event_id FROM pending_events
           ORDER BY queued_at DESC, sequence_number DESC
           LIMIT -1 OFFSET ?
         );`,
        [LIMITS.MAX_QUEUED_EVENTS],
      );
      dropped = overflow.changes;
    });

    return { dropped };
  }

  async claimReadyEvents(limit: number, now: string): Promise<PendingEventRecord[]> {
    const rows = await this.db().getAllAsync<PendingEventRow>(
      `SELECT event_id, attempts, queued_at, next_attempt_at, last_error_code, sealed_payload
         FROM pending_events
        WHERE next_attempt_at <= ?
        ORDER BY sequence_number ASC, queued_at ASC
        LIMIT ?;`,
      [now, Math.max(0, Math.min(limit, LIMITS.MAX_EVENTS_PER_BATCH))],
    );

    const records: PendingEventRecord[] = [];
    const undecryptable: string[] = [];
    for (const row of rows) {
      const event = await this.openEvent(row.sealed_payload);
      if (!event) {
        undecryptable.push(row.event_id);
        continue;
      }
      records.push({
        event,
        queuedAt: row.queued_at,
        attempts: row.attempts,
        nextAttemptAt: row.next_attempt_at,
        lastErrorCode: toErrorCode(row.last_error_code),
      });
    }
    if (undecryptable.length > 0) {
      await this.removeEvents(undecryptable);
    }
    return records;
  }

  private async openEvent(sealed: string): Promise<LocationEvent | null> {
    try {
      const parsed = LocationEventSchema.safeParse(
        JSON.parse(await this.seal().open(CIPHER_LABELS.pendingEvent, sealed)),
      );
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  async removeEvents(eventIds: readonly string[]): Promise<void> {
    if (eventIds.length === 0) {
      return;
    }
    const database = this.db();
    const placeholders = eventIds.map(() => '?').join(',');
    await database.runAsync(`DELETE FROM pending_events WHERE event_id IN (${placeholders});`, [
      ...eventIds,
    ]);
  }

  async recordEventAttempt(
    eventIds: readonly string[],
    input: { nextAttemptAt: string; errorCode: UploadErrorCode },
  ): Promise<void> {
    if (eventIds.length === 0) {
      return;
    }
    const database = this.db();
    const placeholders = eventIds.map(() => '?').join(',');
    await database.runAsync(
      `UPDATE pending_events
          SET attempts = attempts + 1,
              next_attempt_at = ?,
              last_error_code = ?
        WHERE event_id IN (${placeholders});`,
      [input.nextAttemptAt, input.errorCode, ...eventIds],
    );
  }

  async pruneExpiredEvents(now: string, maxAgeHours: number): Promise<number> {
    const cutoff = new Date(isoToEpochMs(now) - maxAgeHours * 3600 * 1000).toISOString();
    const result = await this.db().runAsync('DELETE FROM pending_events WHERE queued_at < ?;', [
      cutoff,
    ]);
    return result.changes;
  }

  async getQueueStats(now: string): Promise<QueueStats> {
    const row = await this.db().getFirstAsync<{
      pending_count: number;
      oldest_queued_at: string | null;
      ready_count: number;
    }>(
      `SELECT COUNT(*) AS pending_count,
              MIN(queued_at) AS oldest_queued_at,
              SUM(CASE WHEN next_attempt_at <= ? THEN 1 ELSE 0 END) AS ready_count
         FROM pending_events;`,
      [now],
    );
    return {
      pendingCount: row?.pending_count ?? 0,
      oldestQueuedAt: row?.oldest_queued_at ?? null,
      readyCount: row?.ready_count ?? 0,
    };
  }

  async purgePendingEvents(): Promise<number> {
    const result = await this.db().runAsync('DELETE FROM pending_events;');
    return result.changes;
  }

  // -------------------------------------------------------------------------
  // Last accepted location
  // -------------------------------------------------------------------------

  async setLastAcceptedLocation(point: StoredLocationPoint): Promise<void> {
    const sealed = await this.seal().seal(
      CIPHER_LABELS.lastAcceptedLocation,
      JSON.stringify({ latitude: point.latitude, longitude: point.longitude }),
    );
    await this.db().runAsync(
      `INSERT OR REPLACE INTO last_accepted_location
         (id, captured_at, accepted_at, horizontal_accuracy, tracking_mode, sealed_point)
       VALUES (1, ?, ?, ?, ?, ?);`,
      [point.capturedAt, point.acceptedAt, point.horizontalAccuracy, point.trackingMode, sealed],
    );
  }

  async getLastAcceptedLocation(): Promise<StoredLocationPoint | null> {
    const row = await this.db().getFirstAsync<{
      captured_at: string;
      accepted_at: string;
      horizontal_accuracy: number;
      tracking_mode: string;
      sealed_point: string;
    }>('SELECT * FROM last_accepted_location WHERE id = 1;');
    if (!row) {
      return null;
    }
    try {
      const decoded = JSON.parse(
        await this.seal().open(CIPHER_LABELS.lastAcceptedLocation, row.sealed_point),
      ) as { latitude: number; longitude: number };
      return {
        latitude: decoded.latitude,
        longitude: decoded.longitude,
        horizontalAccuracy: row.horizontal_accuracy,
        capturedAt: row.captured_at,
        acceptedAt: row.accepted_at,
        trackingMode: row.tracking_mode as StoredLocationPoint['trackingMode'],
      };
    } catch {
      await this.db().runAsync('DELETE FROM last_accepted_location WHERE id = 1;');
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Engine state
  // -------------------------------------------------------------------------

  async saveEngineState(state: PersistedEngineState): Promise<void> {
    await this.db().runAsync(
      `INSERT OR REPLACE INTO engine_state
         (id, tracking_state, sharing_status, sharing_enabled, sharing_paused,
          last_sequence_number, last_upload_attempt_at, last_upload_error, updated_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        state.trackingState,
        state.sharingStatus,
        state.sharingEnabled ? 1 : 0,
        state.sharingPaused ? 1 : 0,
        state.lastSequenceNumber,
        state.lastUploadAttemptAt,
        state.lastUploadError,
        state.updatedAt,
      ],
    );
  }

  async loadEngineState(): Promise<PersistedEngineState | null> {
    const row = await this.db().getFirstAsync<EngineStateRow>(
      'SELECT * FROM engine_state WHERE id = 1;',
    );
    if (!row) {
      return null;
    }
    return {
      trackingState: row.tracking_state as PersistedEngineState['trackingState'],
      sharingStatus: row.sharing_status as PersistedEngineState['sharingStatus'],
      sharingEnabled: row.sharing_enabled === 1,
      sharingPaused: row.sharing_paused === 1,
      lastSequenceNumber: row.last_sequence_number,
      lastUploadAttemptAt: row.last_upload_attempt_at,
      lastUploadError: toErrorCode(row.last_upload_error),
      updatedAt: row.updated_at,
    };
  }

  async reserveSequenceNumbers(count: number, now: string): Promise<number> {
    const database = this.db();
    let first = 0;
    await database.withTransactionAsync(async () => {
      const existing = await this.loadEngineState();
      const base = existing ?? { ...DEFAULT_ENGINE_STATE, updatedAt: now };
      first = base.lastSequenceNumber;
      await this.saveEngineState({
        ...base,
        lastSequenceNumber: base.lastSequenceNumber + Math.max(0, count),
        updatedAt: now,
      });
    });
    return first;
  }

  // -------------------------------------------------------------------------
  // Cached family metadata
  // -------------------------------------------------------------------------

  async saveFamilyMetadata(records: readonly CachedFamilyMetadata[]): Promise<void> {
    const database = this.db();
    const cipher = this.seal();
    const sealed = await Promise.all(
      records.map(async (record) => ({
        record,
        payload: await cipher.seal(CIPHER_LABELS.familyMetadata, JSON.stringify(record.metadata)),
      })),
    );
    await database.withTransactionAsync(async () => {
      for (const entry of sealed) {
        await database.runAsync(
          `INSERT OR REPLACE INTO family_metadata
             (family_id, member_count, role, cached_at, sealed_metadata)
           VALUES (?, ?, ?, ?, ?);`,
          [
            entry.record.familyId,
            entry.record.memberCount,
            entry.record.role,
            entry.record.cachedAt,
            entry.payload,
          ],
        );
      }
    });
  }

  async loadFamilyMetadata(): Promise<CachedFamilyMetadata[]> {
    const rows = await this.db().getAllAsync<{
      family_id: string;
      member_count: number;
      role: string;
      cached_at: string;
      sealed_metadata: string;
    }>('SELECT * FROM family_metadata ORDER BY cached_at DESC;');

    const out: CachedFamilyMetadata[] = [];
    for (const row of rows) {
      try {
        const metadata = JSON.parse(
          await this.seal().open(CIPHER_LABELS.familyMetadata, row.sealed_metadata),
        ) as CachedFamilyMetadataPayload;
        out.push({
          familyId: row.family_id,
          memberCount: row.member_count,
          role: row.role as CachedFamilyMetadata['role'],
          cachedAt: row.cached_at,
          metadata,
        });
      } catch {
        await this.db().runAsync('DELETE FROM family_metadata WHERE family_id = ?;', [
          row.family_id,
        ]);
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Cached markers
  // -------------------------------------------------------------------------

  async saveMarkers(markers: readonly CachedMarker[]): Promise<void> {
    const database = this.db();
    const cipher = this.seal();
    const sealed = await Promise.all(
      markers.map(async (marker) => ({
        marker,
        // A member who is not SHARING has no coordinate to cache. This is the
        // structural guarantee behind spec §19: pausing removes the data, it
        // does not merely hide it.
        point:
          marker.point && marker.sharingStatus === 'SHARING'
            ? await cipher.seal(
                CIPHER_LABELS.markerPoint,
                JSON.stringify({
                  latitude: marker.point.latitude,
                  longitude: marker.point.longitude,
                }),
              )
            : null,
      })),
    );
    await database.withTransactionAsync(async () => {
      for (const entry of sealed) {
        await database.runAsync(
          `INSERT OR REPLACE INTO cached_markers
             (family_id, user_id, sharing_status, freshness, captured_at,
              horizontal_accuracy, sealed_point, cached_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
          [
            entry.marker.familyId,
            entry.marker.userId,
            entry.marker.sharingStatus,
            entry.marker.freshness,
            entry.marker.capturedAt,
            entry.point ? (entry.marker.point?.horizontalAccuracy ?? null) : null,
            entry.point,
            entry.marker.cachedAt,
          ],
        );
      }
    });
  }

  async loadMarkers(familyId: string): Promise<CachedMarker[]> {
    const rows = await this.db().getAllAsync<{
      family_id: string;
      user_id: string;
      sharing_status: string;
      freshness: string;
      captured_at: string | null;
      horizontal_accuracy: number | null;
      sealed_point: string | null;
      cached_at: string;
    }>('SELECT * FROM cached_markers WHERE family_id = ?;', [familyId]);

    const out: CachedMarker[] = [];
    for (const row of rows) {
      let point: CachedMarker['point'] = null;
      if (row.sealed_point) {
        try {
          const decoded = JSON.parse(
            await this.seal().open(CIPHER_LABELS.markerPoint, row.sealed_point),
          ) as { latitude: number; longitude: number };
          point = {
            latitude: decoded.latitude,
            longitude: decoded.longitude,
            horizontalAccuracy: row.horizontal_accuracy ?? 0,
          };
        } catch {
          point = null;
        }
      }
      out.push({
        familyId: row.family_id,
        userId: row.user_id,
        sharingStatus: row.sharing_status as CachedMarker['sharingStatus'],
        freshness: row.freshness as CachedMarker['freshness'],
        capturedAt: row.captured_at,
        cachedAt: row.cached_at,
        point,
      });
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Pending mutations
  // -------------------------------------------------------------------------

  async enqueueMutation(mutation: PendingMutation): Promise<void> {
    const sealed = await this.seal().seal(
      CIPHER_LABELS.mutationPayload,
      JSON.stringify(mutation.payload),
    );
    await this.db().runAsync(
      `INSERT OR REPLACE INTO pending_mutations
         (mutation_id, kind, idempotency_key, created_at, attempts,
          next_attempt_at, last_error_code, sealed_payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        mutation.mutationId,
        mutation.kind,
        mutation.idempotencyKey,
        mutation.createdAt,
        mutation.attempts,
        mutation.nextAttemptAt,
        mutation.lastErrorCode,
        sealed,
      ],
    );
  }

  async claimReadyMutations(limit: number, now: string): Promise<PendingMutation[]> {
    const rows = await this.db().getAllAsync<MutationRow>(
      `SELECT * FROM pending_mutations
        WHERE next_attempt_at <= ?
        ORDER BY created_at ASC
        LIMIT ?;`,
      [now, Math.max(0, limit)],
    );
    const out: PendingMutation[] = [];
    for (const row of rows) {
      try {
        const payload = JSON.parse(
          await this.seal().open(CIPHER_LABELS.mutationPayload, row.sealed_payload),
        ) as Record<string, unknown>;
        out.push({
          mutationId: row.mutation_id,
          kind: row.kind as PendingMutationKind,
          idempotencyKey: row.idempotency_key,
          createdAt: row.created_at,
          attempts: row.attempts,
          nextAttemptAt: row.next_attempt_at,
          lastErrorCode: toErrorCode(row.last_error_code),
          payload,
        });
      } catch {
        await this.removeMutation(row.mutation_id);
      }
    }
    return out;
  }

  async removeMutation(mutationId: string): Promise<void> {
    await this.db().runAsync('DELETE FROM pending_mutations WHERE mutation_id = ?;', [mutationId]);
  }

  async recordMutationAttempt(
    mutationId: string,
    input: { nextAttemptAt: string; errorCode: UploadErrorCode },
  ): Promise<void> {
    await this.db().runAsync(
      `UPDATE pending_mutations
          SET attempts = attempts + 1, next_attempt_at = ?, last_error_code = ?
        WHERE mutation_id = ?;`,
      [input.nextAttemptAt, input.errorCode, mutationId],
    );
  }

  // -------------------------------------------------------------------------
  // Remote configuration
  // -------------------------------------------------------------------------

  async saveRemoteConfig(record: StoredRemoteConfig): Promise<void> {
    await this.db().runAsync(
      `INSERT OR REPLACE INTO remote_config
         (id, config_version, fetched_at, signature_key_id, config_json)
       VALUES (1, ?, ?, ?, ?);`,
      [record.configVersion, record.fetchedAt, record.signatureKeyId, record.configJson],
    );
  }

  async loadRemoteConfig(): Promise<StoredRemoteConfig | null> {
    const row = await this.db().getFirstAsync<{
      config_version: number;
      fetched_at: string;
      signature_key_id: string;
      config_json: string;
    }>('SELECT * FROM remote_config WHERE id = 1;');
    if (!row) {
      return null;
    }
    return {
      configVersion: row.config_version,
      fetchedAt: row.fetched_at,
      signatureKeyId: row.signature_key_id,
      configJson: row.config_json,
    };
  }

  // -------------------------------------------------------------------------
  // Terms / privacy acceptance
  // -------------------------------------------------------------------------

  async saveAcceptanceVersions(record: AcceptanceVersions): Promise<void> {
    await this.db().runAsync(
      `INSERT OR REPLACE INTO acceptance_versions
         (id, terms_version, terms_accepted_at, privacy_version, privacy_accepted_at, updated_at)
       VALUES (1, ?, ?, ?, ?, ?);`,
      [
        record.termsVersion,
        record.termsAcceptedAt,
        record.privacyVersion,
        record.privacyAcceptedAt,
        record.updatedAt,
      ],
    );
  }

  async loadAcceptanceVersions(): Promise<AcceptanceVersions | null> {
    const row = await this.db().getFirstAsync<{
      terms_version: string | null;
      terms_accepted_at: string | null;
      privacy_version: string | null;
      privacy_accepted_at: string | null;
      updated_at: string;
    }>('SELECT * FROM acceptance_versions WHERE id = 1;');
    if (!row) {
      return null;
    }
    return {
      termsVersion: row.terms_version,
      termsAcceptedAt: row.terms_accepted_at,
      privacyVersion: row.privacy_version,
      privacyAcceptedAt: row.privacy_accepted_at,
      updatedAt: row.updated_at,
    };
  }

  // -------------------------------------------------------------------------
  // Purge
  // -------------------------------------------------------------------------

  async purgeAll(): Promise<void> {
    const database = this.db();
    await database.withTransactionAsync(async () => {
      for (const table of OWNED_TABLES) {
        // Table names come from our own constant list, never from input.
        await database.execAsync(`DELETE FROM ${table};`);
      }
    });
    // Return the pages to the OS instead of leaving freed ciphertext in the file.
    await database.execAsync('VACUUM;');
  }
}
