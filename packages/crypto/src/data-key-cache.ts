import { DATA_KEY_BYTES } from './types.js';

/**
 * Bounded, TTL'd, in-memory cache of *plaintext* data keys (spec §20).
 *
 * Rules this class exists to enforce:
 *  - plaintext key material lives in process memory only, never on disk, never
 *    in a log, never in a response;
 *  - it expires on a wall clock so a long-lived Lambda container cannot hold a
 *    usable key for a family long after the last legitimate request;
 *  - the cache is bounded so a burst of distinct families cannot grow the
 *    process heap without limit;
 *  - every removal path zeroises the buffer before dropping the reference, so a
 *    heap dump taken after eviction does not yield a key.
 */

export const DEFAULT_DATA_KEY_TTL_MS = 5 * 60_000;
export const DEFAULT_MAX_CACHED_DATA_KEYS = 256;

export type DataKeyCacheEntry = {
  /** Raw AES-256 key material. Callers must use it synchronously and must not retain it. */
  plaintextKey: Buffer;
  /** The KMS-wrapped form, persisted with each record. */
  encryptedDataKey: Buffer;
  keyId: string;
};

export type DataKeyEvictionReason = 'EXPIRED' | 'CAPACITY' | 'REPLACED' | 'DELETED' | 'CLEARED';

export type DataKeyCacheOptions = {
  maxEntries?: number;
  ttlMs?: number;
  /** Injectable clock; defaults to `Date.now`. */
  now?: () => number;
  /**
   * Observability hook. Invoked with the entry *before* its key material is
   * zeroised. Implementations must not persist or log the buffer.
   */
  onEvict?: (key: string, entry: DataKeyCacheEntry, reason: DataKeyEvictionReason) => void;
};

export type DataKeyCacheStats = {
  hits: number;
  misses: number;
  expirations: number;
  capacityEvictions: number;
};

type StoredEntry = DataKeyCacheEntry & { expiresAtMs: number };

export class DataKeyCache {
  readonly maxEntries: number;
  readonly ttlMs: number;

  /** Insertion order doubles as LRU order: a hit re-inserts at the tail. */
  private readonly entries = new Map<string, StoredEntry>();
  private readonly now: () => number;
  private readonly onEvict:
    ((key: string, entry: DataKeyCacheEntry, reason: DataKeyEvictionReason) => void) | undefined;

  private hits = 0;
  private misses = 0;
  private expirations = 0;
  private capacityEvictions = 0;

  constructor(options: DataKeyCacheOptions = {}) {
    const maxEntries = options.maxEntries ?? DEFAULT_MAX_CACHED_DATA_KEYS;
    const ttlMs = options.ttlMs ?? DEFAULT_DATA_KEY_TTL_MS;
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError('DataKeyCache maxEntries must be a positive integer.');
    }
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new RangeError('DataKeyCache ttlMs must be a positive number.');
    }
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
    this.now = options.now ?? Date.now;
    this.onEvict = options.onEvict;
  }

  get size(): number {
    return this.entries.size;
  }

  get stats(): DataKeyCacheStats {
    return {
      hits: this.hits,
      misses: this.misses,
      expirations: this.expirations,
      capacityEvictions: this.capacityEvictions,
    };
  }

  /**
   * Returns the cached entry, or `undefined` when absent or expired. The
   * returned buffers are the cache's own; use them synchronously.
   */
  get(key: string): DataKeyCacheEntry | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) {
      this.misses += 1;
      return undefined;
    }
    if (this.now() >= entry.expiresAtMs) {
      this.entries.delete(key);
      this.expirations += 1;
      this.misses += 1;
      this.destroy(key, entry, 'EXPIRED');
      return undefined;
    }
    // Refresh recency without extending the TTL: a key still dies on schedule.
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.hits += 1;
    return entry;
  }

  /** Stores a defensive copy so the caller may zeroise its own buffers. */
  set(key: string, entry: DataKeyCacheEntry): void {
    if (entry.plaintextKey.length !== DATA_KEY_BYTES) {
      throw new RangeError('DataKeyCache accepts AES-256 key material only.');
    }
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      this.entries.delete(key);
      this.destroy(key, existing, 'REPLACED');
    }
    this.entries.set(key, {
      plaintextKey: Buffer.from(entry.plaintextKey),
      encryptedDataKey: Buffer.from(entry.encryptedDataKey),
      keyId: entry.keyId,
      expiresAtMs: this.now() + this.ttlMs,
    });
    this.evictToCapacity();
  }

  delete(key: string): boolean {
    const entry = this.entries.get(key);
    if (entry === undefined) {
      return false;
    }
    this.entries.delete(key);
    this.destroy(key, entry, 'DELETED');
    return true;
  }

  /** Drops and zeroises every entry. Call on credential rotation or shutdown. */
  clear(): void {
    for (const [key, entry] of [...this.entries]) {
      this.entries.delete(key);
      this.destroy(key, entry, 'CLEARED');
    }
  }

  /** Removes only entries whose TTL has already passed. */
  pruneExpired(): number {
    const nowMs = this.now();
    let pruned = 0;
    for (const [key, entry] of [...this.entries]) {
      if (nowMs >= entry.expiresAtMs) {
        this.entries.delete(key);
        this.expirations += 1;
        pruned += 1;
        this.destroy(key, entry, 'EXPIRED');
      }
    }
    return pruned;
  }

  private evictToCapacity(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) {
        return;
      }
      const key = oldest.value;
      const entry = this.entries.get(key);
      this.entries.delete(key);
      this.capacityEvictions += 1;
      if (entry !== undefined) {
        this.destroy(key, entry, 'CAPACITY');
      }
    }
  }

  private destroy(key: string, entry: StoredEntry, reason: DataKeyEvictionReason): void {
    this.onEvict?.(key, entry, reason);
    entry.plaintextKey.fill(0);
  }
}
