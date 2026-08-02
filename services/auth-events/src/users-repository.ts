import { AppError } from '@family/contracts';

import type { UserProfileRecord } from './profile.js';

/**
 * Profile creation.
 *
 * The write is a transaction over two items in the Users table:
 *
 *  1. the profile itself, keyed by the Cognito subject;
 *  2. an email *claim*, keyed by the address's keyed digest.
 *
 * The claim is why this is a transaction rather than a single conditional put.
 * The `byEmailHash` index makes an address findable, but a global secondary
 * index enforces nothing — two confirmations racing on the same verified
 * address would both succeed and the account that "owns" it would be decided by
 * whichever write landed second. The claim item makes that outcome impossible.
 *
 * Idempotency comes from the conditions, not from a read-then-write:
 *
 *  - the profile is created only if it does not exist, so a Cognito retry of a
 *    confirmation it already delivered is a no-op;
 *  - the claim is accepted if it is unowned *or already owned by this user*, so
 *    the same retry does not trip over its own earlier claim.
 *
 * A cancelled transaction is therefore read positionally: item 0 failing means
 * "already created" (success); item 1 failing alone means the address belongs to
 * a different account (conflict).
 */

export type Item = Record<string, unknown>;

export type PutInput = {
  readonly TableName: string;
  readonly Item: Item;
  readonly ConditionExpression?: string;
  readonly ExpressionAttributeNames?: Record<string, string>;
  readonly ExpressionAttributeValues?: Record<string, unknown>;
};

export type TransactWriteInput = {
  readonly TransactItems: ReadonlyArray<{ readonly Put?: PutInput }>;
};

/**
 * The narrow slice of DynamoDB this function needs. It is granted write access
 * to the Users table and nothing else — no location table, no coordinate key —
 * so a bug in a sign-up trigger cannot reach anybody's position.
 */
export interface DocumentClient {
  put(input: PutInput): Promise<void>;
  transactWrite(input: TransactWriteInput): Promise<void>;
}

export type CreateProfileOutcome = 'CREATED' | 'ALREADY_EXISTS';

export interface UserProfileRepository {
  createProfile(profile: UserProfileRecord): Promise<CreateProfileOutcome>;
}

export const EMAIL_CLAIM_PREFIX = 'EMAILCLAIM#';

export function createUserProfileRepository(
  client: DocumentClient,
  tableName: string,
): UserProfileRepository {
  return {
    async createProfile(profile): Promise<CreateProfileOutcome> {
      const profilePut: PutInput = {
        TableName: tableName,
        Item: { ...profile },
        ConditionExpression: 'attribute_not_exists(userId)',
      };

      if (profile.emailHash === null) {
        // No address to claim — a single conditional put is the whole write.
        try {
          await client.put(profilePut);
          return 'CREATED';
        } catch (error) {
          if (isConditionalCheckFailed(error)) {
            return 'ALREADY_EXISTS';
          }
          throw error;
        }
      }

      try {
        await client.transactWrite({
          TransactItems: [
            { Put: profilePut },
            {
              Put: {
                TableName: tableName,
                Item: {
                  // Deliberately not a UUID, and deliberately carrying no
                  // `emailHash` attribute, so the claim never appears in the
                  // `byEmailHash` index alongside a real profile.
                  userId: `${EMAIL_CLAIM_PREFIX}${profile.emailHash}`,
                  ownerUserId: profile.userId,
                  claimedAt: profile.createdAt,
                },
                ConditionExpression: 'attribute_not_exists(userId) OR ownerUserId = :ownerUserId',
                ExpressionAttributeValues: { ':ownerUserId': profile.userId },
              },
            },
          ],
        });
        return 'CREATED';
      } catch (error) {
        const codes = transactionCancellationCodes(error);
        if (codes === null) {
          throw error;
        }
        // The profile already exists: this is a replay of a confirmation we have
        // already handled, and the account is intact.
        if (codes[0] === 'ConditionalCheckFailed') {
          return 'ALREADY_EXISTS';
        }
        if (codes[1] === 'ConditionalCheckFailed') {
          throw new AppError('CONFLICT', 'That email address is already in use.');
        }
        throw error;
      }
    },
  };
}

export function isConditionalCheckFailed(error: unknown): boolean {
  return errorName(error) === 'ConditionalCheckFailedException';
}

export function transactionCancellationCodes(error: unknown): string[] | null {
  if (errorName(error) !== 'TransactionCanceledException') {
    return null;
  }
  const reasons = (error as { cancellationReasons?: unknown }).cancellationReasons;
  if (!Array.isArray(reasons)) {
    return [];
  }
  return reasons.map((reason) => {
    if (reason !== null && typeof reason === 'object') {
      const code = (reason as { Code?: unknown }).Code;
      if (typeof code === 'string') {
        return code;
      }
    }
    return 'Unknown';
  });
}

function errorName(error: unknown): string | null {
  if (!(error instanceof Error)) {
    return null;
  }
  return error.name !== '' ? error.name : error.constructor.name;
}
