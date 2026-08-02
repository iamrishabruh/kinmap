import type { z } from 'zod';

import { AppError } from '@family/contracts';

/**
 * Schema parsing that fails the way the API contract expects.
 *
 * Zod's default messages sometimes echo the offending value ("Expected 'A',
 * received 'B'"). In a location product that is a leak: a validation error on a
 * latitude field would put a coordinate into an error body, a log line, and
 * whatever error tracker the caller wired up. Every message emitted here is
 * therefore a fixed constant chosen by issue code — structural information
 * only, never the value that failed.
 */

export type FieldError = {
  /** Dotted/indexed path to the offending field, e.g. `events[3].latitude`. */
  readonly path: string;
  /** Fixed, value-free explanation. */
  readonly message: string;
};

/** Structural view of a Zod issue, so this module is not tied to one release. */
type IssueLike = {
  readonly code?: string | undefined;
  readonly path: readonly PropertyKey[];
  /** Present on `unrecognized_keys`. */
  readonly keys?: readonly PropertyKey[] | undefined;
};

type ErrorLike = {
  readonly issues: readonly IssueLike[];
};

export const VALIDATION_FAILED_MESSAGE = 'The request could not be validated.';

const DEFAULT_ISSUE_MESSAGE = 'This value is not valid.';

/**
 * Fixed messages keyed by Zod issue code. Looked up by string rather than a
 * `switch` over a typed union so a new or renamed code degrades to the default
 * instead of breaking the build or, worse, falling through to Zod's own text.
 */
const ISSUE_MESSAGES: Readonly<Record<string, string>> = {
  invalid_type: 'This value has the wrong type.',
  invalid_value: 'This value is not one of the allowed values.',
  invalid_format: 'This value is not in the expected format.',
  invalid_union: 'This value does not match any allowed shape.',
  invalid_key: 'This key is not valid.',
  invalid_element: 'An element of this collection is not valid.',
  too_small: 'This value is below the allowed range.',
  too_big: 'This value is above the allowed range.',
  not_multiple_of: 'This value is not an allowed increment.',
  unrecognized_keys: 'This field is not recognised.',
  custom: 'This value did not pass validation.',
};

function formatPathSegment(segment: PropertyKey, isFirst: boolean): string {
  if (typeof segment === 'number') {
    return `[${segment.toString()}]`;
  }
  const key = String(segment);
  return isFirst ? key : `.${key}`;
}

/** `['events', 3, 'latitude']` becomes `events[3].latitude`. */
export function formatFieldPath(path: readonly PropertyKey[]): string {
  if (path.length === 0) {
    return '(root)';
  }
  return path.reduce<string>(
    (accumulator, segment, index) => accumulator + formatPathSegment(segment, index === 0),
    '',
  );
}

function messageForIssue(issue: IssueLike): string {
  if (issue.code === undefined) {
    return DEFAULT_ISSUE_MESSAGE;
  }
  return ISSUE_MESSAGES[issue.code] ?? DEFAULT_ISSUE_MESSAGE;
}

/**
 * Flattens a Zod error into value-free field errors suitable for the
 * `VALIDATION_FAILED` envelope in @family/contracts.
 */
export function toFieldErrors(error: ErrorLike): FieldError[] {
  const fields: FieldError[] = [];

  for (const issue of error.issues) {
    const message = messageForIssue(issue);

    // An unrecognised-keys issue is reported against the parent object; point
    // at each offending key so a caller can see exactly what to remove.
    if (issue.code === 'unrecognized_keys' && issue.keys !== undefined) {
      for (const key of issue.keys) {
        fields.push({ path: formatFieldPath([...issue.path, key]), message });
      }
      continue;
    }

    fields.push({ path: formatFieldPath(issue.path), message });
  }

  return fields;
}

/**
 * Parses `data` with `schema`, returning the parsed value or throwing
 * `AppError('VALIDATION_FAILED')` carrying field paths.
 *
 * Prefer this over `schema.parse` everywhere in a service: a raw `ZodError`
 * escaping to a handler produces a 500 and an unsanitised message.
 */
export function parseOrThrow<TSchema extends z.ZodType>(
  schema: TSchema,
  data: unknown,
): z.output<TSchema> {
  const result = schema.safeParse(data);

  if (result.success) {
    return result.data as z.output<TSchema>;
  }

  throw new AppError('VALIDATION_FAILED', VALIDATION_FAILED_MESSAGE, toFieldErrors(result.error));
}
