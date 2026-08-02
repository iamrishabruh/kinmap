/**
 * Value helpers shared by the expression evaluator and the store.
 *
 * The fake models DynamoDB *document* values (what `DynamoDBDocumentClient`
 * hands you), not the low-level `{ S: '...' }` wire format.
 */

export type Item = Record<string, unknown>;

/** Structural clone. Keeps the store isolated from whatever a caller mutates. */
export function cloneValue<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return new Date(value.getTime()) as unknown as T;
  if (value instanceof Uint8Array) return new Uint8Array(value) as unknown as T;
  if (value instanceof Set) return new Set([...value].map(cloneValue)) as unknown as T;
  if (value instanceof Map) {
    return new Map([...value].map(([key, entry]) => [key, cloneValue(entry)])) as unknown as T;
  }
  if (Array.isArray(value)) return value.map(cloneValue) as unknown as T;

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    result[key] = cloneValue(entry);
  }
  return result as T;
}

export function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== typeof right) return false;
  if (left === null || right === null) return false;
  if (left instanceof Date && right instanceof Date) return left.getTime() === right.getTime();

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    if (left.length !== right.length) return false;
    return left.every((entry, index) => deepEqual(entry, right[index]));
  }

  if (left instanceof Set && right instanceof Set) {
    if (left.size !== right.size) return false;
    return [...left].every((entry) => right.has(entry));
  }

  if (typeof left === 'object' && typeof right === 'object') {
    const leftKeys = Object.keys(left as Item);
    const rightKeys = Object.keys(right as Item);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key) => deepEqual((left as Item)[key], (right as Item)[key]));
  }

  return false;
}

/**
 * DynamoDB orders numbers numerically, strings by UTF-8 bytes, and refuses to
 * compare across types. Returns null when the comparison is undefined, which
 * every caller treats as "condition false" — matching DynamoDB, which simply
 * does not match rather than erroring.
 */
export function compareValues(left: unknown, right: unknown): number | null {
  if (typeof left === 'number' && typeof right === 'number') {
    return left === right ? 0 : left < right ? -1 : 1;
  }
  if (typeof left === 'string' && typeof right === 'string') {
    return left === right ? 0 : left < right ? -1 : 1;
  }
  if (typeof left === 'boolean' && typeof right === 'boolean') {
    return left === right ? 0 : left ? 1 : -1;
  }
  return null;
}

/** Maps a document value onto the `attribute_type` code DynamoDB would report. */
export function attributeTypeOf(value: unknown): string | null {
  if (value === null) return 'NULL';
  if (typeof value === 'string') return 'S';
  if (typeof value === 'number') return 'N';
  if (typeof value === 'boolean') return 'BOOL';
  if (value instanceof Uint8Array) return 'B';
  if (Array.isArray(value)) return 'L';
  if (value instanceof Set) {
    const [first] = value;
    if (typeof first === 'number') return 'NS';
    if (value.size > 0 && first instanceof Uint8Array) return 'BS';
    return 'SS';
  }
  if (typeof value === 'object') return 'M';
  return null;
}

export function sizeOf(value: unknown): number | undefined {
  if (typeof value === 'string') return value.length;
  if (value instanceof Uint8Array) return value.byteLength;
  if (Array.isArray(value)) return value.length;
  if (value instanceof Set) return value.size;
  if (value !== null && typeof value === 'object') return Object.keys(value as Item).length;
  return undefined;
}
