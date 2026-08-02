import type { ExpressionAttributeNames, ExpressionAttributeValues } from './document-client.js';

/**
 * Update-expression builders.
 *
 * Every attribute goes through a `#placeholder`, without exception. Half of the
 * words this domain uses — `status`, `name`, `timestamp`, `role`, `owner` — are
 * DynamoDB reserved words, and remembering which is a bug waiting to happen.
 */

export type SetExpression = {
  readonly UpdateExpression: string;
  readonly ExpressionAttributeNames: ExpressionAttributeNames;
  /** Absent for a REMOVE-only expression: DynamoDB rejects an empty value map. */
  readonly ExpressionAttributeValues: ExpressionAttributeValues | undefined;
};

/**
 * Builds `SET a = :a, b = :b` from a patch, skipping `undefined` values so a
 * partial update never writes a null over a field the caller did not mention.
 * A `null` value IS written: it is how the API clears an optional field.
 */
export function buildSetExpression(
  patch: Readonly<Record<string, unknown>>,
  options: { readonly removeWhenNull?: readonly string[] } = {},
): SetExpression | null {
  const removeWhenNull = new Set(options.removeWhenNull ?? []);
  const names: ExpressionAttributeNames = {};
  const values: ExpressionAttributeValues = {};
  const sets: string[] = [];
  const removes: string[] = [];

  let index = 0;
  for (const [attribute, value] of Object.entries(patch)) {
    if (value === undefined) {
      continue;
    }
    const namePlaceholder = `#a${String(index)}`;
    names[namePlaceholder] = attribute;

    if (value === null && removeWhenNull.has(attribute)) {
      // A sparse GSI key must be absent, not null, or DynamoDB rejects the write.
      removes.push(namePlaceholder);
    } else {
      const valuePlaceholder = `:a${String(index)}`;
      values[valuePlaceholder] = value;
      sets.push(`${namePlaceholder} = ${valuePlaceholder}`);
    }
    index += 1;
  }

  if (sets.length === 0 && removes.length === 0) {
    return null;
  }

  const clauses: string[] = [];
  if (sets.length > 0) {
    clauses.push(`SET ${sets.join(', ')}`);
  }
  if (removes.length > 0) {
    clauses.push(`REMOVE ${removes.join(', ')}`);
  }

  return {
    UpdateExpression: clauses.join(' '),
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: Object.keys(values).length > 0 ? values : undefined,
  };
}

/** Seconds-since-epoch value for a DynamoDB TTL attribute. */
export function ttlAt(now: Date, seconds: number): number {
  return Math.floor(now.getTime() / 1000) + seconds;
}
