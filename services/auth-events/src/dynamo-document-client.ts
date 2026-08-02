import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  TransactWriteCommand,
  type NativeAttributeValue,
} from '@aws-sdk/lib-dynamodb';

import type { DocumentClient, Item, PutInput, TransactWriteInput } from './users-repository.js';

/**
 * The only module in this service that imports the AWS SDK.
 *
 * Both clients live at module scope so a warm container reuses the connections
 * and the credential provider instead of paying for a handshake per trigger —
 * which matters here more than usual, because a trigger sits directly in the
 * user's sign-in latency.
 */

const baseClient = new DynamoDBClient({});

const documentClient = DynamoDBDocumentClient.from(baseClient, {
  marshallOptions: { removeUndefinedValues: true, convertClassInstanceToMap: false },
  unmarshallOptions: { wrapNumbers: false },
});

type DocumentItem = Record<string, NativeAttributeValue>;

function toDocument(item: Item): DocumentItem {
  return item as DocumentItem;
}

function toDocumentOrUndefined(
  values: Record<string, unknown> | undefined,
): DocumentItem | undefined {
  return values === undefined ? undefined : toDocument(values);
}

function toPutCommandInput(input: PutInput): {
  TableName: string;
  Item: DocumentItem;
  ConditionExpression?: string;
  ExpressionAttributeNames?: Record<string, string>;
  ExpressionAttributeValues?: DocumentItem;
} {
  return {
    TableName: input.TableName,
    Item: toDocument(input.Item),
    ConditionExpression: input.ConditionExpression,
    ExpressionAttributeNames: input.ExpressionAttributeNames,
    ExpressionAttributeValues: toDocumentOrUndefined(input.ExpressionAttributeValues),
  };
}

export function createDynamoDocumentClient(): DocumentClient {
  return {
    async put(input: PutInput): Promise<void> {
      await documentClient.send(new PutCommand(toPutCommandInput(input)));
    },

    async transactWrite(input: TransactWriteInput): Promise<void> {
      await documentClient.send(
        new TransactWriteCommand({
          TransactItems: input.TransactItems.map((entry) => ({
            Put: entry.Put === undefined ? undefined : toPutCommandInput(entry.Put),
          })),
        }),
      );
    },
  };
}
