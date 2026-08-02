import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type NativeAttributeValue,
} from '@aws-sdk/lib-dynamodb';

import type {
  DeleteInput,
  DocumentClient,
  GetInput,
  Item,
  PutInput,
  QueryInput,
  TransactWriteInput,
  UpdateInput,
} from './document-client.js';

/**
 * The only module in this service that imports the AWS SDK.
 *
 * Both clients are created at module scope so that the TCP connections and the
 * credential provider survive across invocations of a warm container; creating
 * them per request would add a handshake to every call.
 */

const baseClient = new DynamoDBClient({});

const documentClient = DynamoDBDocumentClient.from(baseClient, {
  marshallOptions: {
    // A field we deliberately left undefined must not become an attribute; the
    // sparse GSIs on FamilyMemberships and DeletionJobs depend on absence.
    removeUndefinedValues: true,
    convertClassInstanceToMap: false,
  },
  unmarshallOptions: { wrapNumbers: false },
});

/**
 * `Item` is `Record<string, unknown>` on our side of the seam because
 * repositories build plain documents; the SDK types the same values as
 * `NativeAttributeValue`. The narrowing happens here, once, instead of at every
 * call site.
 */
type DocumentItem = Record<string, NativeAttributeValue>;

function toDocument(item: Item): DocumentItem {
  return item as DocumentItem;
}

function toDocumentOrUndefined(item: Item | undefined): DocumentItem | undefined {
  return item === undefined ? undefined : toDocument(item);
}

function fromDocument(item: DocumentItem | undefined): Item | undefined {
  return item as Item | undefined;
}

export function createDynamoDocumentClient(): DocumentClient {
  return {
    async get(input: GetInput): Promise<{ Item?: Item }> {
      const result = await documentClient.send(
        new GetCommand({
          TableName: input.TableName,
          Key: toDocument(input.Key),
          ConsistentRead: input.ConsistentRead,
          ProjectionExpression: input.ProjectionExpression,
          ExpressionAttributeNames: input.ExpressionAttributeNames,
        }),
      );
      const item = fromDocument(result.Item);
      return item === undefined ? {} : { Item: item };
    },

    async put(input: PutInput): Promise<void> {
      await documentClient.send(
        new PutCommand({
          TableName: input.TableName,
          Item: toDocument(input.Item),
          ConditionExpression: input.ConditionExpression,
          ExpressionAttributeNames: input.ExpressionAttributeNames,
          ExpressionAttributeValues: toDocumentOrUndefined(input.ExpressionAttributeValues),
        }),
      );
    },

    async update(input: UpdateInput): Promise<{ Attributes?: Item }> {
      const result = await documentClient.send(
        new UpdateCommand({
          TableName: input.TableName,
          Key: toDocument(input.Key),
          UpdateExpression: input.UpdateExpression,
          ConditionExpression: input.ConditionExpression,
          ExpressionAttributeNames: input.ExpressionAttributeNames,
          ExpressionAttributeValues: toDocumentOrUndefined(input.ExpressionAttributeValues),
          ReturnValues: input.ReturnValues,
        }),
      );
      const attributes = fromDocument(result.Attributes);
      return attributes === undefined ? {} : { Attributes: attributes };
    },

    async delete(input: DeleteInput): Promise<void> {
      await documentClient.send(
        new DeleteCommand({
          TableName: input.TableName,
          Key: toDocument(input.Key),
          ConditionExpression: input.ConditionExpression,
          ExpressionAttributeNames: input.ExpressionAttributeNames,
          ExpressionAttributeValues: toDocumentOrUndefined(input.ExpressionAttributeValues),
        }),
      );
    },

    async query(input: QueryInput): Promise<{ Items?: Item[]; LastEvaluatedKey?: Item }> {
      const result = await documentClient.send(
        new QueryCommand({
          TableName: input.TableName,
          IndexName: input.IndexName,
          KeyConditionExpression: input.KeyConditionExpression,
          FilterExpression: input.FilterExpression,
          ExpressionAttributeNames: input.ExpressionAttributeNames,
          ExpressionAttributeValues: toDocumentOrUndefined(input.ExpressionAttributeValues),
          Limit: input.Limit,
          ScanIndexForward: input.ScanIndexForward,
          ExclusiveStartKey: toDocumentOrUndefined(input.ExclusiveStartKey),
          ConsistentRead: input.ConsistentRead,
        }),
      );
      return {
        Items: (result.Items ?? []).map((entry) => entry as Item),
        LastEvaluatedKey: fromDocument(result.LastEvaluatedKey),
      };
    },

    async transactWrite(input: TransactWriteInput): Promise<void> {
      await documentClient.send(
        new TransactWriteCommand({
          TransactItems: input.TransactItems.map((entry) => ({
            Put:
              entry.Put === undefined
                ? undefined
                : {
                    TableName: entry.Put.TableName,
                    Item: toDocument(entry.Put.Item),
                    ConditionExpression: entry.Put.ConditionExpression,
                    ExpressionAttributeNames: entry.Put.ExpressionAttributeNames,
                    ExpressionAttributeValues: toDocumentOrUndefined(
                      entry.Put.ExpressionAttributeValues,
                    ),
                  },
            Update:
              entry.Update === undefined
                ? undefined
                : {
                    TableName: entry.Update.TableName,
                    Key: toDocument(entry.Update.Key),
                    UpdateExpression: entry.Update.UpdateExpression,
                    ConditionExpression: entry.Update.ConditionExpression,
                    ExpressionAttributeNames: entry.Update.ExpressionAttributeNames,
                    ExpressionAttributeValues: toDocumentOrUndefined(
                      entry.Update.ExpressionAttributeValues,
                    ),
                  },
            Delete:
              entry.Delete === undefined
                ? undefined
                : {
                    TableName: entry.Delete.TableName,
                    Key: toDocument(entry.Delete.Key),
                    ConditionExpression: entry.Delete.ConditionExpression,
                    ExpressionAttributeNames: entry.Delete.ExpressionAttributeNames,
                    ExpressionAttributeValues: toDocumentOrUndefined(
                      entry.Delete.ExpressionAttributeValues,
                    ),
                  },
          })),
        }),
      );
    },
  };
}
