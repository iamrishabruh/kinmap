/**
 * Whole-app assertions over the synthesised CloudFormation.
 *
 * The app is built the way CI builds it: `bin/app.ts` is executed in a child
 * process with `CDK_OUTDIR` pointed at a temporary directory, no AWS
 * credentials in the environment, and asset bundling disabled. That means these
 * tests exercise the real wiring produced by `config/` rather than a
 * hand-assembled subset of stacks, and they pass on a fork PR where there is no
 * account to look anything up in.
 *
 * Everything asserted here is an invariant the product cannot lose quietly:
 * recoverable data, expiring history, private buckets, traced and retained
 * logs, no un-redriven queue, no unauthenticated read path, and no
 * administrator-shaped IAM policy.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Template } from 'aws-cdk-lib/assertions';
import { CloudAssembly } from 'aws-cdk-lib/cx-api';
import { beforeAll, describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INFRA_DIR = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(INFRA_DIR, '..');
const APP_ENTRY = path.join(INFRA_DIR, 'bin', 'app.ts');
const TSX_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');

const SYNTH_TIMEOUT_MS = 300_000;

/**
 * CloudFront's AWS-managed `CachingDisabled` policy. The id is fixed across
 * every account, which is what makes asserting on it meaningful: caching an
 * authorised response at the edge would serve one family member's location to
 * another, so the API distribution must name this policy and no other.
 */
const CACHING_DISABLED_POLICY_ID = '4135ea2d-6df8-44a3-9df3-4b5a84be39ad';

type Resource = Record<string, unknown>;

type SynthStack = {
  readonly environment: string;
  readonly stackName: string;
  readonly account: string;
  readonly template: Template;
};

// ---------------------------------------------------------------------------
// Template helpers. `noUncheckedIndexedAccess` is on, so nothing here indexes
// blindly — a malformed template produces a readable failure, not a crash.
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function properties(resource: Resource): Record<string, unknown> {
  return asRecord(resource['Properties']) ?? {};
}

function prop(resource: Resource, key: string): unknown {
  return properties(resource)[key];
}

function metadataPath(resource: Resource): string {
  const metadata = asRecord(resource['Metadata']);
  const cdkPath = metadata?.['aws:cdk:path'];
  return typeof cdkPath === 'string' ? cdkPath : '';
}

function toList(value: unknown): unknown[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function tagValue(resource: Resource, key: string): string | undefined {
  for (const entry of toList(prop(resource, 'Tags'))) {
    const record = asRecord(entry);
    const value = record?.['Value'];
    if (record?.['Key'] === key && typeof value === 'string') return value;
  }
  return undefined;
}

function resourcesOf(stack: SynthStack, type: string): Array<[string, Resource]> {
  return Object.entries(stack.template.findResources(type) as Record<string, Resource>);
}

function describeResource(stack: SynthStack, logicalId: string): string {
  return `${stack.environment}/${stack.stackName}/${logicalId}`;
}

// ---------------------------------------------------------------------------
// Synthesis
// ---------------------------------------------------------------------------

/**
 * Feature flags from `cdk.json`. Running `bin/app.ts` directly bypasses the CDK
 * CLI, which is what normally reads that file, so the flags are passed through
 * `CDK_CONTEXT_JSON` instead. Without this the templates asserted here would
 * differ from the ones `cdk synth` produces.
 */
function cdkJsonContext(): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(path.join(INFRA_DIR, 'cdk.json'), 'utf8'));
  const context = asRecord(asRecord(parsed)?.['context']);
  return context ?? {};
}

function childEnvironment(envName: string, outdir: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    // A fork PR has no credentials; prove synth does not need any.
    if (key.startsWith('AWS_')) continue;
    if (key === 'CDK_DEFAULT_ACCOUNT' || key === 'CDK_DEFAULT_REGION') continue;
    env[key] = value;
  }
  env['CDK_OUTDIR'] = outdir;
  env['CDK_CONTEXT_JSON'] = JSON.stringify({
    ...cdkJsonContext(),
    // Skip asset bundling: these assertions are about the template, and
    // bundling every service would make the suite depend on esbuild output.
    'aws:cdk:bundling-stacks': [],
  });
  // `CDK_ENVIRONMENT` is canonical; `APP_ENV` is the accepted alias.
  env['CDK_ENVIRONMENT'] = envName;
  env['APP_ENV'] = envName;
  env['NODE_ENV'] = 'test';
  return env;
}

function synthesize(envName: string): SynthStack[] {
  const outdir = mkdtempSync(path.join(tmpdir(), `kinmap-synth-${envName}-`));
  const useTsxBin = existsSync(TSX_BIN);
  const command = useTsxBin ? TSX_BIN : process.execPath;
  const args = useTsxBin ? [APP_ENTRY] : ['--import', 'tsx', APP_ENTRY];

  try {
    execFileSync(command, args, {
      cwd: INFRA_DIR,
      env: childEnvironment(envName, outdir),
      stdio: 'pipe',
      timeout: SYNTH_TIMEOUT_MS,
    });
  } catch (error) {
    const failure = error as { stdout?: Buffer; stderr?: Buffer; message?: string };
    throw new Error(
      [
        `Synthesising ${APP_ENTRY} for CDK_ENVIRONMENT=${envName} failed.`,
        failure.stderr?.toString() ?? '',
        failure.stdout?.toString() ?? '',
        failure.message ?? '',
      ].join('\n'),
      { cause: error },
    );
  }

  const stacks = new CloudAssembly(outdir).stacksRecursively;
  if (stacks.length === 0) {
    throw new Error(
      `${APP_ENTRY} produced no stacks in ${outdir}. The CDK app must synthesise when CDK_OUTDIR is set.`,
    );
  }

  return stacks.map((artifact) => ({
    environment: envName,
    stackName: artifact.stackName,
    account: artifact.environment.account,
    template: Template.fromJSON(artifact.template as Record<string, unknown>),
  }));
}

let allStacks: SynthStack[] = [];

beforeAll(() => {
  allStacks = [...synthesize('development'), ...synthesize('production')];
}, SYNTH_TIMEOUT_MS * 2);

// ---------------------------------------------------------------------------

describe('synthesised application', () => {
  it('synthesises without any AWS credentials in the environment', () => {
    const forwarded = Object.keys(childEnvironment('development', tmpdir()));
    expect(forwarded.filter((key) => key.startsWith('AWS_'))).toEqual([]);
    expect(forwarded).not.toContain('CDK_DEFAULT_ACCOUNT');
    expect(forwarded).not.toContain('CDK_DEFAULT_REGION');
    expect(allStacks.length, 'the app must synthesise at least one stack').toBeGreaterThan(0);
  });

  it('resolves every stack to a concrete account without a context lookup', () => {
    for (const stack of allStacks) {
      // `unknown-account` means the stack fell back to the ambient CLI
      // environment, which a fork PR does not have.
      expect(stack.account, `${stack.stackName}: account`).toMatch(/^\d{12}$/);
    }
  });
});

describe('DynamoDB tables', () => {
  it('enable point-in-time recovery and server-side encryption', () => {
    let tableCount = 0;
    for (const stack of allStacks) {
      for (const [logicalId, table] of resourcesOf(stack, 'AWS::DynamoDB::Table')) {
        tableCount += 1;
        const where = describeResource(stack, logicalId);
        const pitr = asRecord(prop(table, 'PointInTimeRecoverySpecification'));
        expect(pitr?.['PointInTimeRecoveryEnabled'], `${where}: PITR must be enabled`).toBe(true);

        const sse = asRecord(prop(table, 'SSESpecification'));
        expect(sse?.['SSEEnabled'], `${where}: SSE must be enabled`).toBe(true);
      }
    }
    expect(tableCount, 'the app must define DynamoDB tables').toBeGreaterThan(0);
  });

  it('expire location history through a TTL on expiresAt', () => {
    const historyTables: Array<[string, Resource]> = [];
    for (const stack of allStacks) {
      for (const entry of resourcesOf(stack, 'AWS::DynamoDB::Table')) {
        const [logicalId, table] = entry;
        const tableName = prop(table, 'TableName');
        const haystack = `${logicalId} ${typeof tableName === 'string' ? tableName : ''}`;
        if (/locationhistory/i.test(haystack.replace(/[^a-z0-9]/gi, ''))) {
          historyTables.push(entry);
        }
      }
    }

    expect(historyTables.length, 'a LocationHistory table must exist').toBeGreaterThan(0);
    for (const [logicalId, table] of historyTables) {
      const ttl = asRecord(prop(table, 'TimeToLiveSpecification'));
      expect(ttl?.['Enabled'], `${logicalId}: history TTL must be enabled`).toBe(true);
      expect(ttl?.['AttributeName'], `${logicalId}: history TTL attribute`).toBe('expiresAt');
    }
  });

  it('protect production tables from deletion', () => {
    const productionTables: Array<[string, Resource]> = [];
    for (const stack of allStacks) {
      for (const entry of resourcesOf(stack, 'AWS::DynamoDB::Table')) {
        if (tagValue(entry[1], 'env') === 'production') productionTables.push(entry);
      }
    }

    expect(
      productionTables.length,
      'the app must expose a production configuration whose tables are tagged env=production',
    ).toBeGreaterThan(0);

    for (const [logicalId, table] of productionTables) {
      expect(
        prop(table, 'DeletionProtectionEnabled'),
        `${logicalId}: production tables must set DeletionProtectionEnabled`,
      ).toBe(true);
    }
  });
});

describe('S3 buckets', () => {
  it('block all public access', () => {
    let bucketCount = 0;
    for (const stack of allStacks) {
      for (const [logicalId, bucket] of resourcesOf(stack, 'AWS::S3::Bucket')) {
        bucketCount += 1;
        const where = describeResource(stack, logicalId);
        const block = asRecord(prop(bucket, 'PublicAccessBlockConfiguration'));
        expect(block, `${where}: must set PublicAccessBlockConfiguration`).toBeDefined();
        for (const key of [
          'BlockPublicAcls',
          'BlockPublicPolicy',
          'IgnorePublicAcls',
          'RestrictPublicBuckets',
        ]) {
          expect(block?.[key], `${where}: ${key} must be true`).toBe(true);
        }
      }
    }
    expect(bucketCount, 'the app must define S3 buckets').toBeGreaterThan(0);
  });
});

describe('Lambda functions', () => {
  /** CDK's own singletons (custom-resource providers, log-retention helpers). */
  const CDK_MANAGED = new RegExp(
    [
      'LogRetention',
      'AutoDeleteObjects',
      'BucketDeployment',
      'BucketNotificationsHandler',
      'framework-on',
      'framework-is',
      'CustomResourceProvider',
      'AWSCDKCfnUtils',
      'CrossRegion',
      'Custom::',
      // The singleton behind `AwsCustomResource`. CDK fixes this logical id, and
      // the construct exposes neither tracing nor a log group to configure, so
      // it belongs with the other CDK-owned helpers above rather than being a
      // function this platform is failing to instrument.
      'AWS679f53fac002430cb0da5b7982bd2287',
    ].join('|'),
    'i',
  );

  function isCdkManaged(logicalId: string, resource: Resource): boolean {
    const description = prop(resource, 'Description');
    const haystack = [
      logicalId,
      metadataPath(resource),
      typeof description === 'string' ? description : '',
    ].join(' ');
    return CDK_MANAGED.test(haystack) || /resource provider framework/i.test(haystack);
  }

  it('enable active tracing', () => {
    let functionCount = 0;
    for (const stack of allStacks) {
      for (const [logicalId, fn] of resourcesOf(stack, 'AWS::Lambda::Function')) {
        if (isCdkManaged(logicalId, fn)) continue;
        functionCount += 1;
        const tracing = asRecord(prop(fn, 'TracingConfig'));
        expect(tracing?.['Mode'], `${describeResource(stack, logicalId)}: tracing`).toBe('Active');
      }
    }
    expect(functionCount, 'the app must define Lambda functions').toBeGreaterThan(0);
  });

  it('bind every function to a log group with a retention setting', () => {
    for (const stack of allStacks) {
      // Log groups that declare a retention, keyed by their literal name.
      const retainedLogGroups = new Set<string>();
      for (const [, group] of resourcesOf(stack, 'AWS::Logs::LogGroup')) {
        const name = prop(group, 'LogGroupName');
        if (typeof name === 'string' && prop(group, 'RetentionInDays') !== undefined) {
          retainedLogGroups.add(name);
        }
      }
      // The legacy `logRetention` prop renders as a custom resource instead.
      const logRetentionResources = JSON.stringify(
        stack.template.findResources('Custom::LogRetention'),
      );

      for (const [logicalId, fn] of resourcesOf(stack, 'AWS::Lambda::Function')) {
        if (isCdkManaged(logicalId, fn)) continue;
        const where = describeResource(stack, logicalId);

        const loggingConfig = asRecord(prop(fn, 'LoggingConfig'));
        if (loggingConfig?.['LogGroup'] !== undefined) continue;

        if (logRetentionResources.includes(`"${logicalId}"`)) continue;

        const functionName = prop(fn, 'FunctionName');
        if (
          typeof functionName === 'string' &&
          retainedLogGroups.has(`/aws/lambda/${functionName}`)
        ) {
          continue;
        }

        throw new Error(
          `${where}: no log retention. Pass an explicit logGroup (preferred) or logRetention, ` +
            'so location-adjacent logs cannot accumulate forever.',
        );
      }
    }
  });
});

describe('SQS queues', () => {
  it('redrive every work queue to a dead-letter queue', () => {
    let queueCount = 0;
    for (const stack of allStacks) {
      const queues = resourcesOf(stack, 'AWS::SQS::Queue');

      // A queue that another queue redrives to is itself a DLQ.
      const deadLetterTargets = new Set<string>();
      for (const [, queue] of queues) {
        const redrive = asRecord(prop(queue, 'RedrivePolicy'));
        const target = asRecord(redrive?.['deadLetterTargetArn']);
        for (const value of toList(target?.['Fn::GetAtt'])) {
          if (typeof value === 'string') deadLetterTargets.add(value);
        }
      }

      for (const [logicalId, queue] of queues) {
        const queueName = prop(queue, 'QueueName');
        const haystack = `${logicalId} ${typeof queueName === 'string' ? queueName : ''}`;
        const isDeadLetter =
          deadLetterTargets.has(logicalId) || /dlq|dead[-_]?letter/i.test(haystack);
        if (isDeadLetter) continue;

        queueCount += 1;
        expect(
          asRecord(prop(queue, 'RedrivePolicy')),
          `${describeResource(stack, logicalId)}: work queues must declare a RedrivePolicy`,
        ).toBeDefined();
      }
    }
    expect(queueCount, 'the app must define work queues').toBeGreaterThan(0);
  });
});

describe('HTTP API', () => {
  it('authorises every route that is not a provider webhook', () => {
    let routeCount = 0;
    let guardedCount = 0;

    for (const stack of allStacks) {
      for (const [logicalId, route] of resourcesOf(stack, 'AWS::ApiGatewayV2::Route')) {
        const routeKey = prop(route, 'RouteKey');
        if (typeof routeKey !== 'string') continue;
        routeCount += 1;

        // Webhooks are authenticated by provider signature, not by our
        // authorizer, and the health route must answer an unauthenticated probe.
        if (/webhook/i.test(routeKey) || /health/i.test(routeKey)) continue;
        if (routeKey.startsWith('OPTIONS ')) continue;

        const authorizationType = prop(route, 'AuthorizationType');
        const authorizerId = prop(route, 'AuthorizerId');
        const guarded =
          authorizerId !== undefined ||
          (typeof authorizationType === 'string' && authorizationType !== 'NONE');

        expect(
          guarded,
          `${describeResource(stack, logicalId)} (${routeKey}): every sensitive route is authorised server-side`,
        ).toBe(true);
        guardedCount += 1;
      }
    }

    expect(routeCount, 'the app must define an HTTP API').toBeGreaterThan(0);
    expect(guardedCount, 'the app must define authorised routes').toBeGreaterThan(0);
  });

  it('gives every custom domain a DNS record pointing at it', () => {
    // An API Gateway custom domain reports AVAILABLE and its certificate reports
    // ISSUED whether or not anything resolves to it, so a missing alias record
    // is invisible until a client gets NXDOMAIN.
    let checked = 0;

    for (const stack of allStacks) {
      const aliasTargets = new Set<string>();
      for (const [, record] of resourcesOf(stack, 'AWS::Route53::RecordSet')) {
        const name = prop(record, 'Name');
        if (typeof name === 'string') aliasTargets.add(name.replace(/\.$/, ''));
      }

      for (const [logicalId, domain] of resourcesOf(stack, 'AWS::ApiGatewayV2::DomainName')) {
        const domainName = prop(domain, 'DomainName');
        if (typeof domainName !== 'string') continue;
        checked += 1;
        expect(
          aliasTargets.has(domainName),
          `${describeResource(stack, logicalId)}: ${domainName} has no Route 53 record, so it will not resolve`,
        ).toBe(true);
      }
    }

    expect(checked, 'the API must define a custom domain').toBeGreaterThan(0);
  });
});

const SERVICES_ROOT = path.join(REPO_ROOT, 'services');

/**
 * Routes the API declares that no service implements yet.
 *
 * Empty, and worth keeping that way. It held fourteen entries — saved places,
 * live sessions, notifications and receipt submission — every one of which
 * returned 404 to an authenticated caller while every stack reported
 * CREATE_COMPLETE. The list exists so that a route added without a handler
 * fails a test instead of shipping as a dead endpoint.
 */
const ROUTES_WITHOUT_A_HANDLER: ReadonlySet<string> = new Set([]);

describe('API routes have handlers', () => {
  it('never points a route at a function with no handler for it', () => {
    // Twenty-eight routes were integrated with services/api, which registers a
    // handler for none of them, so the whole families, invitations, places and
    // live-session surface answered 404 while every stack reported
    // CREATE_COMPLETE. Nothing failed: an API Gateway route is valid whether or
    // not the Lambda behind it knows the path.
    const apiRoutePaths = new Set<string>();
    const routesDir = path.join(REPO_ROOT, 'services', 'api', 'src', 'routes');
    for (const entry of readdirSync(routesDir)) {
      if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue;
      const source = readFileSync(path.join(routesDir, entry), 'utf8');
      for (const match of source.matchAll(/path:\s*'(\/v1\/[^']*)'/g)) {
        const routePath = match[1];
        if (routePath !== undefined) apiRoutePaths.add(routePath);
      }
    }
    expect(apiRoutePaths.size, 'services/api must register routes').toBeGreaterThan(0);

    const stack = allStacks.find(
      (candidate) =>
        candidate.environment === 'development' && candidate.stackName.endsWith('-api'),
    );
    expect(stack, 'the development API stack must synthesise').toBeDefined();
    if (stack === undefined) return;

    // Integrations whose Lambda is not services/api are backed by a dedicated
    // function; this assertion is about the shared one.
    const apiIntegrations = new Set<string>();
    for (const [logicalId] of resourcesOf(stack, 'AWS::ApiGatewayV2::Integration')) {
      if (logicalId.includes('ApiIntegration')) apiIntegrations.add(logicalId);
    }

    const orphaned: string[] = [];
    for (const [, route] of resourcesOf(stack, 'AWS::ApiGatewayV2::Route')) {
      const routeKey = prop(route, 'RouteKey');
      if (typeof routeKey !== 'string') continue;
      const target = JSON.stringify(prop(route, 'Target') ?? '');
      if (![...apiIntegrations].some((id) => target.includes(id))) continue;

      const routePath = routeKey.slice(routeKey.indexOf(' ') + 1);
      if (apiRoutePaths.has(routePath)) continue;
      if (ROUTES_WITHOUT_A_HANDLER.has(routeKey)) continue;
      orphaned.push(routeKey);
    }

    expect(
      orphaned.sort(),
      'these routes reach services/api, which has no handler for them, so they 404:\n' +
        orphaned.join('\n'),
    ).toEqual([]);
  });
});

describe('the mobile client and the API agree', () => {
  /**
   * Every (method, path) the app asks for, read from its source.
   *
   * The two sides talk over HTTP and nothing type-checks between them. They had
   * drifted until fourteen of the twenty-one paths the app called did not exist
   * on the deployed API — including every authentication endpoint, so the app
   * could not sign in at all. Nothing failed at build time on either side.
   */
  function clientCalls(): Array<{ method: string; path: string; file: string }> {
    const calls: Array<{ method: string; path: string; file: string }> = [];
    const root = path.join(REPO_ROOT, 'apps', 'mobile', 'src');

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
        const source = readFileSync(full, 'utf8');
        // Both orderings appear in the client, both span lines, and a
        // parameterised path is a template literal — `/v1/devices/${id}`.
        // Matching only quoted strings would silently skip every route with a
        // parameter in it, which is most of the interesting ones.
        for (const match of source.matchAll(
          /method:\s*'([A-Z]+)',\s*path:\s*['`](\/v1\/[^'`]*)['`]|path:\s*['`](\/v1\/[^'`]*)['`],\s*method:\s*'([A-Z]+)'/g,
        )) {
          const method = match[1] ?? match[4];
          const raw = match[2] ?? match[3];
          if (method === undefined || raw === undefined) continue;
          // `${anything}` is a path parameter by construction.
          const routePath = raw.replace(/\$\{[^}]*\}/g, '{}');
          calls.push({ method, path: routePath, file: path.relative(REPO_ROOT, full) });
        }
      }
    };

    walk(root);
    return calls;
  }

  it('never calls an endpoint the API does not declare', () => {
    const stack = allStacks.find(
      (candidate) =>
        candidate.environment === 'development' && candidate.stackName.endsWith('-api'),
    );
    expect(stack, 'the development API stack must synthesise').toBeDefined();
    if (stack === undefined) return;

    // Path parameters are named differently on each side ({userId} vs {id}), and
    // the names are not part of the contract — the shape is.
    const shapeOf = (value: string): string => value.replace(/\{[^}]+\}/g, '{}');

    const declared = new Set<string>();
    for (const [, route] of resourcesOf(stack, 'AWS::ApiGatewayV2::Route')) {
      const routeKey = prop(route, 'RouteKey');
      if (typeof routeKey !== 'string') continue;
      const [method, routePath] = routeKey.split(' ');
      if (method === undefined || routePath === undefined) continue;
      declared.add(`${method} ${shapeOf(routePath)}`);
    }
    expect(declared.size, 'the API must declare routes').toBeGreaterThan(0);

    const calls = clientCalls();
    expect(calls.length, 'the client must call the API').toBeGreaterThan(0);

    const missing = calls
      .filter((call) => !declared.has(`${call.method} ${shapeOf(call.path)}`))
      .map((call) => `${call.method} ${call.path}  (${call.file})`)
      .sort();

    expect(
      [...new Set(missing)],
      'the app calls these, and the API does not declare them, so they 404 on a device:\n' +
        [...new Set(missing)].join('\n'),
    ).toEqual([]);
  });
});

describe('Lambda configuration', () => {
  /**
   * Every variable a service's config loader demands, read from its source.
   *
   * The loaders call `requireEnv`/`requireString` at module scope, so a missing
   * variable is not a degraded feature — the module throws before the handler
   * exists and every invocation fails with an opaque 502.
   */
  function requiredEnvironment(serviceName: string): Set<string> {
    const root = path.join(SERVICES_ROOT, serviceName, 'src');
    const required = new Set<string>();
    if (!existsSync(root)) return required;

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
          const source = readFileSync(full, 'utf8');
          for (const match of source.matchAll(
            /require(?:Env|String|Number)\((?:source,\s*)?'([A-Z_]+)'\)/g,
          )) {
            const name = match[1];
            if (name !== undefined) required.add(name);
          }
        }
      }
    };
    walk(root);
    return required;
  }

  it('gives every function every environment variable its code requires', () => {
    // This is the defect that took the whole product down while every stack
    // reported CREATE_COMPLETE: seven functions were deployed without variables
    // their own config loaders demanded. CloudFormation does not compare a
    // Lambda's environment against the code that reads it, and a function that
    // is never invoked never reports the crash, so nothing anywhere went red.
    let checked = 0;
    const failures: string[] = [];

    for (const stack of allStacks) {
      for (const [logicalId, fn] of resourcesOf(stack, 'AWS::Lambda::Function')) {
        // NodeService stamps the service whose code this function runs. It is
        // not always the function's own name — all three billing webhooks run
        // services/subscription-worker — and the environment a function needs
        // is decided by its bundle.
        const metadata = fn['Metadata'] as Record<string, unknown> | undefined;
        const serviceName = metadata?.['kinmap:bundle'];
        if (typeof serviceName !== 'string') continue;

        const required = requiredEnvironment(serviceName);
        if (required.size === 0) continue;
        checked += 1;

        const environment = (fn['Properties'] as Record<string, unknown> | undefined)?.[
          'Environment'
        ] as { Variables?: Record<string, unknown> } | undefined;
        const provided = new Set(Object.keys(environment?.Variables ?? {}));

        const missing = [...required].filter((name) => !provided.has(name)).sort();
        if (missing.length > 0) {
          failures.push(
            `${describeResource(stack, logicalId)} (services/${serviceName}): missing ${missing.join(', ')}`,
          );
        }
      }
    }

    expect(failures, failures.join('\n')).toEqual([]);
    expect(checked, 'the app must deploy service functions').toBeGreaterThan(0);
  });
});

describe('outbound mail', () => {
  it('never grants ses:SendRawEmail without pinning the From address', () => {
    // The resource on an SES send grant is not a reliable restriction: SES also
    // authorises against the recipient identity while an account is in the
    // sandbox, so a resource-scoped grant fails after the mail has already been
    // accepted and stored. `ses:FromAddress` is the control that actually binds,
    // so it is the one this asserts on.
    let grants = 0;

    for (const stack of allStacks) {
      for (const [logicalId, policy] of resourcesOf(stack, 'AWS::IAM::Policy')) {
        const document = prop(policy, 'PolicyDocument') as
          { Statement?: Array<Record<string, unknown>> } | undefined;

        for (const statement of document?.Statement ?? []) {
          const actions = JSON.stringify(statement['Action'] ?? '');
          if (!actions.includes('ses:SendRawEmail') && !actions.includes('ses:SendEmail')) {
            continue;
          }
          if (statement['Effect'] !== 'Allow') continue;
          grants += 1;

          const condition = JSON.stringify(statement['Condition'] ?? {});
          expect(
            condition.includes('ses:FromAddress'),
            `${describeResource(stack, logicalId)}: an SES send grant must pin ses:FromAddress, ` +
              'or the principal can send as any address on the account',
          ).toBe(true);
        }
      }
    }

    expect(grants, 'the mail forwarder must be able to send').toBeGreaterThan(0);
  });
});

describe('the public site', () => {
  it('publishes content into every distribution it creates', () => {
    // A CloudFront distribution in front of an empty bucket deploys perfectly:
    // DNS resolves, TLS is valid, and every request returns 403. The casualty
    // is /.well-known/apple-app-site-association, which is what makes an
    // invitation link open the app instead of Safari — and Apple fetches it
    // from the live domain with no way to report that it was never uploaded.
    //
    // Only distributions whose origin is a bucket are in scope. The API
    // distribution's origin is API Gateway, which serves itself; requiring a
    // BucketDeployment there would be requiring a bucket that should not exist.
    let bucketBacked = 0;

    for (const stack of allStacks) {
      const dists = resourcesOf(stack, 'AWS::CloudFront::Distribution').filter(([, resource]) => {
        const config = asRecord(resource.Properties)?.['DistributionConfig'];
        const origins = asRecord(config)?.['Origins'];
        // A bucket origin carries S3OriginConfig; anything else — API Gateway
        // here — is a custom origin that serves itself.
        return (
          Array.isArray(origins) &&
          origins.some((origin) => asRecord(origin)?.['S3OriginConfig'] !== undefined)
        );
      });
      if (dists.length === 0) continue;
      bucketBacked += dists.length;

      const publishes = resourcesOf(stack, 'Custom::CDKBucketDeployment');
      expect(
        publishes.length,
        `${stack.stackName}: creates a CloudFront distribution over a bucket but never publishes anything into it`,
      ).toBeGreaterThan(0);
    }

    expect(bucketBacked, 'the app must serve a public site').toBeGreaterThan(0);
  });

  it('puts the WebACL in front of the API instead of merely defining it', () => {
    // The rules were written, reviewed and deployed for a long time while
    // protecting nothing: WAFv2 cannot attach to an API Gateway HTTP API, and
    // the ACL sat unassociated. Nothing failed, no alarm fired, and the only
    // evidence was a comment. This asserts the association exists, that it is
    // the ACL with the rules in it, and that the distribution carrying it is
    // the one clients actually resolve.
    let verified = 0;

    for (const stack of allStacks) {
      for (const [, acl] of resourcesOf(stack, 'AWS::WAFv2::WebACL')) {
        expect(
          prop(acl, 'Scope'),
          `${stack.stackName}: a REGIONAL ACL cannot attach to an HTTP API — it must be CLOUDFRONT`,
        ).toBe('CLOUDFRONT');
      }

      for (const [logicalId, dist] of resourcesOf(stack, 'AWS::CloudFront::Distribution')) {
        const config = asRecord(prop(dist, 'DistributionConfig'));
        const origins = config?.['Origins'];
        // The API distribution is the one with a custom origin; the site's
        // origin is a bucket and is covered by its own guards.
        const frontsTheApi =
          Array.isArray(origins) &&
          origins.some((origin) => asRecord(origin)?.['CustomOriginConfig'] !== undefined);
        if (!frontsTheApi) continue;
        verified += 1;

        // Required in production; deliberately absent elsewhere, because a
        // WebACL is billed per month per environment and development and
        // staging have no users to protect. The distribution still exists
        // everywhere, so this is a cost decision and not a design one.
        if (stack.environment === 'production') {
          expect(
            config?.['WebACLId'],
            `${describeResource(stack, logicalId)}: production fronts the API with no WebACL attached`,
          ).toBeDefined();
        }
        expect(
          asRecord(config?.['DefaultCacheBehavior'])?.['CachePolicyId'],
          `${describeResource(stack, logicalId)}: must name a cache policy, and it must be the disabled one`,
        ).toBe(CACHING_DISABLED_POLICY_ID);
      }
    }

    const environments = new Set(allStacks.map((stack) => stack.environment));
    expect(
      verified,
      'every environment must reach its API through a distribution that carries the ACL',
    ).toBe(environments.size);
  });

  it('synthesises against the bootstrap qualifier each account actually has', () => {
    // Development and staging carry CDK's default; production was bootstrapped
    // with `kinmap`, so its roles are `cdk-kinmap-*`. Synthesising for the
    // default produced "SSM parameter /cdk-bootstrap/hnb659fds/version not
    // found. Has the environment been bootstrapped?" against an account that
    // was bootstrapped — the message names the wrong cause, and the deploy
    // stops before a single resource is created.
    const EXPECTED: Record<string, string> = {
      development: 'hnb659fds',
      production: 'kinmap',
    };
    let checked = 0;

    for (const stack of allStacks) {
      const qualifier = EXPECTED[stack.environment];
      if (qualifier === undefined) continue;

      const parameters = stack.template.toJSON()['Parameters'] as
        Record<string, { Default?: unknown }> | undefined;
      const version = parameters?.['BootstrapVersion'];
      if (version === undefined) continue;
      checked += 1;

      expect(
        version.Default,
        `${stack.stackName}: looks for a bootstrap parameter this account does not have`,
      ).toBe(`/cdk-bootstrap/${qualifier}/version`);
    }

    expect(checked, 'stacks must declare which bootstrap they need').toBeGreaterThan(0);
  });

  it('creates a federated provider whenever its secret is configured', () => {
    // `IdentityStackProps.federatedIdentitySecrets` documented itself as
    // "sourced from the environment configuration by bin/app.ts", and bin/app.ts
    // never passed it. So `secrets.appleSecretArn` was permanently undefined and
    // the Sign in with Apple provider could not be created however complete the
    // credentials were — the same shape of defect as the deletion dispatcher,
    // the auth bridge, the routing guard and the transport before it.
    //
    // Asserted from the synthesised template rather than from the config, so it
    // fails if the wiring is removed at any point between the two.
    for (const stack of allStacks) {
      const providers = resourcesOf(stack, 'AWS::Cognito::UserPoolIdentityProvider');
      const apple = providers.find(([, p]) => prop(p, 'ProviderName') === 'SignInWithApple');
      const hasSecret = JSON.stringify(stack.template.toJSON()).includes('identity/apple');
      if (!hasSecret) continue;

      expect(
        apple,
        `${stack.stackName}: an Apple secret is configured but no provider is created`,
      ).toBeDefined();
    }
  });

  it('closes the execute-api endpoint that would route around the WebACL', () => {
    // `<apiId>.execute-api.<region>.amazonaws.com` answers the same routes and
    // never touches CloudFront, so leaving it open would make the ACL above
    // optional for anyone who read an API id out of a stack output.
    let apis = 0;

    for (const stack of allStacks) {
      for (const [logicalId, api] of resourcesOf(stack, 'AWS::ApiGatewayV2::Api')) {
        apis += 1;
        expect(
          prop(api, 'DisableExecuteApiEndpoint'),
          `${describeResource(stack, logicalId)}: the default endpoint bypasses CloudFront and its WebACL`,
        ).toBe(true);
      }
    }

    expect(apis, 'the platform must declare an HTTP API').toBeGreaterThan(0);
  });

  it('serves the association file as JSON and without a long cache', () => {
    // Apple requires content-type application/json on an extensionless file,
    // which S3 would otherwise guess as application/octet-stream, and a stale
    // cached copy would keep a corrected app ID from taking effect.
    let checked = 0;

    for (const stack of allStacks) {
      for (const [logicalId, deployment] of resourcesOf(stack, 'Custom::CDKBucketDeployment')) {
        const prefix = prop(deployment, 'DestinationBucketKeyPrefix');
        if (prefix !== '.well-known') continue;
        checked += 1;

        // CDK folds both into SystemMetadata rather than naming them directly.
        const metadata = prop(deployment, 'SystemMetadata') as Record<string, string> | undefined;

        expect(
          metadata?.['content-type'],
          `${describeResource(stack, logicalId)}: iOS rejects the association file unless it is application/json`,
        ).toBe('application/json');

        const maxAge = /max-age=(\d+)/.exec(metadata?.['cache-control'] ?? '')?.[1];
        expect(
          maxAge === undefined ? undefined : Number(maxAge),
          `${describeResource(stack, logicalId)}: the association file needs a short max-age so a corrected app ID takes effect`,
        ).toBeLessThanOrEqual(3600);
      }
    }

    expect(checked, 'the association files must be published').toBeGreaterThan(0);
  });
});

describe('IAM', () => {
  function statementsOf(document: unknown): Array<Record<string, unknown>> {
    const statements: Array<Record<string, unknown>> = [];
    for (const entry of toList(asRecord(document)?.['Statement'])) {
      const record = asRecord(entry);
      if (record) statements.push(record);
    }
    return statements;
  }

  function isAdministrative(statement: Record<string, unknown>): boolean {
    if (statement['Effect'] !== 'Allow') return false;
    const actions = toList(statement['Action']);
    const resources = toList(statement['Resource']);
    return actions.includes('*') && resources.includes('*');
  }

  it('grants no statement with Action "*" on Resource "*"', () => {
    for (const stack of allStacks) {
      const documents: Array<[string, unknown]> = [];

      for (const [logicalId, policy] of resourcesOf(stack, 'AWS::IAM::Policy')) {
        documents.push([logicalId, prop(policy, 'PolicyDocument')]);
      }
      for (const [logicalId, policy] of resourcesOf(stack, 'AWS::IAM::ManagedPolicy')) {
        documents.push([logicalId, prop(policy, 'PolicyDocument')]);
      }
      for (const [logicalId, role] of resourcesOf(stack, 'AWS::IAM::Role')) {
        for (const inline of toList(prop(role, 'Policies'))) {
          documents.push([logicalId, asRecord(inline)?.['PolicyDocument']]);
        }
      }

      for (const [logicalId, document] of documents) {
        for (const statement of statementsOf(document)) {
          expect(
            isAdministrative(statement),
            `${describeResource(stack, logicalId)}: "*" on "*" is never the least privilege this product needs`,
          ).toBe(false);
        }
      }
    }
  });
});

describe('telemetry privacy', () => {
  /** A decimal with four or more fractional digits is coordinate-shaped. */
  const COORDINATE_SHAPED = /-?\d{1,3}\.\d{4,}/;
  const COORDINATE_NAMES = /^(lat|latitude|lon|lng|longitude|coord(inate)?s?|latlng|latlon)$/i;

  it('never uses a coordinate as an alarm dimension', () => {
    for (const stack of allStacks) {
      for (const [logicalId, alarm] of resourcesOf(stack, 'AWS::CloudWatch::Alarm')) {
        const where = describeResource(stack, logicalId);
        const dimensionSets = [
          ...toList(prop(alarm, 'Dimensions')),
          ...toList(prop(alarm, 'Metrics')).flatMap((metric) => {
            const stat = asRecord(asRecord(metric)?.['MetricStat']);
            return toList(asRecord(stat?.['Metric'])?.['Dimensions']);
          }),
        ];

        for (const entry of dimensionSets) {
          const dimension = asRecord(entry);
          const name = dimension?.['Name'];
          const value = dimension?.['Value'];
          if (typeof name === 'string') {
            expect(COORDINATE_NAMES.test(name), `${where}: dimension "${name}"`).toBe(false);
          }
          if (typeof value === 'string') {
            expect(COORDINATE_SHAPED.test(value), `${where}: dimension value`).toBe(false);
          }
        }
      }
    }
  });
});
