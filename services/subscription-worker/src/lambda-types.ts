/**
 * The three invocation shapes this service answers to, declared locally so the
 * runtime contract lives in the repository.
 *
 *  - an HTTP API v2 request (the three provider webhook routes);
 *  - an SQS batch (queued, already-verified subscription events);
 *  - an EventBridge scheduled event carrying `{ task: ... }`.
 */

export type HttpEvent = {
  readonly version: '2.0';
  readonly rawPath: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body?: string;
  readonly isBase64Encoded?: boolean;
  readonly requestContext: {
    readonly requestId: string;
    readonly http: { readonly method: string; readonly path: string };
  };
};

export type HttpResponse = {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
};

export type SqsRecord = {
  readonly messageId: string;
  readonly body: string;
};

export type SqsEvent = {
  readonly Records: readonly SqsRecord[];
};

export type SqsBatchResponse = {
  readonly batchItemFailures: Array<{ itemIdentifier: string }>;
};

export type ScheduledEvent = {
  readonly task: string;
  /** Optional narrowing so an operator can reconcile one account by hand. */
  readonly userId?: string;
};

export type WorkerEvent = HttpEvent | SqsEvent | ScheduledEvent;

export function isHttpEvent(event: WorkerEvent): event is HttpEvent {
  return 'requestContext' in event && 'rawPath' in event;
}

export function isSqsEvent(event: WorkerEvent): event is SqsEvent {
  return 'Records' in event && Array.isArray((event as SqsEvent).Records);
}

export function isScheduledEvent(event: WorkerEvent): event is ScheduledEvent {
  return 'task' in event && typeof (event as ScheduledEvent).task === 'string';
}
