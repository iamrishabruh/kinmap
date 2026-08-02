import { RemovalPolicy } from 'aws-cdk-lib';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';

import { LIMITS } from '@family/contracts';

import {
  APP_NAME,
  DEFAULT_REGION,
  EDGE_REGION,
  envList,
  envNumber,
  envOptional,
  envString,
  PLACEHOLDER_ACCOUNT,
  PLACEHOLDER_HOSTED_ZONE_ID,
  type EnvironmentConfig,
} from './types.js';

/**
 * Development. Optimised for iteration: everything is destroyable, retention is
 * short, and budgets are small enough that a runaway loop is noticed the same
 * day. It is still a real AWS account holding real (test) location data, so the
 * privacy controls — customer-managed KMS, PITR, audit tables — are identical
 * to production.
 */
export function developmentConfig(): EnvironmentConfig {
  const owner = envString('GITHUB_OWNER', 'iamrishabruh');
  const repository = envString('GITHUB_REPOSITORY_NAME', APP_NAME);
  const domain = envString('KINMAP_DOMAIN_DEVELOPMENT', 'dev.kinmap.app');

  return {
    envName: 'development',
    account: envString('AWS_DEV_ACCOUNT_ID', PLACEHOLDER_ACCOUNT),
    region: envString('AWS_REGION', envString('CDK_DEFAULT_REGION', DEFAULT_REGION)),
    domain,
    apiDomain: envString('KINMAP_API_DOMAIN_DEVELOPMENT', `api.${domain}`),
    alarmEmail: envString('KINMAP_ALARM_EMAIL', 'alerts@kinmap.app'),
    removalPolicy: RemovalPolicy.DESTROY,
    isProduction: false,

    resourcePrefix: `${APP_NAME}-development`,
    parameterPrefix: `/${APP_NAME}/development`,
    owner: envString('KINMAP_OWNER_TAG', 'platform'),
    costCentre: envString('KINMAP_COST_CENTRE_TAG', 'engineering'),

    webDomain: envString('KINMAP_WEB_DOMAIN_DEVELOPMENT', `app.${domain}`),
    hostedZoneId: envString('KINMAP_HOSTED_ZONE_ID_DEVELOPMENT', PLACEHOLDER_HOSTED_ZONE_ID),
    edgeRegion: EDGE_REGION,

    deletionProtection: false,
    logRetention: RetentionDays.ONE_WEEK,
    auditLogRetention: RetentionDays.ONE_MONTH,
    historyRetentionDays: LIMITS.HISTORY_RETENTION_DAYS,

    monthlyBudgetUsd: envNumber('KINMAP_MONTHLY_BUDGET_USD_DEVELOPMENT', 50),
    costAnomalyThresholdUsd: envNumber('KINMAP_COST_ANOMALY_USD_DEVELOPMENT', 20),

    lambdaMemoryMb: 512,
    lambdaTimeoutSeconds: 15,
    enableDetailedTracing: true,

    alarmThresholds: {
      lambdaErrors: 5,
      lambdaThrottles: 1,
      tableThrottles: 10,
      tableSystemErrors: 5,
      deadLetterQueueDepth: 0,
      apiServerErrors: 10,
      apiLatencyP99Millis: 3_000,
    },

    github: {
      owner,
      repository,
      deploySubjectClaims: envList('KINMAP_GITHUB_DEPLOY_SUBJECTS_DEVELOPMENT', [
        `repo:${owner}/${repository}:ref:refs/heads/development`,
        `repo:${owner}/${repository}:environment:development`,
      ]),
      diffSubjectClaims: envList('KINMAP_GITHUB_DIFF_SUBJECTS_DEVELOPMENT', [
        `repo:${owner}/${repository}:pull_request`,
        `repo:${owner}/${repository}:ref:refs/heads/development`,
      ]),
      existingOidcProviderArn: envOptional('KINMAP_GITHUB_OIDC_PROVIDER_ARN'),
    },
  };
}
