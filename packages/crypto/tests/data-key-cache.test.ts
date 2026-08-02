import { describe, expect, it } from 'vitest';

import {
  DataKeyCache,
  DEFAULT_DATA_KEY_TTL_MS,
  DEFAULT_MAX_CACHED_DATA_KEYS,
  type DataKeyCacheEntry,
  type DataKeyEvictionReason,
} from '../src/index.js';

function entry(seed: number): DataKeyCacheEntry {
  return {
    plaintextKey: Buffer.alloc(32, seed),
    encryptedDataKey: Buffer.alloc(61, seed),
    keyId: `key-${String(seed)}`,
  };
}

describe('DataKeyCache', () => {
  it('uses privacy-safe defaults', () => {
    const cache = new DataKeyCache();
    expect(cache.ttlMs).toBe(DEFAULT_DATA_KEY_TTL_MS);
    expect(cache.maxEntries).toBe(DEFAULT_MAX_CACHED_DATA_KEYS);
    expect(cache.size).toBe(0);
  });

  it('rejects nonsensical bounds rather than growing without limit', () => {
    expect(() => new DataKeyCache({ maxEntries: 0 })).toThrow(RangeError);
    expect(() => new DataKeyCache({ ttlMs: 0 })).toThrow(RangeError);
    expect(() => new DataKeyCache({ ttlMs: -1 })).toThrow(RangeError);
  });

  it('stores a defensive copy so the caller can zeroise its own buffer', () => {
    const cache = new DataKeyCache();
    const original = entry(7);
    cache.set('k', original);
    original.plaintextKey.fill(0);

    const stored = cache.get('k');
    expect(stored?.plaintextKey.every((byte) => byte === 7)).toBe(true);
  });

  it('refuses key material that is not AES-256', () => {
    const cache = new DataKeyCache();
    expect(() => cache.set('k', { ...entry(1), plaintextKey: Buffer.alloc(16, 1) })).toThrow(
      RangeError,
    );
  });

  it('expires entries once the TTL passes', () => {
    let clock = 0;
    const cache = new DataKeyCache({ ttlMs: 1_000, now: () => clock });
    cache.set('k', entry(1));

    clock = 999;
    expect(cache.get('k')).toBeDefined();

    clock = 1_000;
    expect(cache.get('k')).toBeUndefined();
    expect(cache.size).toBe(0);
    expect(cache.stats.expirations).toBe(1);
  });

  it('does not extend the TTL on a read', () => {
    let clock = 0;
    const cache = new DataKeyCache({ ttlMs: 1_000, now: () => clock });
    cache.set('k', entry(1));

    clock = 500;
    expect(cache.get('k')).toBeDefined();

    clock = 1_001;
    expect(cache.get('k')).toBeUndefined();
  });

  it('evicts the least recently used entry at capacity', () => {
    const cache = new DataKeyCache({ maxEntries: 2, ttlMs: 60_000 });
    cache.set('a', entry(1));
    cache.set('b', entry(2));
    // Touch "a" so "b" becomes the eviction candidate.
    expect(cache.get('a')).toBeDefined();
    cache.set('c', entry(3));

    expect(cache.size).toBe(2);
    expect(cache.get('a')).toBeDefined();
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBeDefined();
    expect(cache.stats.capacityEvictions).toBe(1);
  });

  it('never exceeds its bound under churn', () => {
    const cache = new DataKeyCache({ maxEntries: 3, ttlMs: 60_000 });
    for (let index = 0; index < 100; index += 1) {
      cache.set(`k${String(index)}`, entry(index % 251));
      expect(cache.size).toBeLessThanOrEqual(3);
    }
    expect(cache.size).toBe(3);
  });

  it('zeroises key material on every removal path', () => {
    const removals: Array<{ reason: DataKeyEvictionReason; key: Buffer }> = [];
    let clock = 0;
    const cache = new DataKeyCache({
      maxEntries: 1,
      ttlMs: 1_000,
      now: () => clock,
      onEvict: (_key, evicted, reason) => {
        removals.push({ reason, key: evicted.plaintextKey });
      },
    });

    cache.set('a', entry(1));
    cache.set('b', entry(2)); // capacity eviction of "a"
    cache.set('b', entry(3)); // replacement of "b"
    clock = 5_000;
    cache.get('b'); // expiry
    cache.set('c', entry(4));
    cache.delete('c'); // explicit delete
    cache.set('d', entry(5));
    cache.clear(); // shutdown

    expect(removals.map((removal) => removal.reason)).toEqual([
      'CAPACITY',
      'REPLACED',
      'EXPIRED',
      'DELETED',
      'CLEARED',
    ]);
    for (const removal of removals) {
      expect(removal.key.every((byte) => byte === 0)).toBe(true);
    }
  });

  it('pruneExpired drops only stale entries', () => {
    let clock = 0;
    const cache = new DataKeyCache({ maxEntries: 10, ttlMs: 1_000, now: () => clock });
    cache.set('old', entry(1));
    clock = 900;
    cache.set('new', entry(2));
    clock = 1_500;

    expect(cache.pruneExpired()).toBe(1);
    expect(cache.size).toBe(1);
    expect(cache.get('new')).toBeDefined();
  });

  it('tracks hits and misses', () => {
    const cache = new DataKeyCache({ maxEntries: 4, ttlMs: 60_000 });
    cache.set('a', entry(1));
    cache.get('a');
    cache.get('a');
    cache.get('missing');

    expect(cache.stats.hits).toBe(2);
    expect(cache.stats.misses).toBe(1);
  });
});
