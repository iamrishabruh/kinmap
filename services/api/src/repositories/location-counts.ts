import { LIMITS, type UserId } from '@family/contracts';

/**
 * How many location rows an account still has, and nothing else about them.
 *
 * This function holds no coordinate key and has no business seeing a fix, so
 * this repository is built so that it *cannot*: its client exposes one
 * operation, a `Select: 'COUNT'` query, whose result type is a number and a
 * paging key. There is no shape in which an item could come back, which is a
 * stronger guarantee than a repository that reads rows and promises to ignore
 * them. The function's IAM policy states the same rule on the other side —
 * `dynamodb:Query` on the two location tables, conditioned on
 * `dynamodb:Select` being `COUNT`.
 *
 * A count of rows is not a coordinate. It is the one fact somebody needs before
 * they delete an account, and it can be produced without decrypting anything.
 */

export type CountQuery = {
  readonly TableName: string;
  readonly KeyConditionExpression: string;
  readonly ExpressionAttributeNames: Record<string, string>;
  readonly ExpressionAttributeValues: Record<string, unknown>;
  readonly ExclusiveStartKey?: Record<string, unknown>;
};

export type CountResult = {
  readonly Count: number;
  /**
   * Present when DynamoDB stopped at its 1 MB scan limit. It is a key — a user
   * id, a day partition and an event id — never an attribute of a row.
   */
  readonly LastEvaluatedKey?: Record<string, unknown>;
};

export interface CountingClient {
  count(input: CountQuery): Promise<CountResult>;
}

export type LocationTableNames = {
  readonly currentLocations: string;
  readonly locationHistory: string;
};

export interface LocationCountsRepository {
  /**
   * Every stored point that an account deletion would erase: the latest fix
   * held per device plus the history rows inside the sweep window.
   */
  countStoredPoints(input: { userId: UserId; now: Date }): Promise<number>;
}

/**
 * TTL expiry is asynchronous — DynamoDB may take up to two days to remove an
 * expired row — so a partition a little past retention can still hold points.
 * services/deletion-worker sweeps retention plus a margin for exactly that
 * reason (`HISTORY_DELETION_LOOKBACK_DAYS` in infrastructure/stacks/privacy-stack),
 * and this count uses the same window: counting a narrower one than the purge
 * deletes would produce the surprise this endpoint exists to prevent.
 */
const TTL_LAG_MARGIN_DAYS = 7;
const HISTORY_LOOKBACK_DAYS = LIMITS.HISTORY_RETENTION_DAYS + TTL_LAG_MARGIN_DAYS;

/**
 * `USER#<userId>#DAY#<yyyy-mm-dd>` — the LocationHistory partition key, written
 * by services/location-ingestion and swept by services/deletion-worker
 * (`historyPartitionKey` in its `job.ts`). The format is restated here rather
 * than imported because this service does not depend on the worker; a change to
 * it has to be made in both places, and a mismatch shows up as a preview that
 * reports zero.
 */
function historyPartitionKey(userId: UserId, day: string): string {
  return `USER#${userId}#DAY#${day}`;
}

function dayKey(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}

/** The day partitions that could still hold a row, newest first. */
function lookbackDays(now: Date): string[] {
  const days: string[] = [];
  for (let offset = 0; offset < HISTORY_LOOKBACK_DAYS; offset += 1) {
    days.push(dayKey(new Date(now.getTime() - offset * 86_400_000)));
  }
  return days;
}

export function createLocationCountsRepository(
  client: CountingClient,
  tables: LocationTableNames,
): LocationCountsRepository {
  /**
   * Counts one partition, following the paging key when DynamoDB stops early.
   * A count query is still bounded by the 1 MB scan limit, so a busy day is
   * several round trips rather than a silently truncated number.
   */
  async function countPartition(input: {
    tableName: string;
    keyName: string;
    keyValue: string;
  }): Promise<number> {
    let total = 0;
    let cursor: Record<string, unknown> | undefined;
    do {
      const page = await client.count({
        TableName: input.tableName,
        KeyConditionExpression: '#k = :k',
        ExpressionAttributeNames: { '#k': input.keyName },
        ExpressionAttributeValues: { ':k': input.keyValue },
        ExclusiveStartKey: cursor,
      });
      total += page.Count;
      cursor = page.LastEvaluatedKey;
    } while (cursor !== undefined);
    return total;
  }

  return {
    async countStoredPoints(input): Promise<number> {
      // The latest fix per device. The deletion job erases these first
      // (`DELETE_CURRENT_LOCATIONS`), so they belong in the total.
      let total = await countPartition({
        tableName: tables.currentLocations,
        keyName: 'userId',
        keyValue: input.userId,
      });

      // One query per day partition, serially: the window is bounded by
      // retention, and the endpoint that calls this draws on the tightest read
      // budget in the router.
      for (const day of lookbackDays(input.now)) {
        total += await countPartition({
          tableName: tables.locationHistory,
          keyName: 'pk',
          keyValue: historyPartitionKey(input.userId, day),
        });
      }

      return total;
    },
  };
}
