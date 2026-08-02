/**
 * The slice of the Lambda event model this worker uses. Declared locally so the
 * runtime contract lives in the repository rather than in an unpinned
 * third-party type package.
 */

export type SqsRecord = {
  readonly messageId: string;
  readonly receiptHandle?: string;
  readonly body: string;
};

export type SqsEvent = {
  readonly Records: readonly SqsRecord[];
};

export type SqsBatchResponse = {
  readonly batchItemFailures: Array<{ itemIdentifier: string }>;
};
