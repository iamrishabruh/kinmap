import type { RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import type { ICertificate } from 'aws-cdk-lib/aws-certificatemanager';
import type { ITable } from 'aws-cdk-lib/aws-dynamodb';
import type { IRole } from 'aws-cdk-lib/aws-iam';
import type { IKey } from 'aws-cdk-lib/aws-kms';
import type { RetentionDays } from 'aws-cdk-lib/aws-logs';
import type { IHostedZone } from 'aws-cdk-lib/aws-route53';
import type { IBucket } from 'aws-cdk-lib/aws-s3';
import type { ITopic } from 'aws-cdk-lib/aws-sns';

import type { AppEnv } from '@family/contracts';

/**
 * Typed configuration for the CDK application.
 *
 * Two rules govern everything in this module:
 *
 *  1. `cdk synth` MUST succeed with no AWS credentials and no real account ids,
 *     so CI can validate a fork pull request. Every value therefore comes from
 *     an environment variable with a harmless placeholder fallback, and nothing
 *     in this app is allowed to perform a context lookup (`Vpc.fromLookup`,
 *     `HostedZone.fromLookup`, `StringParameter.valueFromLookup`, ...).
 *  2. Nothing here may be a secret. Secrets live in Secrets Manager and are
 *     referenced by name at deploy time, never checked in.
 */

/** Placeholder used whenever a real 12-digit account id is not available. */
export const PLACEHOLDER_ACCOUNT = '000000000000';

/** Placeholder Route53 zone id; shaped like a real one so synth stays valid. */
export const PLACEHOLDER_HOSTED_ZONE_ID = 'Z00000000000000000000';

/** CloudFront and ACM certificates for CloudFront must live in us-east-1. */
export const EDGE_REGION = 'us-east-1';

/** Region used when neither AWS_REGION nor CDK_DEFAULT_REGION is set. */
export const DEFAULT_REGION = EDGE_REGION;

/** Product name; also the value of the mandatory `app` tag on every stack. */
export const APP_NAME = 'kinmap';

/**
 * Reads an environment variable, treating an empty string as absent so that a
 * CI expression such as `${{ vars.MISSING }}` degrades to the fallback instead
 * of producing an empty account id.
 */
export function envString(name: string, fallback: string): string {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

/** Reads an optional environment variable; empty or unset both yield undefined. */
export function envOptional(name: string): string | undefined {
  const value = envString(name, '');
  return value.length > 0 ? value : undefined;
}

/** Reads a numeric environment variable, falling back on anything unparseable. */
export function envNumber(name: string, fallback: number): number {
  const raw = envString(name, '');
  if (raw.length === 0) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Reads a comma-separated environment variable into a trimmed, non-empty list. */
export function envList(name: string, fallback: readonly string[]): readonly string[] {
  const raw = envString(name, '');
  if (raw.length === 0) {
    return fallback;
  }
  const parts = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return parts.length > 0 ? parts : fallback;
}

/**
 * Prefixes a physical resource name with `kinmap-<env>-`, unless the caller
 * already did. Both spellings appear at call sites — `queueName: 'geofence'`
 * and `queueName: \`${config.resourcePrefix}-geofence\`` — and silently
 * producing `kinmap-dev-kinmap-dev-geofence` would be a confusing deploy-time
 * surprise rather than a compile error.
 */
export function qualifiedName(prefix: string, name: string): string {
  return name === prefix || name.startsWith(`${prefix}-`) ? name : `${prefix}-${name}`;
}

/** GitHub Actions OIDC trust configuration for the deploy roles. */
export interface GitHubDeploymentConfig {
  readonly owner: string;
  readonly repository: string;
  /**
   * `sub` claims the deploy role will trust, e.g.
   * `repo:iamrishabruh/kinmap:ref:refs/heads/development`.
   */
  readonly deploySubjectClaims: readonly string[];
  /** `sub` claims allowed to assume the read-only diff role. */
  readonly diffSubjectClaims: readonly string[];
  /**
   * ARN of an OIDC provider that already exists in the account. When omitted
   * the foundation stack creates one — an account may only hold a single
   * provider per issuer URL.
   */
  readonly existingOidcProviderArn?: string;
}

/** CloudWatch alarm thresholds, tuned per environment. */
export interface AlarmThresholds {
  /** Lambda `Errors`, summed over five minutes. */
  readonly lambdaErrors: number;
  /** Lambda `Throttles`, summed over five minutes. */
  readonly lambdaThrottles: number;
  /** DynamoDB `ThrottledRequests`, summed over five minutes. */
  readonly tableThrottles: number;
  /** DynamoDB `SystemErrors`, summed over five minutes. */
  readonly tableSystemErrors: number;
  /** Messages visible on a dead-letter queue; anything above zero is a bug. */
  readonly deadLetterQueueDepth: number;
  /** API 5xx responses, summed over five minutes. */
  readonly apiServerErrors: number;
  /** API p99 latency in milliseconds. */
  readonly apiLatencyP99Millis: number;
}

/**
 * The single configuration object every stack receives. Stacks never read
 * `process.env` themselves — everything is resolved once, in `config/index.ts`.
 */
export interface EnvironmentConfig {
  // -- required by the shared wiring contract -------------------------------
  readonly envName: AppEnv;
  readonly account: string;
  readonly region: string;
  readonly domain: string;
  readonly apiDomain: string;
  /**
   * The hostname API Gateway's own custom domain answers on, and the only
   * origin the CloudFront distribution in front of {@link apiDomain} talks to.
   *
   * It exists because WAFv2 cannot attach to an API Gateway HTTP API, so the
   * ACL lives on a CloudFront distribution and CloudFront needs an origin
   * hostname distinct from the one it serves — pointing both at `api.<domain>`
   * would make the DNS record its own target.
   *
   * A single label under {@link domain} on purpose: the certificate carries
   * `*.<domain>`, which covers one label and not two, so `origin-label.<domain>`
   * validates and `origin.api.<domain>` would not.
   */
  readonly apiOriginDomain: string;
  readonly alarmEmail: string;
  readonly removalPolicy: RemovalPolicy;
  readonly isProduction: boolean;

  // -- naming ---------------------------------------------------------------
  /** `kinmap-<env>`; prefix for every physical resource name. */
  readonly resourcePrefix: string;
  /** `/kinmap/<env>`; the SSM parameter namespace owned by the foundation. */
  readonly parameterPrefix: string;
  /** Tag values applied to every stack. */
  readonly owner: string;
  readonly costCentre: string;

  // -- DNS and edge ---------------------------------------------------------
  /** Hostname the marketing/consent web surface is served from. */
  readonly webDomain: string;
  /** Route53 public hosted zone id for {@link domain}. Never looked up. */
  readonly hostedZoneId: string;
  /** Region ACM certificates for CloudFront must be created in. */
  readonly edgeRegion: string;

  // -- durability -----------------------------------------------------------
  /** DynamoDB deletion protection and S3/KMS retention. */
  readonly deletionProtection: boolean;
  readonly logRetention: RetentionDays;
  /** Audit and CloudTrail logs are kept far longer than application logs. */
  readonly auditLogRetention: RetentionDays;
  /** TTL applied to location history rows, in days (spec §37). */
  readonly historyRetentionDays: number;

  // -- cost -----------------------------------------------------------------
  readonly monthlyBudgetUsd: number;
  readonly costAnomalyThresholdUsd: number;

  // -- compute defaults -----------------------------------------------------
  readonly lambdaMemoryMb: number;
  readonly lambdaTimeoutSeconds: number;
  /** X-Ray sampling is always on; this widens it to include downstream calls. */
  readonly enableDetailedTracing: boolean;

  // -- operations -----------------------------------------------------------
  readonly alarmThresholds: AlarmThresholds;
  readonly github: GitHubDeploymentConfig;
}

/** Props shared by every stack in this application. */
export interface BaseStackProps extends StackProps {
  readonly config: EnvironmentConfig;
}

/**
 * What `FoundationStack` publishes to the rest of the application. Declared as
 * an interface so a consuming stack depends on the shape, not on the class.
 */
export interface FoundationResources {
  /** Public hosted zone for {@link EnvironmentConfig.domain}. */
  readonly hostedZone: IHostedZone;
  /** Regional ACM certificate covering the API domain. */
  readonly certificate: ICertificate;
  /** us-east-1 ACM certificate, required by CloudFront. */
  readonly cloudFrontCertificate: ICertificate;
  /** Customer-managed key protecting coordinates at rest (spec §20). */
  readonly coordinateKey: IKey;
  /** Customer-managed key for operational data: logs, queues, notifications. */
  readonly operationsKey: IKey;
  /** Build artifacts, exports and deployment bundles. */
  readonly artifactBucket: IBucket;
  /** S3 server access log target for every other bucket. */
  readonly accessLogBucket: IBucket;
  /** Operational alarms fan out here; never carries user data. */
  readonly alarmTopic: ITopic;
  /** `/kinmap/<env>` — the SSM namespace owned by the foundation stack. */
  readonly parameterPrefix: string;
  /** Role assumed by GitHub Actions to deploy this environment. */
  readonly deployRole: IRole;
  /**
   * Present only when the primary region is not us-east-1. Resources CloudFront
   * requires to live there — certificates, and any CLOUDFRONT-scoped WebACL —
   * are created in this stack instead of the consuming one.
   */
  readonly edgeStack?: Stack;
}

/**
 * Every DynamoDB table in the platform. Consuming stacks take this interface so
 * they can `grantReadData` / `grantWriteData` without importing `DataStack`.
 */
export interface DataTables {
  readonly users: ITable;
  readonly devices: ITable;
  readonly families: ITable;
  readonly familyMemberships: ITable;
  readonly invitations: ITable;
  readonly currentLocations: ITable;
  readonly locationHistory: ITable;
  readonly savedPlaces: ITable;
  readonly geofenceState: ITable;
  readonly notificationPreferences: ITable;
  readonly notifications: ITable;
  readonly liveSessions: ITable;
  readonly subscriptions: ITable;
  readonly auditEvents: ITable;
  readonly idempotency: ITable;
  readonly dataMigrations: ITable;
  readonly remoteConfiguration: ITable;
  readonly deletionJobs: ITable;
}

/** Props for a stack that consumes the foundation but no tables. */
export interface FoundationConsumerStackProps extends BaseStackProps {
  readonly foundation: FoundationResources;
}

/** Props for a stack that consumes both the foundation and the data layer. */
export interface DataConsumerStackProps extends FoundationConsumerStackProps {
  readonly tables: DataTables;
}
