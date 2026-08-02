/**
 * Identity stack — the Cognito user pool that authenticates every human in the
 * product, plus the single `services/auth-events` Lambda behind all four
 * user-pool triggers.
 *
 * Two rules shape this file:
 *
 *  1. **No authorization decision is ever carried in a token.** The pool
 *     declares no custom attributes and the app client can read and write only
 *     `email` and `name`. Family membership, role and sharing status are read
 *     from DynamoDB on every sensitive request (spec §18/§34), because a JWT is
 *     a cached snapshot and a removed family member has to lose access
 *     immediately — not whenever their access token happens to expire.
 *  2. **The stack deploys before any store credentials exist.** Sign in with
 *     Apple and Google are created only when the corresponding Secrets Manager
 *     ARN is supplied. Until then the pool is email-only, and both synth and
 *     deploy still succeed.
 *
 * Nothing here performs a context lookup, so `cdk synth` works on a fork pull
 * request with no credentials and the placeholder account id.
 */
import { CfnOutput, Duration, SecretValue, Stack } from 'aws-cdk-lib';
import {
  AccountRecovery,
  type CfnUserPool,
  type CfnUserPoolClient,
  CfnUserPoolIdentityProvider,
  ClientAttributes,
  FeaturePlan,
  Mfa,
  OAuthScope,
  UserPool,
  UserPoolClientIdentityProvider,
  VerificationEmailStyle,
  type UserPoolClient,
  type UserPoolDomain,
} from 'aws-cdk-lib/aws-cognito';
import { type IFunction } from 'aws-cdk-lib/aws-lambda';
import { type Construct } from 'constructs';

import { applyStandardTags, cdkEnvironment } from '../config/index.js';
import { type DataConsumerStackProps } from '../config/types.js';
import { NodeService } from '../constructs/node-service.js';

/** Deep-link scheme the mobile app registers for the hosted-UI redirect. */
const APP_URL_SCHEME = 'kinmap';

/**
 * Cognito identifies providers by fixed names; the app client's
 * `supportedIdentityProviders` must reference exactly these.
 */
const GOOGLE_PROVIDER_NAME = 'Google';
const APPLE_PROVIDER_NAME = 'SignInWithApple';

/** JSON fields expected inside the Google OAuth secret. */
const GOOGLE_SECRET_FIELDS = { clientId: 'clientId', clientSecret: 'clientSecret' } as const;

/** JSON fields expected inside the Sign in with Apple secret. */
const APPLE_SECRET_FIELDS = {
  /** The Services ID, not the app's bundle identifier. */
  clientId: 'clientId',
  teamId: 'teamId',
  keyId: 'keyId',
  /** PEM body of the .p8 signing key. */
  privateKey: 'privateKey',
} as const;

/**
 * Federated sign-in credentials. Every field is optional: a provider whose
 * secret is absent is simply not created, which is what lets this stack be
 * deployed months before the App Store and Play Console accounts exist.
 */
export interface FederatedIdentitySecrets {
  /** Secrets Manager ARN holding {@link APPLE_SECRET_FIELDS}. */
  readonly appleSecretArn?: string;
  /** Secrets Manager ARN holding {@link GOOGLE_SECRET_FIELDS}. */
  readonly googleSecretArn?: string;
}

export interface IdentityStackProps extends DataConsumerStackProps {
  /**
   * Sourced from the environment configuration by bin/app.ts. Passed as a prop
   * rather than read off `EnvironmentConfig` directly so that adding a third
   * provider later does not change every stack's signature — the same
   * convention BillingStack and NotificationStack use for their secrets.
   */
  readonly federatedIdentitySecrets?: FederatedIdentitySecrets;
}

export class IdentityStack extends Stack {
  public readonly userPool: UserPool;
  public readonly userPoolClient: UserPoolClient;
  public readonly userPoolDomain: UserPoolDomain;
  public readonly authEventsFunction: IFunction;
  /** Providers this environment actually offers, for the client bootstrap. */
  public readonly enabledIdentityProviders: string[];

  public constructor(scope: Construct, id: string, props: IdentityStackProps) {
    super(scope, id, {
      ...props,
      env: props.env ?? cdkEnvironment(props.config),
      terminationProtection: props.terminationProtection ?? props.config.isProduction,
      description:
        props.description ?? 'KinMap identity: Cognito user pool, hosted UI and auth triggers.',
    });

    const { config, foundation, tables } = props;
    const secrets: FederatedIdentitySecrets = props.federatedIdentitySecrets ?? {};

    applyStandardTags(this, config);

    // -----------------------------------------------------------------------
    // Trigger Lambda
    //
    // One function serves all four triggers; `handler.ts` dispatches on
    // `event.triggerSource`. It touches the profile table and nothing else —
    // no location table, no coordinate key — so a bug in a sign-up trigger
    // cannot reach anybody's position.
    // -----------------------------------------------------------------------
    const authEvents = new NodeService(this, 'AuthEventsService', {
      config,
      serviceName: 'auth-events',
      description:
        'Cognito triggers: pre sign-up, post confirmation, token generation, custom messages.',
      memorySize: 512,
      timeout: Duration.seconds(10),
      alarmTopic: foundation.alarmTopic,
      environment: {
        APP_DOMAIN: config.domain,
        USERS_TABLE: tables.users.tableName,
      },
    });
    this.authEventsFunction = authEvents.function;

    // Post-confirmation creates the profile row; nothing in these triggers
    // reads another user's record, so read access is not granted either.
    tables.users.grantWriteData(this.authEventsFunction);

    // -----------------------------------------------------------------------
    // User pool
    // -----------------------------------------------------------------------
    this.userPool = new UserPool(this, 'UserPool', {
      userPoolName: config.resourcePrefix,
      selfSignUpEnabled: true,
      signInAliases: { email: true, username: false, phone: false },
      signInCaseSensitive: false,
      autoVerify: { email: true },
      // Keeping the previous address until the new one is verified means an
      // attacker who reaches a logged-in session cannot silently move the
      // recovery channel — and therefore the account — to themselves.
      keepOriginal: { email: true },
      standardAttributes: {
        email: { required: true, mutable: true },
        fullname: { required: false, mutable: true },
      },
      // Deliberately empty. A family authorization decision must never be
      // expressible as a token claim; see the file header.
      customAttributes: {},
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
        tempPasswordValidity: Duration.days(1),
      },
      mfa: Mfa.OPTIONAL,
      // TOTP only. SMS recovery is a SIM-swap route into somebody's location
      // history, which is exactly this product's threat model.
      mfaSecondFactor: { sms: false, otp: true },
      accountRecovery: AccountRecovery.EMAIL_ONLY,
      userVerification: {
        emailSubject: 'Your KinMap verification code',
        emailBody: 'Your KinMap verification code is {####}. It expires shortly.',
        emailStyle: VerificationEmailStyle.CODE,
      },
      deviceTracking: {
        challengeRequiredOnNewDevice: true,
        deviceOnlyRememberedOnUserPrompt: true,
      },
      // PLUS is the tier that carries threat protection — compromised-credential
      // detection and adaptive authentication. The enforcement mode itself is
      // set through the escape hatch below.
      featurePlan: FeaturePlan.PLUS,
      lambdaTriggers: {
        preSignUp: this.authEventsFunction,
        postConfirmation: this.authEventsFunction,
        preTokenGeneration: this.authEventsFunction,
        customMessage: this.authEventsFunction,
      },
      deletionProtection: config.deletionProtection,
      removalPolicy: config.removalPolicy,
    });

    const cfnUserPool = this.userPool.node.defaultChild as CfnUserPool;
    // Advanced security: block in production, observe elsewhere so a developer
    // signing in over a VPN is not locked out of a test environment.
    cfnUserPool.addPropertyOverride('UserPoolAddOns', {
      AdvancedSecurityMode: config.isProduction ? 'ENFORCED' : 'AUDIT',
    });

    // -----------------------------------------------------------------------
    // Federated providers — created only when their credentials exist
    // -----------------------------------------------------------------------
    const supportedProviders = [UserPoolClientIdentityProvider.COGNITO];
    const providerResources: CfnUserPoolIdentityProvider[] = [];

    if (isPresent(secrets.googleSecretArn)) {
      providerResources.push(
        new CfnUserPoolIdentityProvider(this, 'GoogleIdentityProvider', {
          userPoolId: this.userPool.userPoolId,
          providerName: GOOGLE_PROVIDER_NAME,
          providerType: GOOGLE_PROVIDER_NAME,
          // `sub` is the stable Google account id; an email address is not.
          attributeMapping: { username: 'sub', email: 'email', name: 'name' },
          providerDetails: {
            client_id: secretField(secrets.googleSecretArn, GOOGLE_SECRET_FIELDS.clientId),
            client_secret: secretField(secrets.googleSecretArn, GOOGLE_SECRET_FIELDS.clientSecret),
            authorize_scopes: 'openid email profile',
          },
        }),
      );
      supportedProviders.push(UserPoolClientIdentityProvider.GOOGLE);
    }

    if (isPresent(secrets.appleSecretArn)) {
      providerResources.push(
        new CfnUserPoolIdentityProvider(this, 'AppleIdentityProvider', {
          userPoolId: this.userPool.userPoolId,
          providerName: APPLE_PROVIDER_NAME,
          providerType: APPLE_PROVIDER_NAME,
          // Apple returns a name only on the very first authorisation, so
          // nothing downstream may depend on it being present.
          attributeMapping: { username: 'sub', email: 'email' },
          providerDetails: {
            client_id: secretField(secrets.appleSecretArn, APPLE_SECRET_FIELDS.clientId),
            team_id: secretField(secrets.appleSecretArn, APPLE_SECRET_FIELDS.teamId),
            key_id: secretField(secrets.appleSecretArn, APPLE_SECRET_FIELDS.keyId),
            private_key: secretField(secrets.appleSecretArn, APPLE_SECRET_FIELDS.privateKey),
            authorize_scopes: 'email name',
          },
        }),
      );
      supportedProviders.push(UserPoolClientIdentityProvider.APPLE);
    }

    this.enabledIdentityProviders = supportedProviders.map((provider) => provider.name);

    // -----------------------------------------------------------------------
    // Hosted UI and the per-environment app client
    // -----------------------------------------------------------------------
    // The account id makes the prefix globally unique without a context lookup;
    // with the placeholder account it still synthesises deterministically.
    this.userPoolDomain = this.userPool.addDomain('HostedUiDomain', {
      cognitoDomain: { domainPrefix: `${config.resourcePrefix}-${config.account}` },
    });

    const callbackUrls = [
      `${APP_URL_SCHEME}://auth/callback`,
      `https://${config.webDomain}/auth/callback`,
    ];
    const logoutUrls = [
      `${APP_URL_SCHEME}://auth/signout`,
      `https://${config.webDomain}/auth/signout`,
    ];
    if (!config.isProduction) {
      // Expo dev-client redirect. Never present in production.
      callbackUrls.push('http://localhost:8081/auth/callback');
      logoutUrls.push('http://localhost:8081/auth/signout');
    }

    this.userPoolClient = this.userPool.addClient('MobileClient', {
      userPoolClientName: `${config.resourcePrefix}-mobile`,
      // A mobile binary cannot keep a secret, so this is a public client and
      // PKCE is the protection instead.
      generateSecret: false,
      authFlows: { userSrp: true },
      oAuth: {
        flows: { authorizationCodeGrant: true, implicitCodeGrant: false, clientCredentials: false },
        scopes: [OAuthScope.OPENID, OAuthScope.EMAIL, OAuthScope.PROFILE],
        callbackUrls,
        logoutUrls,
      },
      supportedIdentityProviders: supportedProviders,
      // Short access tokens keep the window in which a just-removed member
      // still holds a valid token small. The API re-checks membership on every
      // request regardless, so this is defence in depth rather than the control.
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(30),
      authSessionValidity: Duration.minutes(3),
      enableTokenRevocation: true,
      // Sign-in failures are indistinguishable, so the pool cannot be used to
      // discover which email addresses have accounts — the same reasoning as
      // the opaque FORBIDDEN the API returns.
      preventUserExistenceErrors: true,
      // enablePropagateAdditionalUserContextData is deliberately NOT set.
      // Cognito only accepts it on a client that has a secret, and a mobile
      // binary cannot hold one — this client is public and relies on PKCE.
      // The server-side API forwards client IP to threat protection instead.
      readAttributes: new ClientAttributes().withStandardAttributes({
        email: true,
        emailVerified: true,
        fullname: true,
      }),
      writeAttributes: new ClientAttributes().withStandardAttributes({
        email: true,
        fullname: true,
      }),
    });

    // A client may only reference providers that already exist.
    for (const provider of providerResources) {
      this.userPoolClient.node.addDependency(provider);
    }

    const cfnUserPoolClient = this.userPoolClient.node.defaultChild as CfnUserPoolClient;
    // Refresh-token rotation: every refresh returns a new token and retires the
    // one that was used, so a stolen refresh token is good for a single call.
    // The grace period covers a client that lost the response to a refresh it
    // had already made.
    cfnUserPoolClient.addPropertyOverride('RefreshTokenRotation', {
      Feature: 'ENABLED',
      RetryGracePeriodSeconds: 60,
    });

    // -----------------------------------------------------------------------
    // Outputs — identifiers only. No secret, and nothing user-specific.
    // -----------------------------------------------------------------------
    new CfnOutput(this, 'UserPoolId', {
      value: this.userPool.userPoolId,
      description: 'Cognito user pool id',
      exportName: `${config.resourcePrefix}-user-pool-id`,
    });
    new CfnOutput(this, 'UserPoolArn', {
      value: this.userPool.userPoolArn,
      description: 'Cognito user pool ARN',
      exportName: `${config.resourcePrefix}-user-pool-arn`,
    });
    new CfnOutput(this, 'UserPoolClientId', {
      value: this.userPoolClient.userPoolClientId,
      description: 'Cognito app client id used by the mobile app',
      exportName: `${config.resourcePrefix}-user-pool-client-id`,
    });
    new CfnOutput(this, 'HostedUiUrl', {
      value: this.userPoolDomain.baseUrl(),
      description: 'Hosted UI base URL',
    });
    new CfnOutput(this, 'EnabledIdentityProviders', {
      value: this.enabledIdentityProviders.join(','),
      description: 'Identity providers configured in this environment',
    });
  }
}

/** True when an optional configuration string was actually supplied. */
function isPresent(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}

/**
 * Renders a CloudFormation dynamic reference to one JSON field of a secret.
 *
 * `unsafeUnwrap` is the documented way to place a `SecretValue` into an L1
 * string property: no secret is read by the CDK process or written into
 * `cdk.out`, only the `{{resolve:secretsmanager:...}}` token, which
 * CloudFormation resolves during the deployment itself.
 */
function secretField(secretArn: string, jsonField: string): string {
  return SecretValue.secretsManager(secretArn, { jsonField }).unsafeUnwrap();
}
