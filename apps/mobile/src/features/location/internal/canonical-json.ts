/**
 * Deterministic JSON serialisation.
 *
 * A signature over `JSON.stringify(payload)` is only verifiable if both sides
 * agree on key order and on how `undefined` is treated. `JSON.stringify`
 * preserves insertion order, which differs between the server's serialiser and
 * whatever order the client happens to rebuild the object in, so the canonical
 * form sorts keys and drops `undefined` before signing or verifying.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('Cannot canonicalise a non-finite number.');
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    const body = entries
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJson(entryValue)}`)
      .join(',');
    return `{${body}}`;
  }
  throw new Error('Cannot canonicalise this value type.');
}
