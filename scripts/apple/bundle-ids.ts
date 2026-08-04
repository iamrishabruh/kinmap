#!/usr/bin/env tsx
/**
 * Idempotent bundle identifier provisioning for Kinmap.
 *
 *   pnpm apple:bundle-ids [--dry-run]
 *
 * For each of the three bundle identifiers this project ships, the script:
 *
 *   1. looks the identifier up in the Apple Developer portal;
 *   2. creates it if it is absent;
 *   3. enables the capabilities the app depends on, skipping any that are
 *      already enabled.
 *
 * Running it twice changes nothing the second time — that is the whole point.
 * Apple's console is a manual, click-through surface, and a half-configured
 * identifier is only discovered at build or submission time, which is the worst
 * possible moment to discover it.
 *
 * Requires ASC_KEY_ID, ASC_ISSUER_ID and ASC_KEY_PATH; see scripts/apple/README.md.
 * The App Store Connect key must hold the App Manager (or Admin) role — a
 * Developer-role key can read identifiers but not create them.
 */
import {
  AscApiError,
  AscConfigurationError,
  createAscClientFromEnvironment,
  type AppStoreConnectClient,
  type AscSingle,
} from './asc-client.js';

// --- what we provision ------------------------------------------------------

interface TargetBundleId {
  readonly identifier: string;
  /**
   * Apple restricts identifier names to letters, numbers and spaces — a name
   * containing the identifier itself is rejected because of the dots.
   */
  readonly name: string;
  readonly environment: string;
}

const TARGETS: readonly TargetBundleId[] = [
  { identifier: 'app.kinmap', name: 'Kinmap', environment: 'production' },
  { identifier: 'app.kinmap.dev', name: 'Kinmap Dev', environment: 'development' },
  { identifier: 'app.kinmap.staging', name: 'Kinmap Staging', environment: 'staging' },
];

/**
 * Capabilities every Kinmap identifier needs.
 *
 *   SIGN_IN_WITH_APPLE  — the only supported sign-in method (spec §16).
 *   PUSH_NOTIFICATIONS  — arrival/departure and live-session notifications.
 *   ASSOCIATED_DOMAINS  — universal links for invitations, plus webcredentials.
 *
 * ACCESS_WIFI_INFORMATION is deliberately NOT requested. It grants the current
 * SSID/BSSID, which is a location signal in its own right; the app determines
 * position from Core Location alone, so asking for it would widen the app's
 * data footprint and its App Review surface for no functional gain.
 *
 * Background Modes are declared in the Info.plist (see apps/mobile/app.config.ts)
 * rather than through bundleIdCapabilities, so they are not listed here.
 */
const REQUIRED_CAPABILITIES: readonly CapabilityRequest[] = [
  {
    // Apple's identifier for Sign in with Apple is APPLE_ID_AUTH. This said
    // SIGN_IN_WITH_APPLE, which Apple rejects outright:
    //
    //   'SIGN_IN_WITH_APPLE' is not a valid value for the attribute
    //   'capabilityType'. Expected one of: ... 'APPLE_ID_AUTH'
    //
    // The rejection was a 409, and this script treated every 409 as
    // "already enabled", so it reported success on all three bundle ids while
    // enabling nothing — for months, and the setup docs repeated the claim.
    //
    // It also needs a configuration or Apple refuses it a second way:
    // "Please select at least one configuration for Sign In with Apple."
    type: 'APPLE_ID_AUTH',
    settings: [{ key: 'APPLE_ID_AUTH_APP_CONSENT', options: [{ key: 'PRIMARY_APP_CONSENT' }] }],
  },
  { type: 'PUSH_NOTIFICATIONS' },
  { type: 'ASSOCIATED_DOMAINS' },
];

const BUNDLE_ID_PLATFORM = 'IOS';

/** A capability, plus the configuration Apple demands for the ones that need one. */
interface CapabilityRequest {
  readonly type: string;
  readonly settings?: ReadonlyArray<{
    readonly key: string;
    readonly options: ReadonlyArray<{ readonly key: string }>;
  }>;
}

// --- Apple resource shapes we consume ---------------------------------------

interface BundleIdResource {
  readonly type: string;
  readonly id: string;
  readonly attributes?: {
    readonly identifier?: string;
    readonly name?: string;
    readonly platform?: string;
    readonly seedId?: string;
  };
}

interface BundleIdCapabilityResource {
  readonly type: string;
  readonly id: string;
  readonly attributes?: {
    readonly capabilityType?: string;
  };
}

// --- results ----------------------------------------------------------------

type BundleIdAction = 'created' | 'existed' | 'would-create' | 'unknown';

interface ReconcileResult {
  readonly target: TargetBundleId;
  action: BundleIdAction;
  resourceId: string | undefined;
  alreadyEnabled: string[];
  enabled: string[];
  wouldEnable: string[];
  failure: string | undefined;
}

function newResult(target: TargetBundleId): ReconcileResult {
  return {
    target,
    action: 'unknown',
    resourceId: undefined,
    alreadyEnabled: [],
    enabled: [],
    wouldEnable: [],
    failure: undefined,
  };
}

// --- Apple calls ------------------------------------------------------------

/**
 * Finds a bundle id by exact identifier.
 *
 * Apple's `filter[identifier]` is not reliably an exact match, and `app.kinmap`
 * is a prefix of the other two identifiers, so the result is always re-checked
 * locally. Getting this wrong would silently reconcile the wrong identifier.
 */
async function findBundleId(
  client: AppStoreConnectClient,
  identifier: string,
): Promise<BundleIdResource | undefined> {
  const matches = await client.getAll<BundleIdResource>('/v1/bundleIds', {
    'filter[identifier]': identifier,
    limit: 200,
  });
  return matches.find((candidate) => candidate.attributes?.identifier === identifier);
}

async function createBundleId(
  client: AppStoreConnectClient,
  target: TargetBundleId,
  seedId: string,
): Promise<BundleIdResource> {
  const response = await client.post<AscSingle<BundleIdResource>>('/v1/bundleIds', {
    data: {
      type: 'bundleIds',
      attributes: {
        identifier: target.identifier,
        name: target.name,
        platform: BUNDLE_ID_PLATFORM,
        seedId,
      },
    },
  });
  return response.data;
}

async function listEnabledCapabilities(
  client: AppStoreConnectClient,
  bundleIdResourceId: string,
): Promise<Set<string>> {
  const capabilities = await client.getAll<BundleIdCapabilityResource>(
    // No `limit`: App Store Connect rejects pagination parameters on this
    // relationship with PARAMETER_ERROR.ILLEGAL. The capability set per bundle
    // id is small and bounded, so the default page is always sufficient.
    `/v1/bundleIds/${encodeURIComponent(bundleIdResourceId)}/bundleIdCapabilities`,
  );

  const enabled = new Set<string>();
  for (const capability of capabilities) {
    const type = capability.attributes?.capabilityType;
    if (type !== undefined) {
      enabled.add(type);
    }
  }
  return enabled;
}

/**
 * True when Apple's refusal means "this is already configured".
 *
 * Deliberately narrow: a 409 on a capability POST is a conflict with existing
 * state, and `ENTITY_ERROR.RELATIONSHIP.INVALID` with an "already" detail is the
 * shape Apple returns when the capability is present. Anything else — a 403
 * from an under-privileged key, a 422 from an unsupported capability — must
 * still fail the run.
 */
/**
 * Whether a 409 means "this is already how you want it" rather than "your
 * request is wrong".
 *
 * Apple answers both with 409, and this used to return true for any of them.
 * That turned every malformed request into a silent success: an invalid
 * capability type and a missing required configuration were both reported as
 * enabled. A conflict is only benign when Apple says the entity already exists
 * or is already in that state.
 */
function isAlreadyConfigured(error: AscApiError): boolean {
  return error.errors.some(
    (entry) =>
      entry.code === 'STATE_ERROR.ENTITY_STATE_INVALID' ||
      /already\s+(enabled|exists|in use|configured)/i.test(entry.detail ?? ''),
  );
}

async function enableCapability(
  client: AppStoreConnectClient,
  bundleIdResourceId: string,
  capability: CapabilityRequest,
): Promise<'enabled' | 'already-enabled'> {
  try {
    await client.post<AscSingle<BundleIdCapabilityResource>>('/v1/bundleIdCapabilities', {
      data: {
        type: 'bundleIdCapabilities',
        attributes: {
          capabilityType: capability.type,
          ...(capability.settings === undefined ? {} : { settings: capability.settings }),
        },
        relationships: {
          bundleId: { data: { type: 'bundleIds', id: bundleIdResourceId } },
        },
      },
    });
    return 'enabled';
  } catch (error) {
    // Another operator (or a previous partial run) may have enabled it between
    // our read and our write. That is success, not a conflict to report.
    if (error instanceof AscApiError && isAlreadyConfigured(error)) {
      return 'already-enabled';
    }
    throw error;
  }
}

// --- reconciliation ---------------------------------------------------------

/**
 * Creates the identifier, tolerating the case where someone else created it
 * between our lookup and our write.
 */
async function createOrAdopt(
  client: AppStoreConnectClient,
  target: TargetBundleId,
  result: ReconcileResult,
): Promise<BundleIdResource> {
  try {
    const created = await createBundleId(client, target, client.teamId);
    result.action = 'created';
    return created;
  } catch (error) {
    if (error instanceof AscApiError && isAlreadyConfigured(error)) {
      const adopted = await findBundleId(client, target.identifier);
      if (adopted !== undefined) {
        result.action = 'existed';
        return adopted;
      }
    }
    throw error;
  }
}

async function reconcile(
  client: AppStoreConnectClient,
  target: TargetBundleId,
  dryRun: boolean,
): Promise<ReconcileResult> {
  const result = newResult(target);

  try {
    const existing = await findBundleId(client, target.identifier);

    if (existing === undefined && dryRun) {
      result.action = 'would-create';
      result.wouldEnable = REQUIRED_CAPABILITIES.map((capability) => capability.type);
      return result;
    }

    let bundleId: BundleIdResource;
    if (existing === undefined) {
      bundleId = await createOrAdopt(client, target, result);
    } else {
      bundleId = existing;
      result.action = 'existed';
    }

    result.resourceId = bundleId.id;

    const enabled = await listEnabledCapabilities(client, bundleId.id);
    for (const capability of REQUIRED_CAPABILITIES) {
      if (enabled.has(capability.type)) {
        result.alreadyEnabled.push(capability.type);
        continue;
      }
      if (dryRun) {
        result.wouldEnable.push(capability.type);
        continue;
      }
      const outcome = await enableCapability(client, bundleId.id, capability);
      if (outcome === 'enabled') {
        result.enabled.push(capability);
      } else {
        result.alreadyEnabled.push(capability);
      }
    }
  } catch (error) {
    result.failure = error instanceof Error ? error.message : String(error);
  }

  return result;
}

// --- reporting --------------------------------------------------------------

function renderTable(headers: readonly string[], rows: ReadonlyArray<readonly string[]>): string {
  const widths = headers.map((header, column) =>
    rows.reduce((widest, row) => Math.max(widest, (row[column] ?? '').length), header.length),
  );

  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, column) => cell.padEnd(widths[column] ?? cell.length))
      .join('  ')
      .trimEnd();

  const separator = widths.map((width) => '─'.repeat(width)).join('  ');
  return [line(headers), separator, ...rows.map(line)].join('\n  ');
}

function actionCell(result: ReconcileResult): string {
  switch (result.action) {
    case 'created':
      return 'created';
    case 'existed':
      return 'already existed';
    case 'would-create':
      return 'would create';
    default:
      return '—';
  }
}

function capabilityCell(result: ReconcileResult): string {
  const parts: string[] = [];
  if (result.enabled.length > 0) {
    parts.push(`${String(result.enabled.length)} enabled`);
  }
  if (result.wouldEnable.length > 0) {
    parts.push(`${String(result.wouldEnable.length)} would be enabled`);
  }
  if (result.alreadyEnabled.length > 0) {
    parts.push(`${String(result.alreadyEnabled.length)} already enabled`);
  }
  return parts.length > 0 ? parts.join(', ') : '—';
}

function statusCell(result: ReconcileResult, dryRun: boolean): string {
  if (result.failure !== undefined) {
    return 'FAILED';
  }
  return dryRun ? 'dry run' : 'ok';
}

function report(results: readonly ReconcileResult[], dryRun: boolean): void {
  const rows = results.map((result) => [
    result.target.identifier,
    result.target.environment,
    actionCell(result),
    capabilityCell(result),
    statusCell(result, dryRun),
  ]);

  console.log('');
  console.log(
    `  ${renderTable(['IDENTIFIER', 'ENVIRONMENT', 'BUNDLE ID', 'CAPABILITIES', 'STATUS'], rows)}`,
  );
  console.log('');

  for (const result of results) {
    const heading =
      result.resourceId === undefined
        ? `${result.target.identifier} (${result.target.name})`
        : `${result.target.identifier} (${result.target.name}) — resource ${result.resourceId}`;
    console.log(`  ${heading}`);

    if (result.alreadyEnabled.length > 0) {
      console.log(`    already enabled: ${result.alreadyEnabled.join(', ')}`);
    }
    if (result.enabled.length > 0) {
      console.log(`    enabled now:     ${result.enabled.join(', ')}`);
    }
    if (result.wouldEnable.length > 0) {
      console.log(`    would enable:    ${result.wouldEnable.join(', ')}`);
    }
    if (result.failure !== undefined) {
      for (const line of result.failure.split('\n')) {
        console.error(`    ! ${line}`);
      }
    }
  }
  console.log('');
}

// --- CLI --------------------------------------------------------------------

interface Args {
  readonly dryRun: boolean;
  readonly help: boolean;
}

const USAGE = `Usage: pnpm apple:bundle-ids [--dry-run]

Reconciles the Kinmap bundle identifiers and their capabilities in the Apple
Developer portal. Safe to run repeatedly.

Options:
  --dry-run   Report what would change without creating or enabling anything.
  -h, --help  Show this message.

Environment (all required, none is a secret):
  ASC_KEY_ID      App Store Connect API key id
  ASC_ISSUER_ID   App Store Connect issuer id
  ASC_KEY_PATH    Path to the AuthKey_<key id>.p8 private key on disk
  ASC_TEAM_ID     Optional Apple Developer Team ID override

See scripts/apple/README.md.`;

function parseArgs(argv: readonly string[]): Args {
  let dryRun = false;
  let help = false;

  for (const argument of argv) {
    switch (argument) {
      case '--dry-run':
        dryRun = true;
        break;
      case '-h':
      case '--help':
        help = true;
        break;
      default:
        console.error(`Unknown argument: ${argument}\n\n${USAGE}`);
        process.exit(2);
    }
  }

  return { dryRun, help };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  const client = await createAscClientFromEnvironment();

  console.log(
    args.dryRun
      ? 'Reconciling Apple bundle identifiers (dry run — nothing will be changed).'
      : 'Reconciling Apple bundle identifiers.',
  );
  console.log(
    `Team ${client.teamId}; capabilities: ${REQUIRED_CAPABILITIES.map((c) => c.type).join(', ')}.`,
  );

  const results: ReconcileResult[] = [];
  for (const target of TARGETS) {
    // Sequential on purpose: Apple rate-limits aggressively, and three
    // identifiers are not worth the concurrency.
    results.push(await reconcile(client, target, args.dryRun));
  }

  report(results, args.dryRun);

  const failed = results.filter((result) => result.failure !== undefined);
  if (failed.length > 0) {
    console.error(
      `${String(failed.length)} of ${String(results.length)} bundle identifier(s) could not be ` +
        'reconciled. Nothing else was changed; fix the cause above and re-run — this script is ' +
        'idempotent.',
    );
    return 1;
  }

  if (args.dryRun) {
    const pending = results.filter(
      (result) => result.action === 'would-create' || result.wouldEnable.length > 0,
    );
    console.log(
      pending.length === 0
        ? 'Everything is already reconciled; a real run would make no changes.'
        : `${String(pending.length)} identifier(s) would change. Re-run without --dry-run to apply.`,
    );
    return 0;
  }

  console.log('All bundle identifiers reconciled.');
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    if (error instanceof AscConfigurationError) {
      console.error(error.message);
      process.exitCode = 2;
      return;
    }
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
