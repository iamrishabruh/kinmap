/**
 * The single most important invariant in this codebase: a precise coordinate
 * must never leave the systems allowed to hold it (spec §20). Services, log
 * pipelines, push payloads and telemetry all assert against this helper.
 */

const COORDINATE_KEYS = new Set([
  'latitude',
  'longitude',
  'lat',
  'lng',
  'lon',
  'coords',
  'coordinates',
  'position',
  'geo',
]);

const SENSITIVE_KEYS = new Set([
  ...COORDINATE_KEYS,
  'address',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'invitetoken',
  'invitationtoken',
  'email',
  'placename',
  'familyname',
]);

function normalize(key: string): string {
  return key.toLowerCase().replace(/[-_\s]/g, '');
}

export type CoordinateFinding = { path: string; reason: string };

/**
 * Walks any value looking for a coordinate that survived redaction — as an
 * object key, or as a decimal-degree-shaped number embedded in a string.
 * Cycles are tracked so a self-referential log context cannot hang a test.
 */
export function findCoordinates(value: unknown, keys = COORDINATE_KEYS): CoordinateFinding[] {
  const findings: CoordinateFinding[] = [];
  const seen = new WeakSet<object>();

  // Matches "37.7749, -122.4194" and "lat=37.7749" style leakage. Requires at
  // least four decimal places so ordinary numbers (versions, counts, radii,
  // accuracy in metres) do not trip it.
  const DECIMAL_PAIR = /-?\d{1,3}\.\d{4,}\s*,\s*-?\d{1,3}\.\d{4,}/;
  const LABELLED = /\b(lat|lng|lon|latitude|longitude)\b\s*[=:]\s*-?\d{1,3}\.\d{4,}/i;

  const walk = (node: unknown, path: string): void => {
    if (node === null || node === undefined) return;

    if (typeof node === 'string') {
      if (DECIMAL_PAIR.test(node)) findings.push({ path, reason: 'coordinate pair in string' });
      else if (LABELLED.test(node))
        findings.push({ path, reason: 'labelled coordinate in string' });
      return;
    }

    if (typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${path}[${i}]`));
      return;
    }

    if (node instanceof Map) {
      for (const [k, v] of node) walk(v, `${path}.${String(k)}`);
      return;
    }
    if (node instanceof Set) {
      let i = 0;
      for (const v of node) walk(v, `${path}{${i++}}`);
      return;
    }

    for (const [key, child] of Object.entries(node)) {
      const childPath = path ? `${path}.${key}` : key;
      if (keys.has(normalize(key))) {
        findings.push({ path: childPath, reason: `key "${key}" is a coordinate field` });
      }
      walk(child, childPath);
    }
  };

  walk(value, '');
  return findings;
}

/** Throws with every offending path if any coordinate survived. */
export function assertNoCoordinates(value: unknown, context = 'value'): void {
  const findings = findCoordinates(value);
  if (findings.length > 0) {
    throw new Error(
      `${context} leaked ${findings.length} coordinate reference(s):\n` +
        findings.map((f) => `  - ${f.path || '(root)'}: ${f.reason}`).join('\n'),
    );
  }
}

/** Broader check for anything in the sensitive deny-list, not just coordinates. */
export function assertNoSensitiveFields(value: unknown, context = 'value'): void {
  const findings = findCoordinates(value, SENSITIVE_KEYS);
  if (findings.length > 0) {
    throw new Error(
      `${context} leaked ${findings.length} sensitive reference(s):\n` +
        findings.map((f) => `  - ${f.path || '(root)'}: ${f.reason}`).join('\n'),
    );
  }
}

export { COORDINATE_KEYS, SENSITIVE_KEYS };
