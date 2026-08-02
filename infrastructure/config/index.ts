import { Tags, type Environment } from 'aws-cdk-lib';
import type { IConstruct } from 'constructs';

import { AppEnvSchema, type AppEnv } from '@family/contracts';

import { developmentConfig } from './development.js';
import { productionConfig } from './production.js';
import { stagingConfig } from './staging.js';
import { APP_NAME, type EnvironmentConfig } from './types.js';

export * from './types.js';
export { developmentConfig } from './development.js';
export { productionConfig } from './production.js';
export { stagingConfig } from './staging.js';

/** The environment names this application knows how to deploy. */
export const APP_ENVIRONMENTS: readonly AppEnv[] = AppEnvSchema.options;

/**
 * Resolves the target environment name.
 *
 * `CDK_ENVIRONMENT` is the canonical variable (every workflow in `.github/`
 * sets it); `APP_ENV` is accepted as an alias so a developer can use one export
 * for both the app and the infrastructure. An unknown value is a hard failure —
 * silently defaulting to `development` while the operator believes they are
 * looking at production is the worst possible outcome.
 */
export function resolveEnvironmentName(candidate?: string): AppEnv {
  const raw = (candidate ?? process.env.CDK_ENVIRONMENT ?? process.env.APP_ENV ?? 'development')
    .trim()
    .toLowerCase();

  const match = APP_ENVIRONMENTS.find((name) => name === raw);
  if (match === undefined) {
    throw new Error(
      `Unknown CDK environment "${raw}". Expected one of: ${APP_ENVIRONMENTS.join(', ')}.`,
    );
  }
  return match;
}

/** Builds the fully-resolved configuration for one environment. */
export function resolveEnvironment(candidate?: string): EnvironmentConfig {
  const envName = resolveEnvironmentName(candidate);

  // Explicit comparisons rather than a lookup table: `noUncheckedIndexedAccess`
  // would make a `Record` lookup possibly-undefined, and the trailing throw
  // means a new environment added to the contract fails loudly here instead of
  // silently resolving to whatever the last branch happened to be.
  if (envName === 'development') {
    return developmentConfig();
  }
  if (envName === 'staging') {
    return stagingConfig();
  }
  if (envName === 'production') {
    return productionConfig();
  }
  throw new Error(`No CDK configuration is defined for environment "${String(envName)}".`);
}

/**
 * The CloudFormation environment for a stack. Account and region are always
 * explicit so that a stack is environment-agnostic only by deliberate choice,
 * never by accident — and so synth never needs credentials to discover them.
 */
export function cdkEnvironment(config: EnvironmentConfig): Environment {
  return { account: config.account, region: config.region };
}

/** `kinmap-<env>-<suffix>`; used as both the construct id and the stack name. */
export function stackName(config: EnvironmentConfig, suffix: string): string {
  return `${APP_NAME}-${config.envName}-${suffix}`;
}

/**
 * The four tags every stack in this application must carry. Applied at the
 * stack level so that every resource inside inherits them, which is what the
 * cost allocation reports and the ownership audit both key off.
 */
export function applyStandardTags(scope: IConstruct, config: EnvironmentConfig): void {
  const tags = Tags.of(scope);
  tags.add('app', APP_NAME);
  tags.add('env', config.envName);
  tags.add('owner', config.owner);
  tags.add('cost-centre', config.costCentre);
}

/**
 * True when the resolved account is the credential-free placeholder, i.e. this
 * is a synth-only run such as a fork pull request. Stacks may use it to skip
 * assertions that only make sense against a real account; they must NOT use it
 * to weaken any security control, because the synthesised template is the same
 * one a real deploy would use.
 */
export function isPlaceholderAccount(config: EnvironmentConfig): boolean {
  return /^0+$/.test(config.account);
}
