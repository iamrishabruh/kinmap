import type { z } from 'zod';

import { AppError } from '@family/contracts';
import { parseOrThrow } from '@family/validation';

/**
 * Schema validation for the three inputs a route can receive.
 *
 * Everything goes through `parseOrThrow` from `@family/validation`, which
 * converts Zod issues into fixed, value-free messages. That matters here more
 * than it looks: Zod's default text sometimes echoes the offending value, and a
 * validation error on a coordinate field would otherwise put a coordinate into
 * an error body, a log line and whatever error tracker the caller wired up.
 */

export function validateBody<TSchema extends z.ZodType>(
  schema: TSchema,
  body: unknown,
): z.output<TSchema> {
  if (body === null) {
    throw new AppError('VALIDATION_FAILED', 'A request body is required.', [
      { path: '(root)', message: 'This value has the wrong type.' },
    ]);
  }
  return parseOrThrow(schema, body);
}

export function validateQuery<TSchema extends z.ZodType>(
  schema: TSchema,
  query: Readonly<Record<string, string>>,
): z.output<TSchema> {
  return parseOrThrow(schema, query);
}

export function validateParams<TSchema extends z.ZodType>(
  schema: TSchema,
  params: Readonly<Record<string, string>>,
): z.output<TSchema> {
  return parseOrThrow(schema, params);
}
