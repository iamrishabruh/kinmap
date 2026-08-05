import { RemovalPolicy } from 'aws-cdk-lib';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';

import { LIMITS } from '@family/contracts';

import {
  APP_NAME,
  DEFAULT_REGION,
  EDGE_REGION,
  envList,
  githubSubjectClaims,
  envNumber,
  envOptional,
  envString,
  PLACEHOLDER_ACCOUNT,
  PLACEHOLDER_HOSTED_ZONE_ID,
  type EnvironmentConfig,
} from './types.js';

/**
 * Staging. Structurally identical to production so that a release candidate is
 * exercised against the same topology; it keeps RETAIN and deletion protection
 * because a staging account still holds beta testers' real location history,
 * and losing it would be a privacy incident, not an inconvenience.
 */
export function stagingConfig(): EnvironmentConfig {
  const owner = envString('GITHUB_OWNER', 'iamrishabruh');
  const repository = envString('GITHUB_REPOSITORY_NAME', APP_NAME);
  // Used to build the immutable form of the OIDC subject claim.
  const ownerId = envString('GITHUB_OWNER_ID', '146401886');
  const repositoryId = envString('GITHUB_REPOSITORY_ID', '1323456535');
  const domain = envString('KINMAP_DOMAIN_STAGING', 'staging.kinmap.app');

  return {
    envName: 'staging',
    account: envString('AWS_STAGING_ACCOUNT_ID', PLACEHOLDER_ACCOUNT),
    region: envString('AWS_REGION', envString('CDK_DEFAULT_REGION', DEFAULT_REGION)),
    domain,
    apiDomain: envString('KINMAP_API_DOMAIN_STAGING', `api.${domain}`),
    // Deliberately NOT the deployed value. The real label is set per
    // environment in the untracked .env.local, because publishing it would
    // publish the hostname that reaches API Gateway without passing the
    // WebACL. A deploy without the variable creates an obviously-wrong name
    // rather than silently reusing a guessable one.
    apiOriginDomain: envString('KINMAP_API_ORIGIN_DOMAIN_STAGING', `origin-unset.${domain}`),
    alarmEmail: envString('KINMAP_ALARM_EMAIL', `alerts@${domain}`),
    removalPolicy: RemovalPolicy.RETAIN,
    isProduction: false,

    reserveLambdaConcurrency:
      envString('KINMAP_RESERVE_LAMBDA_CONCURRENCY_STAGING', 'false') === 'true',
    cdkQualifier: envString(
      'KINMAP_CDK_QUALIFIER_STAGING',
      envString('KINMAP_CDK_QUALIFIER', 'hnb659fds'),
    ),
    resourcePrefix: `${APP_NAME}-staging`,
    parameterPrefix: `/${APP_NAME}/staging`,
    owner: envString('KINMAP_OWNER_TAG', 'platform'),
    costCentre: envString('KINMAP_COST_CENTRE_TAG', 'engineering'),

    webDomain: envString('KINMAP_WEB_DOMAIN_STAGING', `app.${domain}`),
    hostedZoneId: envString('KINMAP_HOSTED_ZONE_ID_STAGING', PLACEHOLDER_HOSTED_ZONE_ID),
    edgeRegion: EDGE_REGION,

    deletionProtection: true,
    logRetention: RetentionDays.ONE_MONTH,
    auditLogRetention: RetentionDays.SIX_MONTHS,
    historyRetentionDays: LIMITS.HISTORY_RETENTION_DAYS,

    monthlyBudgetUsd: envNumber('KINMAP_MONTHLY_BUDGET_USD_STAGING', 150),
    costAnomalyThresholdUsd: envNumber('KINMAP_COST_ANOMALY_USD_STAGING', 50),

    lambdaMemoryMb: 768,
    lambdaTimeoutSeconds: 15,
    enableDetailedTracing: true,

    alarmThresholds: {
      lambdaErrors: 5,
      lambdaThrottles: 1,
      tableThrottles: 10,
      tableSystemErrors: 3,
      deadLetterQueueDepth: 0,
      apiServerErrors: 10,
      apiLatencyP99Millis: 2_000,
    },

    github: {
      owner,
      repository,
      deploySubjectClaims: envList(
        'KINMAP_GITHUB_DEPLOY_SUBJECTS_STAGING',
        githubSubjectClaims({
          owner,
          ownerId,
          repository,
          repositoryId,
          triggers: ['ref:refs/heads/staging', 'environment:staging'],
        }),
      ),
      diffSubjectClaims: envList(
        'KINMAP_GITHUB_DIFF_SUBJECTS_STAGING',
        githubSubjectClaims({
          owner,
          ownerId,
          repository,
          repositoryId,
          triggers: ['pull_request', 'ref:refs/heads/staging'],
        }),
      ),
      existingOidcProviderArn: envOptional('KINMAP_GITHUB_OIDC_PROVIDER_ARN'),
    },
  };
}
