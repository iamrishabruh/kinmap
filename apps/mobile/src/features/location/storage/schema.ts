/**
 * Local SQLite schema (spec §11).
 *
 * Column naming convention: anything prefixed `sealed_` holds a
 * `HMAC-SHA256-CTR-ETM-v1` envelope produced by `crypto/field-cipher.ts`. No
 * other column may ever hold a coordinate, a display name, an email, an avatar
 * URL, or a saved-place name.
 *
 * Migrations are driven by `PRAGMA user_version`; each entry is applied exactly
 * once, in order, inside a transaction.
 */

export const DATABASE_NAME = 'family-location.db';

export const LATEST_SCHEMA_VERSION = 1;

/** Label passed to the field cipher; also the domain separator in the AEAD. */
export const CIPHER_LABELS = {
  pendingEvent: 'pending_event.payload',
  lastAcceptedLocation: 'last_accepted_location.point',
  familyMetadata: 'family_metadata.payload',
  markerPoint: 'cached_marker.point',
  mutationPayload: 'pending_mutation.payload',
} as const;

export type Migration = {
  version: number;
  statements: readonly string[];
};

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS pending_events (
         event_id            TEXT PRIMARY KEY NOT NULL,
         device_id           TEXT NOT NULL,
         sequence_number     INTEGER NOT NULL,
         captured_at         TEXT NOT NULL,
         queued_at           TEXT NOT NULL,
         tracking_mode       TEXT NOT NULL,
         attempts            INTEGER NOT NULL DEFAULT 0,
         next_attempt_at     TEXT NOT NULL,
         last_error_code     TEXT,
         sealed_payload      TEXT NOT NULL
       );`,
      `CREATE INDEX IF NOT EXISTS idx_pending_events_ready
         ON pending_events (next_attempt_at, sequence_number);`,
      `CREATE INDEX IF NOT EXISTS idx_pending_events_queued_at
         ON pending_events (queued_at);`,

      `CREATE TABLE IF NOT EXISTS last_accepted_location (
         id                  INTEGER PRIMARY KEY CHECK (id = 1),
         captured_at         TEXT NOT NULL,
         accepted_at         TEXT NOT NULL,
         horizontal_accuracy REAL NOT NULL,
         tracking_mode       TEXT NOT NULL,
         sealed_point        TEXT NOT NULL
       );`,

      `CREATE TABLE IF NOT EXISTS engine_state (
         id                     INTEGER PRIMARY KEY CHECK (id = 1),
         tracking_state         TEXT NOT NULL,
         sharing_status         TEXT NOT NULL,
         sharing_enabled        INTEGER NOT NULL,
         sharing_paused         INTEGER NOT NULL,
         last_sequence_number   INTEGER NOT NULL DEFAULT 0,
         last_upload_attempt_at TEXT,
         last_upload_error      TEXT,
         updated_at             TEXT NOT NULL
       );`,

      `CREATE TABLE IF NOT EXISTS family_metadata (
         family_id       TEXT PRIMARY KEY NOT NULL,
         member_count    INTEGER NOT NULL,
         role            TEXT NOT NULL,
         cached_at       TEXT NOT NULL,
         sealed_metadata TEXT NOT NULL
       );`,

      `CREATE TABLE IF NOT EXISTS cached_markers (
         family_id           TEXT NOT NULL,
         user_id             TEXT NOT NULL,
         sharing_status      TEXT NOT NULL,
         freshness           TEXT NOT NULL,
         captured_at         TEXT,
         horizontal_accuracy REAL,
         sealed_point        TEXT,
         cached_at           TEXT NOT NULL,
         PRIMARY KEY (family_id, user_id)
       );`,

      `CREATE TABLE IF NOT EXISTS pending_mutations (
         mutation_id     TEXT PRIMARY KEY NOT NULL,
         kind            TEXT NOT NULL,
         idempotency_key TEXT NOT NULL,
         created_at      TEXT NOT NULL,
         attempts        INTEGER NOT NULL DEFAULT 0,
         next_attempt_at TEXT NOT NULL,
         last_error_code TEXT,
         sealed_payload  TEXT NOT NULL
       );`,
      `CREATE INDEX IF NOT EXISTS idx_pending_mutations_ready
         ON pending_mutations (next_attempt_at, created_at);`,

      `CREATE TABLE IF NOT EXISTS remote_config (
         id                INTEGER PRIMARY KEY CHECK (id = 1),
         config_version    INTEGER NOT NULL,
         fetched_at        TEXT NOT NULL,
         signature_key_id  TEXT NOT NULL,
         config_json       TEXT NOT NULL
       );`,

      `CREATE TABLE IF NOT EXISTS acceptance_versions (
         id                 INTEGER PRIMARY KEY CHECK (id = 1),
         terms_version      TEXT,
         terms_accepted_at  TEXT,
         privacy_version    TEXT,
         privacy_accepted_at TEXT,
         updated_at         TEXT NOT NULL
       );`,
    ],
  },
];

/** Every table this feature owns; the sign-out purge iterates exactly this list. */
export const OWNED_TABLES: readonly string[] = [
  'pending_events',
  'last_accepted_location',
  'engine_state',
  'family_metadata',
  'cached_markers',
  'pending_mutations',
  'remote_config',
  'acceptance_versions',
];
