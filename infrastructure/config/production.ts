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
 * Production. Every stateful resource is RETAIN plus deletion protection: a
 * mistaken `cdk destroy` must not be able to delete a family's location history
 * or the audit trail that proves who read it. Deploys are gated on the
 * `production` GitHub environment and originate only from `main`.
 */
export function productionConfig(): EnvironmentConfig {
  const owner = envString('GITHUB_OWNER', 'iamrishabruh');
  const repository = envString('GITHUB_REPOSITORY_NAME', APP_NAME);
  // Used to build the immutable form of the OIDC subject claim.
  const ownerId = envString('GITHUB_OWNER_ID', '146401886');
  const repositoryId = envString('GITHUB_REPOSITORY_ID', '1323456535');
  const domain = envString('KINMAP_DOMAIN_PRODUCTION', 'kinmap.app');

  return {
    envName: 'production',
    account: envString('AWS_PROD_ACCOUNT_ID', PLACEHOLDER_ACCOUNT),
    region: envString('AWS_REGION', envString('CDK_DEFAULT_REGION', DEFAULT_REGION)),
    domain,
    apiDomain: envString('KINMAP_API_DOMAIN_PRODUCTION', `api.${domain}`),
    // Deliberately NOT the deployed value. The real label is set per
    // environment in the untracked .env.local, because publishing it would
    // publish the hostname that reaches API Gateway without passing the
    // WebACL. A deploy without the variable creates an obviously-wrong name
    // rather than silently reusing a guessable one.
    apiOriginDomain: envString('KINMAP_API_ORIGIN_DOMAIN_PRODUCTION', `origin-unset.${domain}`),
    alarmEmail: envString('KINMAP_ALARM_EMAIL', `alerts@${domain}`),
    removalPolicy: RemovalPolicy.RETAIN,
    isProduction: true,

    reserveLambdaConcurrency:
      envString('KINMAP_RESERVE_LAMBDA_CONCURRENCY_PRODUCTION', 'false') === 'true',
    cdkQualifier: envString(
      'KINMAP_CDK_QUALIFIER_PRODUCTION',
      envString('KINMAP_CDK_QUALIFIER', 'kinmap'),
    ),
    resourcePrefix: `${APP_NAME}-production`,
    parameterPrefix: `/${APP_NAME}/production`,
    owner: envString('KINMAP_OWNER_TAG', 'platform'),
    costCentre: envString('KINMAP_COST_CENTRE_TAG', 'product'),

    webDomain: envString('KINMAP_WEB_DOMAIN_PRODUCTION', `www.${domain}`),
    hostedZoneId: envString('KINMAP_HOSTED_ZONE_ID_PRODUCTION', PLACEHOLDER_HOSTED_ZONE_ID),
    edgeRegion: EDGE_REGION,

    deletionProtection: true,
    logRetention: RetentionDays.SIX_MONTHS,
    auditLogRetention: RetentionDays.TWO_YEARS,
    historyRetentionDays: LIMITS.HISTORY_RETENTION_DAYS,

    monthlyBudgetUsd: envNumber('KINMAP_MONTHLY_BUDGET_USD_PRODUCTION', 1_000),
    costAnomalyThresholdUsd: envNumber('KINMAP_COST_ANOMALY_USD_PRODUCTION', 200),

    lambdaMemoryMb: 1_024,
    lambdaTimeoutSeconds: 15,
    enableDetailedTracing: false,

    alarmThresholds: {
      lambdaErrors: 3,
      lambdaThrottles: 1,
      tableThrottles: 5,
      tableSystemErrors: 1,
      deadLetterQueueDepth: 0,
      apiServerErrors: 5,
      apiLatencyP99Millis: 1_500,
    },

    github: {
      owner,
      repository,
      deploySubjectClaims: envList(
        'KINMAP_GITHUB_DEPLOY_SUBJECTS_PRODUCTION',
        githubSubjectClaims({
          owner,
          ownerId,
          repository,
          repositoryId,
          triggers: ['ref:refs/heads/main', 'environment:production'],
        }),
      ),
      diffSubjectClaims: envList(
        'KINMAP_GITHUB_DIFF_SUBJECTS_PRODUCTION',
        githubSubjectClaims({
          owner,
          ownerId,
          repository,
          repositoryId,
          triggers: ['pull_request', 'ref:refs/heads/main'],
        }),
      ),
      existingOidcProviderArn: envOptional('KINMAP_GITHUB_OIDC_PROVIDER_ARN'),
    },
  };
}
