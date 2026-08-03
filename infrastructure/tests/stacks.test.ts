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
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
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

describe('the public site', () => {
  it('publishes content into every distribution it creates', () => {
    // A CloudFront distribution in front of an empty bucket deploys perfectly:
    // DNS resolves, TLS is valid, and every request returns 403. The casualty
    // is /.well-known/apple-app-site-association, which is what makes an
    // invitation link open the app instead of Safari — and Apple fetches it
    // from the live domain with no way to report that it was never uploaded.
    let distributions = 0;

    for (const stack of allStacks) {
      const dists = [...resourcesOf(stack, 'AWS::CloudFront::Distribution')];
      if (dists.length === 0) continue;
      distributions += dists.length;

      const publishes = [...resourcesOf(stack, 'Custom::CDKBucketDeployment')];
      expect(
        publishes.length,
        `${stack}: creates a CloudFront distribution but never publishes anything into its origin`,
      ).toBeGreaterThan(0);
    }

    expect(distributions, 'the app must serve a public site').toBeGreaterThan(0);
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
