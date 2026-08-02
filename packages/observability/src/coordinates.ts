/**
 * Value-level coordinate detection.
 *
 * Key-based redaction catches `{ latitude: 37.7749 }`. It does not catch
 * `"user is at 37.7749,-122.4194"` or a metric dimension named `place` whose
 * value happens to be a coordinate pair. These heuristics close that gap.
 *
 * They are deliberately biased towards false positives: mangling a duration in
 * a log line is cheap, leaking a home address is not.
 */

/** `37.7749,-122.4194` with optional whitespace, and the `(lat, lng)` form. */
export const COORDINATE_PAIR_PATTERN = /\(?\s*-?\d{1,3}\.\d{3,}\s*,\s*-?\d{1,3}\.\d{3,}\s*\)?/g;

/** A single high-precision decimal that could be one half of a fix. */
const HIGH_PRECISION_DECIMAL = /-?\d{1,3}\.\d{4,}/g;

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * `latitude: 37.77`, `lng=-122.41`, `"lat":37.7`, `token: abc.def` — the
 * shapes that survive naive string interpolation.
 */
const SENSITIVE_ASSIGNMENT =
  /"?\b(latitude|longitude|lat|lng|lon|coords?|coordinates|address|token|accessToken|refreshToken|inviteToken|email|placeName|familyName)\b"?\s*[:=]\s*"?[^\s,;}\])"]+"?/gi;

export const COORDINATE_PLACEHOLDER = '[redacted-coordinate]';
export const REDACTED_PLACEHOLDER = '[redacted]';
export const EMAIL_PLACEHOLDER = '[redacted-email]';

const MAX_ABSOLUTE_LONGITUDE = 180;

/** Latitude/longitude live in [-180, 180]; anything larger is not a fix. */
function isInCoordinateRange(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value) <= MAX_ABSOLUTE_LONGITUDE;
}

function decimalPlaces(text: string): number {
  const dot = text.indexOf('.');
  return dot === -1 ? 0 : text.length - dot - 1;
}

/**
 * True when a scalar is plausibly one half of a precise fix: an in-range
 * decimal carrying at least three fractional digits (~100 m of precision).
 */
export function looksLikeCoordinateValue(value: unknown): boolean {
  if (typeof value === 'number') {
    if (!isInCoordinateRange(value) || Number.isInteger(value)) return false;
    return decimalPlaces(String(value)) >= 3;
  }
  if (typeof value !== 'string') return false;

  const trimmed = value.trim();
  if (looksLikeCoordinatePair(trimmed)) return true;

  if (!/^-?\d{1,3}\.\d+$/.test(trimmed)) return false;
  return decimalPlaces(trimmed) >= 3 && isInCoordinateRange(Number(trimmed));
}

/** True when a string contains a `lat,lng` pair anywhere inside it. */
export function looksLikeCoordinatePair(text: string): boolean {
  const pattern = new RegExp(COORDINATE_PAIR_PATTERN.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const [first, second] = match[0]
      .replace(/[()\s]/g, '')
      .split(',')
      .map(Number);
    if (
      first !== undefined &&
      second !== undefined &&
      isInCoordinateRange(first) &&
      isInCoordinateRange(second) &&
      Math.abs(first) <= 90
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Removes coordinates, emails and `key: value` leaks from free text such as an
 * exception message, a breadcrumb or a URL.
 */
export function scrubText(text: string): string {
  if (text.length === 0) return text;

  let result = text.replace(EMAIL_PATTERN, EMAIL_PLACEHOLDER);

  // Keyed assignments first, so `latitude: 37.7749` collapses to one
  // placeholder instead of being rewritten twice into nested placeholders.
  result = result.replace(SENSITIVE_ASSIGNMENT, (match) => {
    const separator = match.includes(':') ? ':' : '=';
    const key = match.slice(0, match.indexOf(separator)).replace(/"/g, '').trim();
    return `${key}${separator}${REDACTED_PLACEHOLDER}`;
  });

  result = result.replace(new RegExp(COORDINATE_PAIR_PATTERN.source, 'g'), (match) => {
    const [first, second] = match
      .replace(/[()\s]/g, '')
      .split(',')
      .map(Number);
    const isPair =
      first !== undefined &&
      second !== undefined &&
      isInCoordinateRange(first) &&
      isInCoordinateRange(second);
    return isPair ? COORDINATE_PLACEHOLDER : match;
  });

  result = result.replace(HIGH_PRECISION_DECIMAL, (match) =>
    isInCoordinateRange(Number(match)) ? COORDINATE_PLACEHOLDER : match,
  );

  return result;
}

/**
 * URLs are logged by HTTP middleware. Query strings routinely carry tokens and
 * bounding boxes, and path segments carry ids, so only origin + path survive
 * and any coordinate-shaped segment is replaced.
 */
export function scrubUrl(url: string): string {
  const [withoutFragment] = url.split('#');
  const [pathPart] = (withoutFragment ?? url).split('?');
  const safePath = (pathPart ?? url)
    .split('/')
    .map((segment) => (looksLikeCoordinateValue(segment) ? COORDINATE_PLACEHOLDER : segment))
    .join('/');
  const hadQuery = (withoutFragment ?? url).includes('?');
  return hadQuery ? `${safePath}?${REDACTED_PLACEHOLDER}` : safePath;
}
