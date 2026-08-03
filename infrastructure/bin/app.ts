import { App, Tags, type Stack } from 'aws-cdk-lib';

import {
  applyStandardTags,
  cdkEnvironment,
  envList,
  resolveEnvironment,
  stackName,
} from '../config/index.js';
import { ApiStack } from '../stacks/api-stack.js';
import { BillingStack } from '../stacks/billing-stack.js';
import { DataStack } from '../stacks/data-stack.js';
import { FamilyStack } from '../stacks/family-stack.js';
import { FoundationStack } from '../stacks/foundation-stack.js';
import { IdentityStack } from '../stacks/identity-stack.js';
import { LocationStack } from '../stacks/location-stack.js';
import { MailStack } from '../stacks/mail-stack.js';
import { MaintenanceStack } from '../stacks/maintenance-stack.js';
import { MigrationStack } from '../stacks/migration-stack.js';
import { NotificationStack } from '../stacks/notification-stack.js';
import { ObservabilityStack } from '../stacks/observability-stack.js';
import { PrivacyStack } from '../stacks/privacy-stack.js';
import { SecurityStack } from '../stacks/security-stack.js';
import { WebStack } from '../stacks/web-stack.js';

/**
 * Kinmap CDK application.
 *
 * The wiring contract every stack here follows:
 *
 *   - it takes `config: EnvironmentConfig` and never reads `process.env`
 *     itself, so one resolved configuration describes the whole deployment;
 *   - it takes `foundation: FoundationResources` if it needs DNS, a
 *     certificate, an encryption key, a bucket or the alarm topic;
 *   - it takes `tables: DataTables` if it touches persistent state;
 *   - it is given an explicit `env`, so no stack falls back to the ambient CLI
 *     account, and it performs no context lookup. That is what lets
 *     `pnpm cdk:synth` run on a fork pull request with no AWS credentials and
 *     placeholder account ids.
 *
 * Dependencies are declared with `addDependency` even where a cross-stack
 * reference already implies them, so `cdk deploy --all` has one deterministic
 * order and a reviewer can read the deployment sequence off this file.
 */
const app = new App();

const config = resolveEnvironment();
const env = cdkEnvironment(config);

/**
 * Props for the stacks that forward `props` straight to `super` and therefore
 * need `env` supplied here — without it CloudFormation would fall back to the
 * ambient CLI account, which a credential-free synth does not have.
 */
const base = {
  config,
  env,
  terminationProtection: config.isProduction,
};

// Applied at app scope so every resource in every stack inherits them.
Tags.of(app).add('app', 'kinmap');
Tags.of(app).add('env', config.envName);
Tags.of(app).add('owner', config.owner);
Tags.of(app).add('cost-centre', config.costCentre);

// -- Layer 1: account foundations -----------------------------------------

const foundation = new FoundationStack(app, stackName(config, 'foundation'), { config, env });

// Account-level guardrails: backup vault, WAF managed rules, secret rotation.
// It sits directly on the foundation and above every application stack, so a
// broken application stack can never leave the account without its detective
// controls.
const security = new SecurityStack(app, stackName(config, 'security'), {
  ...base,
  foundation,
});

// -- Layer 2: persistence --------------------------------------------------

const data = new DataStack(app, stackName(config, 'data'), {
  config,
  env,
  encryptionKey: foundation.coordinateKey,
  alarmTopic: foundation.alarmTopic,
});
data.addDependency(foundation);

const tables = data.tables;

// -- Layer 3: domain services ---------------------------------------------

const identity = new IdentityStack(app, stackName(config, 'identity'), {
  config,
  env,
  foundation,
  tables,
});
identity.addDependency(data);

// Owns the notification command queue that the location and billing workers
// enqueue into, so it is created before either of them.
const notification = new NotificationStack(app, stackName(config, 'notification'), {
  config,
  env,
  foundation,
  tables,
});
notification.addDependency(data);

const location = new LocationStack(app, stackName(config, 'location'), {
  config,
  env,
  foundation,
  tables,
  notificationCommandsQueue: notification.notificationCommandsQueue,
});
location.addDependency(notification);

const billing = new BillingStack(app, stackName(config, 'billing'), {
  config,
  env,
  foundation,
  tables,
  notificationCommandsQueue: notification.notificationCommandsQueue,
});
billing.addDependency(notification);

// Families, memberships and invitations. Their routes are integrated by the
// API stack below, so this is created first.
const family = new FamilyStack(app, stackName(config, 'family'), {
  config,
  env,
  foundation,
  tables,
  userPoolId: identity.userPool.userPoolId,
  userPoolClientId: identity.userPoolClient.userPoolClientId,
});
family.addDependency(identity);

// Erasure and the audit trail.
const privacy = new PrivacyStack(app, stackName(config, 'privacy'), {
  config,
  env,
  foundation,
  tables,
  userPoolId: identity.userPool.userPoolId,
  userPoolArn: identity.userPool.userPoolArn,
});
privacy.addDependency(identity);

// Scheduled jobs. Last of the workers, because it dispatches onto the deletion
// queue and reads the depth of the queues the others own.
const maintenance = new MaintenanceStack(app, stackName(config, 'maintenance'), {
  config,
  env,
  foundation,
  tables,
  deletionQueue: privacy.deletionQueue,
  monitoredQueues: [
    notification.notificationCommandsQueue,
    location.geofenceEvaluationQueue,
    billing.subscriptionEventsQueue,
  ],
});
maintenance.addDependency(privacy);
maintenance.addDependency(location);
maintenance.addDependency(billing);

// -- Layer 4: public surfaces ---------------------------------------------

const api = new ApiStack(app, stackName(config, 'api'), {
  config,
  env,
  foundation,
  tables,
  userPool: identity.userPool,
  userPoolClient: identity.userPoolClient,
  familyServiceFunction: family.familyServiceFunction,
  invitationServiceFunction: family.invitationServiceFunction,
  locationIngestionFunction: location.ingestionFunction,
  locationQueryFunction: location.queryFunction,
  revenueCatWebhookFunction: billing.revenueCatWebhookFunction,
  appleWebhookFunction: billing.appleWebhookFunction,
  googleWebhookFunction: billing.googleWebhookFunction,
});
api.addDependency(identity);
api.addDependency(location);
api.addDependency(billing);
api.addDependency(security);

// Reuses the foundation's us-east-1 certificate rather than issuing a second
// one for the same names.
// WebStack reads foundation.cloudFrontCertificate directly, so the certificate
// does not need to be threaded through props as well.
const web = new WebStack(app, stackName(config, 'web'), {
  ...base,
  foundation,
});
web.addDependency(foundation);

// Inbound mail for the addresses published on the App Store listing and in the
// privacy policy. App Review writes to the support address, so this is part of
// the public surface rather than an operational nicety.
//
// MailStack overrides the region in `env`: an SES receipt rule, the bucket it
// spools into and the function it invokes must all live in a region where SES
// can receive, which need not be this deployment's primary region.
const mail = new MailStack(app, stackName(config, 'mail'), {
  config,
  env,
  foundation,
  hostedZone: foundation.hostedZone,
  // Where a person actually reads it. Deployment configuration, not a secret,
  // and not something a stack is allowed to read for itself — the default is
  // deliberately an address on our own domain so an unset variable produces a
  // synth warning rather than mail that quietly goes nowhere.
  forwardTo: envList('KINMAP_MAIL_FORWARD_TO', [config.alarmEmail]),
});
mail.addDependency(foundation);

// -- Layer 5: operations ---------------------------------------------------

const migration = new MigrationStack(app, stackName(config, 'migration'), {
  ...base,
  foundation,
  tables,
  // Applying a migration is an explicit operator act, never a deploy side
  // effect: the scheduled runner plans, and a human runs `migration:apply`.
  dryRun: true,
});
migration.addDependency(data);

const observability = new ObservabilityStack(app, stackName(config, 'observability'), {
  config,
  env,
  foundation,
  tables,
  apiId: api.httpApi.apiId,
  healthCheckPath: '/v1/health',
});
observability.addDependency(api);
observability.addDependency(location);

// -- Tagging ---------------------------------------------------------------

const stacks: Stack[] = [
  foundation,
  security,
  data,
  identity,
  notification,
  location,
  billing,
  api,
  web,
  mail,
  migration,
  observability,
];

for (const stack of stacks) {
  applyStandardTags(stack, config);
}

app.synth();
