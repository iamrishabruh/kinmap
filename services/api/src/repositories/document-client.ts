/**
 * The seam between this service and DynamoDB.
 *
 * Repositories depend on this interface rather than on `DynamoDBDocumentClient`
 * so that every one of them can be exercised against the in-memory fake in
 * `@family/test-utils` — which really evaluates condition expressions and really
 * rolls transactions back — without a container, a network or credentials.
 *
 * The shapes mirror the DynamoDB document API one-for-one (CloudFormation
 * casing included) so that reading a repository next to the AWS documentation
 * requires no translation.
 */

export type Item = Record<string, unknown>;

export type ExpressionAttributeNames = Record<string, string>;
export type ExpressionAttributeValues = Record<string, unknown>;

export type GetInput = {
  readonly TableName: string;
  readonly Key: Item;
  readonly ConsistentRead?: boolean;
  readonly ProjectionExpression?: string;
  readonly ExpressionAttributeNames?: ExpressionAttributeNames;
};

export type PutInput = {
  readonly TableName: string;
  readonly Item: Item;
  readonly ConditionExpression?: string;
  readonly ExpressionAttributeNames?: ExpressionAttributeNames;
  readonly ExpressionAttributeValues?: ExpressionAttributeValues;
};

export type UpdateInput = {
  readonly TableName: string;
  readonly Key: Item;
  readonly UpdateExpression: string;
  readonly ConditionExpression?: string;
  readonly ExpressionAttributeNames?: ExpressionAttributeNames;
  readonly ExpressionAttributeValues?: ExpressionAttributeValues;
  readonly ReturnValues?: 'NONE' | 'ALL_NEW' | 'ALL_OLD';
};

export type DeleteInput = {
  readonly TableName: string;
  readonly Key: Item;
  readonly ConditionExpression?: string;
  readonly ExpressionAttributeNames?: ExpressionAttributeNames;
  readonly ExpressionAttributeValues?: ExpressionAttributeValues;
};

export type QueryInput = {
  readonly TableName: string;
  readonly IndexName?: string;
  readonly KeyConditionExpression: string;
  readonly FilterExpression?: string;
  readonly ExpressionAttributeNames?: ExpressionAttributeNames;
  readonly ExpressionAttributeValues?: ExpressionAttributeValues;
  readonly Limit?: number;
  readonly ScanIndexForward?: boolean;
  readonly ExclusiveStartKey?: Item;
  readonly ConsistentRead?: boolean;
};

export type TransactWriteInput = {
  readonly TransactItems: ReadonlyArray<{
    readonly Put?: PutInput;
    readonly Update?: UpdateInput;
    readonly Delete?: DeleteInput;
  }>;
};

export interface DocumentClient {
  get(input: GetInput): Promise<{ Item?: Item }>;
  put(input: PutInput): Promise<void>;
  update(input: UpdateInput): Promise<{ Attributes?: Item }>;
  delete(input: DeleteInput): Promise<void>;
  query(input: QueryInput): Promise<{ Items?: Item[]; LastEvaluatedKey?: Item }>;
  transactWrite(input: TransactWriteInput): Promise<void>;
}

/**
 * Detected by name rather than `instanceof` so the check survives both the real
 * SDK and the in-memory fake, and so a duplicated copy of the SDK in a hoisted
 * workspace cannot make a conditional write look like an outage.
 */
export function isConditionalCheckFailed(error: unknown): boolean {
  return errorName(error) === 'ConditionalCheckFailedException';
}

/**
 * Returns the per-item cancellation codes of a cancelled transaction, or null
 * when the error is something else. The index of a `ConditionalCheckFailed`
 * entry is what tells a caller *which* precondition lost the race.
 */
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
