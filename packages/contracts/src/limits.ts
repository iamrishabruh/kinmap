/**
 * Hard platform bounds (spec §37). These are cost and abuse controls, enforced
 * server-side. Remote configuration may tighten them but must never exceed
 * them — native code clamps to these values (spec §30).
 */
export const LIMITS = {
  /** Maximum location events accepted in a single batch upload. */
  MAX_EVENTS_PER_BATCH: 100,
  /** Maximum decoded request body accepted by the ingestion endpoint. */
  MAX_BATCH_PAYLOAD_BYTES: 256 * 1024,
  /** Minimum seconds between accepted batch uploads from one device. */
  MIN_UPLOAD_INTERVAL_SECONDS: 30,
  /** Live sessions expire automatically; the client cannot extend past this. */
  MAX_LIVE_SESSION_SECONDS: 10 * 60,
  /** A given target may be observed by at most one live session at a time. */
  MAX_CONCURRENT_LIVE_SESSIONS_PER_TARGET: 1,
  /** Inclusive upper bound on a history query window. */
  MAX_HISTORY_RANGE_DAYS: 31,
  /** Maximum history rows returned in one page. */
  MAX_HISTORY_PAGE_SIZE: 1000,
  DEFAULT_HISTORY_PAGE_SIZE: 200,
  /** Retention applied via DynamoDB TTL for paid plans. */
  HISTORY_RETENTION_DAYS: 30,
  /** Absolute ceiling regardless of plan. */
  MAX_FAMILY_MEMBERS: 12,
  MAX_SAVED_PLACES: 200,
  /** Invitation controls (spec §17). */
  INVITATION_TTL_HOURS: 72,
  MAX_INVITATION_REDEMPTIONS: 1,
  MAX_ACTIVE_INVITATIONS_PER_FAMILY: 10,
  /** Local on-device queue caps (spec §11). */
  MAX_QUEUED_EVENTS: 5000,
  MAX_QUEUE_AGE_HOURS: 72,
  MAX_UPLOAD_ATTEMPTS: 8,
} as const;

/**
 * Location acceptance thresholds. Points failing these are rejected at
 * ingestion and counted as a metric rather than silently dropped.
 */
export const ACCEPTANCE = {
  /** Points less accurate than this are not trustworthy enough to store. */
  MAX_HORIZONTAL_ACCURACY_METERS: 500,
  /** Negative accuracy means "invalid fix" on both platforms. */
  MIN_HORIZONTAL_ACCURACY_METERS: 0,
  /** Reject clock-skewed events claiming to be from the future. */
  MAX_CLOCK_SKEW_FUTURE_SECONDS: 120,
  /** Reject events older than the local queue is allowed to hold. */
  MAX_EVENT_AGE_SECONDS: LIMITS.MAX_QUEUE_AGE_HOURS * 3600,
  /** Two points closer than this in space AND time are duplicates. */
  DUPLICATE_DISTANCE_METERS: 20,
  DUPLICATE_WINDOW_SECONDS: 60,
  /** Implausible ground speed implies a spoofed or corrupt fix. */
  MAX_PLAUSIBLE_SPEED_MPS: 350,
} as const;

/** Freshness buckets, in seconds since capture (spec §19). */
export const FRESHNESS_THRESHOLDS = {
  LIVE_SECONDS: 60,
  FRESH_SECONDS: 10 * 60,
  RECENT_SECONDS: 60 * 60,
} as const;

/** Battery thresholds driving state transitions (spec §10). */
export const BATTERY = {
  LOW_THRESHOLD: 0.2,
  CRITICAL_THRESHOLD: 0.1,
  /** Hysteresis so a device hovering at a threshold does not oscillate. */
  RECOVERY_MARGIN: 0.05,
} as const;

/** Per-principal API rate limits, requests per minute. */
export const RATE_LIMITS = {
  LOCATION_BATCH_PER_DEVICE: 4,
  CURRENT_LOCATION_PER_USER: 60,
  HISTORY_READ_PER_USER: 20,
  LIVE_SESSION_CREATE_PER_USER: 6,
  INVITATION_CREATE_PER_FAMILY: 10,
  INVITATION_ACCEPT_PER_IP: 10,
  ACCOUNT_MUTATION_PER_USER: 30,
} as const;
