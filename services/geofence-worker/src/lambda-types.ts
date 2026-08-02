/**
 * The slice of the Lambda event model this worker uses.
 *
 * Declared locally rather than pulled from `@types/aws-lambda` so the runtime
 * contract of the handler is visible in the repository and does not drift with
 * an unpinned third-party type package.
 */

export type SqsRecord = {
  readonly messageId: string;
  readonly receiptHandle?: string;
  readonly body: string;
  readonly attributes?: Readonly<Record<string, string>>;
  readonly messageAttributes?: Readonly<Record<string, unknown>>;
};

export type SqsEvent = {
  readonly Records: readonly SqsRecord[];
};

/** Partial-batch response: only the listed messages are redelivered. */
export type SqsBatchResponse = {
  readonly batchItemFailures: Array<{ itemIdentifier: string }>;
};
