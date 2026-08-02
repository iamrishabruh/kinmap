/**
 * `dynamo-document-client.ts` is deliberately absent from this barrel. It is the
 * only module that imports the AWS SDK, and it is imported by the composition
 * root alone, so a unit test can pull in every repository without dragging a
 * client — or a credential provider — into the process.
 */
export * from './document-client.js';
export * from './expressions.js';
export * from './accounts.js';
export * from './devices.js';
export * from './families.js';
export * from './subscriptions.js';
export * from './audit.js';
export * from './support.js';
export * from './idempotency.js';
export * from './jobs.js';
export * from './configuration.js';
