import { z } from 'zod';

import {
  AppError,
  FamilyIdSchema,
  LIMITS,
  SessionIdSchema,
  UserIdSchema,
  type UserId,
} from '@family/contracts';
import {
  IsoDateTimeSchema,
  LiveSessionEndReasonSchema,
  LiveSessionReasonSchema,
  LiveSessionStatusSchema,
  type LiveSession,
  type LiveSessionEndReason,
  type LiveSessionStatus,
} from '@family/schemas';

import { isConditionalCheckFailed, type DocumentClient, type Item } from './document-client.js';

/**
 * The LiveSessions table: one row per session, keyed by `sessionId`, with a
 * `byTarget` index answering "who is watching me?" and a `byRequester` index
 * answering "who am I watching?" without a scan.
 *
 * Three properties this module exists to hold:
 *
 *  - No coordinate is stored, projected or logged here. A live session is a
 *    consent grant — it raises the target's update rate for a bounded window —
 *    and the positions it leads to are read through the location service, which
 *    re-checks membership and sharing on every single call.
 *  - `startedAt` is the sort key of *both* indexes, so it is never absent. A row
 *    without it drops out of the index that the expiry sweep and account
 *    deletion query, which is precisely how a session outlives the consent for
 *    it.
 *  - `expiresAt` is the deadline in epoch seconds and doubles as the table's
 *    TTL attribute, so the row is reaped once the session it describes can no
 *    longer be running. It is never trusted on its own: {@link settleLiveSession}
 *    re-derives the deadline against the platform ceiling on every read, so a
 *    row claiming a longer window than `LIMITS.MAX_LIVE_SESSION_SECONDS` buys
 *    nobody an extra minute of watching another person.
 */

/** `@family/contracts` publishes the schema but no alias; both are strings. */
export type SessionId = z.infer<typeof SessionIdSchema>;

/** Statuses in which a session can still raise the target's update rate. */
export const LIVE_SESSION_OPEN_STATUSES: readonly LiveSessionStatus[] = ['REQUESTED', 'ACTIVE'];

export const LiveSessionRecordSchema = z.object({
  sessionId: SessionIdSchema,
  familyId: FamilyIdSchema,
  /**
   * Partition key of the `byRequester` index. The attribute names here are the
   * ones the deletion worker, the notification worker and the expiry sweep
   * already query this table by; renaming either would make their queries miss.
   */
  requesterUserId: UserIdSchema,
  /** Partition key of the `byTarget` index. */
  targetUserId: UserIdSchema,
  status: LiveSessionStatusSchema,
  reason: LiveSessionReasonSchema,
  requestedAt: IsoDateTimeSchema,
  /**
   * Sort key on both indexes, and the instant the granted window is measured
   * from. It is the request instant while the session waits for an answer, and
   * is re-stamped to the moment of consent when the target accepts — so the
   * window a target grants runs from when they granted it, not from when they
   * were asked.
   */
  startedAt: IsoDateTimeSchema,
  respondedAt: IsoDateTimeSchema.nullable().default(null),
  endedAt: IsoDateTimeSchema.nullable().default(null),
  endedReason: LiveSessionEndReasonSchema.nullable().default(null),
  requestedDurationSeconds: z.number().int().positive(),
  /** Non-null once accepted. Never more than was asked for, never above the cap. */
  grantedDurationSeconds: z.number().int().positive().nullable().default(null),
  updateIntervalSeconds: z.number().int().positive(),
  /** Epoch SECONDS, applied by the table's TTL. Absent means "keep this row". */
  expiresAt: z.number().int().positive().nullable().default(null),
  /**
   * Set when the target refused and asked never to be asked again by this
   * requester. It is a standing decision rather than a fact about one session,
   * so the row that carries it is kept rather than reaped.
   */
  muteFutureRequests: z.boolean().default(false),
  updatedAt: IsoDateTimeSchema,
});
export type LiveSessionRecord = z.infer<typeof LiveSessionRecordSchema>;

export interface LiveSessionsRepository {
  get(sessionId: SessionId): Promise<LiveSessionRecord | null>;
  /** Every session in which this person is the one being watched, newest first. */
  listForTarget(targetUserId: UserId): Promise<LiveSessionRecord[]>;
  /** Every session this person asked for, newest first. */
  listForRequester(requesterUserId: UserId): Promise<LiveSessionRecord[]>;
  create(record: LiveSessionRecord): Promise<void>;
  /** Null when the session was no longer waiting for an answer. */
  activate(input: {
    sessionId: SessionId;
    grantedDurationSeconds: number;
    /** Epoch seconds. The hard stop, already clamped by the caller. */
    expiresAt: number;
    now: Date;
  }): Promise<LiveSessionRecord | null>;
  /** Null when the session was not in one of the `from` statuses. */
  close(input: {
    sessionId: SessionId;
    from: readonly LiveSessionStatus[];
    status: LiveSessionStatus;
    endedReason: LiveSessionEndReason;
    /** Defaults to `now`; the expiry sweep passes the deadline it actually hit. */
    endedAt?: string;
    /** True when this close is the target's answer to a pending request. */
    respondsToRequest?: boolean;
    muteFutureRequests?: boolean;
    now: Date;
  }): Promise<LiveSessionRecord | null>;
}

/**
 * The container slice this area needs.
 *
 * Named here so a route can depend on the repository rather than on the shape
 * of `ApiServices` while the two are being wired together.
 */
export type LiveSessionServices = {
  readonly liveSessions: LiveSessionsRepository;
};

export function isLiveSessionOpen(status: LiveSessionStatus): boolean {
  return LIVE_SESSION_OPEN_STATUSES.includes(status);
}

/**
 * The instant a session must stop, in epoch milliseconds.
 *
 * The platform ceiling wins over the stored deadline, always. A row claiming to
 * run longer than `LIMITS.MAX_LIVE_SESSION_SECONDS` is a bug or tampering, and
 * either way it must not extend anybody's window. Null when the row cannot be
 * dated at all, which the caller must read as "ends now" rather than "never".
 */
export function liveSessionDeadlineMs(
  record: Pick<LiveSessionRecord, 'startedAt' | 'expiresAt'>,
): number | null {
  const startedMs = Date.parse(record.startedAt);
  const ceilingMs = Number.isNaN(startedMs)
    ? null
    : startedMs + LIMITS.MAX_LIVE_SESSION_SECONDS * 1000;
  const storedMs = record.expiresAt === null ? null : record.expiresAt * 1000;

  if (ceilingMs === null) {
    return storedMs;
  }
  return storedMs === null ? ceilingMs : Math.min(ceilingMs, storedMs);
}

/**
 * The session as it must be seen *now*.
 *
 * Expiry is a deadline, not an event: the sweep that closes lapsed rows runs on
 * a schedule, and between two of its runs the stored status still says ACTIVE.
 * Every read goes through here so that a session past its deadline is never
 * answered, counted against the concurrency limit, or accepted — whether or not
 * the sweep has reached it yet.
 */
export function settleLiveSession(record: LiveSessionRecord, now: Date): LiveSessionRecord {
  if (!isLiveSessionOpen(record.status)) {
    return record;
  }
  const deadlineMs = liveSessionDeadlineMs(record);
  if (deadlineMs !== null && deadlineMs > now.getTime()) {
    return record;
  }
  return {
    ...record,
    status: 'EXPIRED',
    endedAt: new Date(deadlineMs ?? now.getTime()).toISOString(),
    endedReason: 'EXPIRED',
  };
}

/** Projects the stored row onto the wire resource. Never carries a position. */
export function projectLiveSession(record: LiveSessionRecord): LiveSession {
  return {
    sessionId: record.sessionId,
    familyId: record.familyId,
    requestedByUserId: record.requesterUserId,
    targetUserId: record.targetUserId,
    status: record.status,
    reason: record.reason,
    requestedAt: record.requestedAt,
    respondedAt: record.respondedAt,
    // Only a running session has an expiry to report. A pending request carries
    // a sweep deadline internally, but nothing is being shared from it yet, so
    // there is nothing for the client to count down.
    expiresAt:
      record.status === 'ACTIVE' && record.expiresAt !== null
        ? new Date(record.expiresAt * 1000).toISOString()
        : null,
    endedAt: record.endedAt,
    endedReason: record.endedReason,
    updateIntervalSeconds: record.updateIntervalSeconds,
  };
}

export function createLiveSessionsRepository(
  client: DocumentClient,
  tableName: string,
): LiveSessionsRepository {
  async function queryIndex(
    indexName: string,
    attribute: string,
    userId: UserId,
  ): Promise<LiveSessionRecord[]> {
    const records: LiveSessionRecord[] = [];
    let cursor: Item | undefined;
    do {
      const page = await client.query({
        TableName: tableName,
        IndexName: indexName,
        KeyConditionExpression: '#a = :a',
        ExpressionAttributeNames: { '#a': attribute },
        ExpressionAttributeValues: { ':a': userId },
        // Newest first: only the most recent session can still be running, and
        // the rest is history the client renders in that order anyway.
        ScanIndexForward: false,
        ExclusiveStartKey: cursor,
      });
      for (const item of page.Items ?? []) {
        records.push(parseSession(item));
      }
      cursor = page.LastEvaluatedKey;
    } while (cursor !== undefined);
    return records;
  }

  return {
    async get(sessionId): Promise<LiveSessionRecord | null> {
      const result = await client.get({
        TableName: tableName,
        Key: { sessionId },
        // A session that was stopped a second ago has to be stopped now, not on
        // the next replica sync: consent withdrawal cannot be eventually read.
        ConsistentRead: true,
      });
      return result.Item === undefined ? null : parseSession(result.Item);
    },

    listForTarget: (targetUserId) => queryIndex('byTarget', 'targetUserId', targetUserId),

    listForRequester: (requesterUserId) =>
      queryIndex('byRequester', 'requesterUserId', requesterUserId),

    async create(record): Promise<void> {
      await client.put({
        TableName: tableName,
        Item: toItem(record),
        // Refusing to overwrite turns an id collision into a failed request
        // rather than into a session silently replacing somebody else's.
        ConditionExpression: 'attribute_not_exists(sessionId)',
      });
    },

    async activate(input): Promise<LiveSessionRecord | null> {
      const timestamp = input.now.toISOString();
      try {
        const result = await client.update({
          TableName: tableName,
          Key: { sessionId: input.sessionId },
          UpdateExpression:
            'SET #status = :active, #startedAt = :t, #respondedAt = :t, #granted = :granted, ' +
            '#expiresAt = :expiresAt, #updatedAt = :t',
          // Only a session still waiting for an answer can be accepted, so a
          // rejection or a stop that landed first is never overwritten — and a
          // replayed accept cannot extend a window that is already running.
          ConditionExpression: '#status = :requested',
          ExpressionAttributeNames: {
            '#status': 'status',
            '#startedAt': 'startedAt',
            '#respondedAt': 'respondedAt',
            '#granted': 'grantedDurationSeconds',
            '#expiresAt': 'expiresAt',
            '#updatedAt': 'updatedAt',
          },
          ExpressionAttributeValues: {
            ':active': 'ACTIVE',
            ':requested': 'REQUESTED',
            ':granted': input.grantedDurationSeconds,
            ':expiresAt': input.expiresAt,
            ':t': timestamp,
          },
          ReturnValues: 'ALL_NEW',
        });
        return result.Attributes === undefined ? null : parseSession(result.Attributes);
      } catch (error) {
        if (isConditionalCheckFailed(error)) {
          return null;
        }
        throw error;
      }
    },

    async close(input): Promise<LiveSessionRecord | null> {
      const timestamp = input.now.toISOString();
      const names: Record<string, string> = {
        '#status': 'status',
        '#endedAt': 'endedAt',
        '#endedReason': 'endedReason',
        '#updatedAt': 'updatedAt',
      };
      const values: Record<string, unknown> = {
        ':status': input.status,
        ':reason': input.endedReason,
        ':endedAt': input.endedAt ?? timestamp,
        ':t': timestamp,
      };
      const assignments = [
        '#status = :status',
        '#endedAt = :endedAt',
        '#endedReason = :reason',
        '#updatedAt = :t',
      ];

      if (input.respondsToRequest === true) {
        names['#respondedAt'] = 'respondedAt';
        assignments.push('#respondedAt = :t');
      }

      let expression = `SET ${assignments.join(', ')}`;
      if (input.muteFutureRequests === true) {
        // The mute outlives the session it arrived with, so the row that
        // carries it loses its TTL attribute instead of being reaped with the
        // request it refused.
        names['#mute'] = 'muteFutureRequests';
        names['#expiresAt'] = 'expiresAt';
        values[':true'] = true;
        expression = `${expression}, #mute = :true REMOVE #expiresAt`;
      }

      const allowed = input.from.map((status, index) => {
        const placeholder = `:from${String(index)}`;
        values[placeholder] = status;
        return placeholder;
      });

      try {
        const result = await client.update({
          TableName: tableName,
          Key: { sessionId: input.sessionId },
          UpdateExpression: expression,
          ConditionExpression: `#status IN (${allowed.join(', ')})`,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
          ReturnValues: 'ALL_NEW',
        });
        return result.Attributes === undefined ? null : parseSession(result.Attributes);
      } catch (error) {
        if (isConditionalCheckFailed(error)) {
          return null;
        }
        throw error;
      }
    },
  };
}

/**
 * A TTL attribute must be absent rather than null when there is no deadline;
 * DynamoDB ignores a non-numeric value, which would silently mean "never".
 */
function toItem(record: LiveSessionRecord): Item {
  const { expiresAt, ...rest } = record;
  return expiresAt === null ? { ...rest } : { ...rest, expiresAt };
}

function parseSession(item: Item): LiveSessionRecord {
  const parsed = LiveSessionRecordSchema.safeParse(item);
  if (!parsed.success) {
    // Fail closed. An unreadable session row must never be treated as "no
    // session"; that reading would hand out the concurrency slot it holds.
    throw new AppError('INTERNAL_ERROR', 'A live session record could not be read.');
  }
  return parsed.data;
}
