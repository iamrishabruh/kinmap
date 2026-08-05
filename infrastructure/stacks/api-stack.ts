/**
 * API stack — the single public entry point into the platform.
 *
 * Every route in the product is declared in one table ({@link API_ROUTES}) so
 * that four properties are reviewable in one place instead of being spread
 * across dozens of `addRoutes` calls:
 *
 *  1. **Which routes are unauthenticated.** Exactly three: the store and
 *     billing webhooks, whose callers cannot present a Cognito JWT and which
 *     therefore authenticate by provider signature inside their handlers.
 *     Everything else is bound to the JWT authorizer. Authentication is only
 *     the outer gate — every sensitive read is still authorised server-side
 *     against family membership and the target's sharing status, and writes an
 *     audit event (spec §18/§34).
 *  2. **Which service owns each route.** Coordinate-handling routes are
 *     integrated directly with the LocationStack functions that hold
 *     `kms:Decrypt`, and webhooks with the BillingStack functions that hold the
 *     provider secrets. The `services/api` function is granted no access to any
 *     coordinate table and none to the coordinate key, so a bug in, say, the
 *     invitations endpoint cannot reach anybody's position.
 *  3. **What each route costs.** Per-route throttles are derived from the
 *     per-principal ceilings in `@family/contracts`, so tightening a limit
 *     there is reflected here instead of drifting.
 *  4. **What is logged.** The access-log format is a fixed allowlist of
 *     `$context` variables. It records `routeKey` — the uninstantiated template
 *     — rather than `path`, so no user, family, place or session id reaches
 *     CloudWatch. The query string and the Authorization header are never
 *     referenced, and no request or response body is ever logged.
 *
 * Nothing here performs a context lookup, so `cdk synth` works on a fork pull
 * request with no credentials and the placeholder account id.
 */
import { CfnOutput, Duration, Stack } from 'aws-cdk-lib';
import {
  type CfnStage,
  CorsHttpMethod,
  DomainName,
  HttpApi,
  HttpMethod,
  HttpNoneAuthorizer,
  HttpStage,
  PayloadFormatVersion,
} from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpUserPoolAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import {
  AllowedMethods,
  CachePolicy,
  Distribution,
  HttpVersion,
  OriginProtocolPolicy,
  OriginRequestPolicy,
  OriginSslPolicy,
  PriceClass,
  SecurityPolicyProtocol,
  ViewerProtocolPolicy,
} from 'aws-cdk-lib/aws-cloudfront';
import { HttpOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { type IUserPool, type IUserPoolClient } from 'aws-cdk-lib/aws-cognito';
import { Effect, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { CfnPermission } from 'aws-cdk-lib/aws-lambda';
import { type IFunction } from 'aws-cdk-lib/aws-lambda';
import { LogGroup } from 'aws-cdk-lib/aws-logs';
import { AaaaRecord, ARecord, RecordTarget } from 'aws-cdk-lib/aws-route53';
import { ApiGatewayv2DomainProperties, CloudFrontTarget } from 'aws-cdk-lib/aws-route53-targets';
import { CfnWebACL } from 'aws-cdk-lib/aws-wafv2';
import { type Construct, type IConstruct } from 'constructs';

import { LIMITS, RATE_LIMITS } from '@family/contracts';

import { applyStandardTags, cdkEnvironment } from '../config/index.js';
import { type DataConsumerStackProps, type EnvironmentConfig } from '../config/types.js';
import { NodeService } from '../constructs/node-service.js';

/**
 * The service that owns a route. A coordinate never passes through the general
 * API function, so those routes are integrated with their owning service
 * directly rather than proxied through it.
 */
type RouteTarget =
  | 'api'
  | 'family-service'
  | 'invitation-service'
  | 'location-ingestion'
  | 'location-query'
  | 'revenuecat-webhook'
  | 'apple-webhook'
  | 'google-webhook';

/**
 * Budget for authenticated reads that carry no location payload: lists of
 * families, devices, places and notifications. Location reads use the far
 * tighter ceilings in `RATE_LIMITS`.
 */
const GENERAL_READ_PER_MINUTE = 60;

/**
 * Webhook callers are third-party services rather than principals, so they are
 * sized by expected provider fan-out and not by a per-user ceiling.
 */
const WEBHOOK_PER_MINUTE = 600;

/**
 * Stage throttles are fleet-wide requests per second, whereas `RATE_LIMITS` is
 * per principal per minute. This multiplier converts between them: it is the
 * number of principals assumed to be hitting one route simultaneously. The
 * stage throttle is a blast-radius control only — the per-principal limit is
 * enforced inside the service, where the caller's identity is known.
 */
const CONCURRENT_PRINCIPALS = { production: 250, nonProduction: 5 } as const;

interface ApiRoute {
  readonly path: string;
  readonly methods: HttpMethod[];
  /** Per-principal ceiling this route is sized from. */
  readonly perPrincipalPerMinute: number;
  /** Defaults to `'api'`. */
  readonly target?: RouteTarget;
  /**
   * Unauthenticated routes. Only the webhooks — each of which verifies its
   * provider's signature before touching the payload — and the liveness probe,
   * which reads nothing and returns a constant.
   */
  readonly unauthenticated?: boolean;
}

/**
 * The v1 surface, mirroring `@family/schemas`.
 *
 * `/v1/auth/*` is deliberately absent: tokens are issued, refreshed and revoked
 * against Cognito directly, so no unauthenticated token endpoint is exposed
 * here. `/v1/configuration/bootstrap` is described in the schemas package as a
 * pre-authentication payload but is still served behind the authorizer; a
 * genuinely anonymous cold-start document belongs on the static web surface
 * instead. The only routes that answer without a token are the provider
 * webhooks and `/v1/health`.
 */
const API_ROUTES: ApiRoute[] = [
  // -- account --------------------------------------------------------------
  {
    path: '/v1/account',
    methods: [HttpMethod.GET],
    perPrincipalPerMinute: GENERAL_READ_PER_MINUTE,
  },
  {
    path: '/v1/account',
    methods: [HttpMethod.PATCH, HttpMethod.DELETE],
    perPrincipalPerMinute: RATE_LIMITS.ACCOUNT_MUTATION_PER_USER,
  },
  {
    // What an irreversible action would actually destroy, shown before it is
    // taken. It counts location rows without being able to read one: the grant
    // below is dynamodb:Query conditioned on Select being COUNT.
    path: '/v1/account/deletion/preview',
    methods: [HttpMethod.GET],
    perPrincipalPerMinute: GENERAL_READ_PER_MINUTE,
  },
  {
    path: '/v1/account/deletion/cancel',
    methods: [HttpMethod.POST],
    perPrincipalPerMinute: RATE_LIMITS.ACCOUNT_MUTATION_PER_USER,
  },

  // -- health ---------------------------------------------------------------
  // Unauthenticated because the CloudWatch Synthetics canary probes it from
  // outside the account and cannot hold a Cognito token. It returns a fixed
  // {"status":"ok"} and reads nothing, so there is no surface behind it.
  {
    path: '/v1/health',
    methods: [HttpMethod.GET],
    perPrincipalPerMinute: GENERAL_READ_PER_MINUTE,
    unauthenticated: true,
  },

  // -- configuration --------------------------------------------------------
  {
    path: '/v1/configuration',
    methods: [HttpMethod.GET],
    perPrincipalPerMinute: GENERAL_READ_PER_MINUTE,
  },
  {
    path: '/v1/configuration/bootstrap',
    methods: [HttpMethod.GET],
    perPrincipalPerMinute: GENERAL_READ_PER_MINUTE,
  },

  // -- devices --------------------------------------------------------------
  {
    path: '/v1/devices',
    methods: [HttpMethod.GET],
    perPrincipalPerMinute: GENERAL_READ_PER_MINUTE,
  },
  {
    path: '/v1/devices',
    methods: [HttpMethod.POST],
    perPrincipalPerMinute: RATE_LIMITS.ACCOUNT_MUTATION_PER_USER,
  },
  {
    path: '/v1/devices/{deviceId}',
    methods: [HttpMethod.PATCH, HttpMethod.DELETE],
    perPrincipalPerMinute: RATE_LIMITS.ACCOUNT_MUTATION_PER_USER,
  },

  // -- families -------------------------------------------------------------
  {
    path: '/v1/families',
    methods: [HttpMethod.GET],
    perPrincipalPerMinute: GENERAL_READ_PER_MINUTE,
    target: 'family-service',
  },
  {
    path: '/v1/families',
    methods: [HttpMethod.POST],
    perPrincipalPerMinute: RATE_LIMITS.ACCOUNT_MUTATION_PER_USER,
    target: 'family-service',
  },
  {
    path: '/v1/families/{familyId}',
    methods: [HttpMethod.GET],
    perPrincipalPerMinute: GENERAL_READ_PER_MINUTE,
    target: 'family-service',
  },
  {
    path: '/v1/families/{familyId}',
    methods: [HttpMethod.PATCH],
    perPrincipalPerMinute: RATE_LIMITS.ACCOUNT_MUTATION_PER_USER,
    target: 'family-service',
  },

  // -- memberships ----------------------------------------------------------
  {
    path: '/v1/families/{familyId}/members',
    methods: [HttpMethod.GET],
    perPrincipalPerMinute: GENERAL_READ_PER_MINUTE,
    target: 'family-service',
  },
  {
    path: '/v1/families/{familyId}/members/{userId}',
    methods: [HttpMethod.GET],
    perPrincipalPerMinute: GENERAL_READ_PER_MINUTE,
    target: 'family-service',
  },
  {
    path: '/v1/families/{familyId}/members/{userId}',
    methods: [HttpMethod.PATCH, HttpMethod.DELETE],
    perPrincipalPerMinute: RATE_LIMITS.ACCOUNT_MUTATION_PER_USER,
    target: 'family-service',
  },
  {
    path: '/v1/families/{familyId}/members/{userId}/transfer-ownership',
    methods: [HttpMethod.POST],
    perPrincipalPerMinute: RATE_LIMITS.ACCOUNT_MUTATION_PER_USER,
    target: 'family-service',
  },

  // -- invitations ----------------------------------------------------------
  {
    path: '/v1/families/{familyId}/invitations',
    methods: [HttpMethod.GET],
    perPrincipalPerMinute: GENERAL_READ_PER_MINUTE,
    target: 'invitation-service',
  },
  {
    path: '/v1/families/{familyId}/invitations',
    methods: [HttpMethod.POST],
    perPrincipalPerMinute: RATE_LIMITS.INVITATION_CREATE_PER_FAMILY,
    target: 'invitation-service',
  },
  {
    path: '/v1/families/{familyId}/invitations/{invitationId}',
    methods: [HttpMethod.DELETE],
    perPrincipalPerMinute: RATE_LIMITS.INVITATION_CREATE_PER_FAMILY,
    target: 'invitation-service',
  },
  {
    // Token guessing is the cheapest way into a family, so the preview and the
    // redemption share the tightest ceiling in the contract.
    path: '/v1/invitations/{token}',
    methods: [HttpMethod.GET],
    perPrincipalPerMinute: RATE_LIMITS.INVITATION_ACCEPT_PER_IP,
    target: 'invitation-service',
  },
  {
    path: '/v1/invitations/{token}/accept',
    methods: [HttpMethod.POST],
    perPrincipalPerMinute: RATE_LIMITS.INVITATION_ACCEPT_PER_IP,
    target: 'invitation-service',
  },

  // -- locations (owned by LocationStack) -----------------------------------
  {
    path: '/v1/locations/batch',
    methods: [HttpMethod.POST],
    perPrincipalPerMinute: RATE_LIMITS.LOCATION_BATCH_PER_DEVICE,
    target: 'location-ingestion',
  },
  {
    path: '/v1/families/{familyId}/locations/current',
    methods: [HttpMethod.GET],
    perPrincipalPerMinute: RATE_LIMITS.CURRENT_LOCATION_PER_USER,
    target: 'location-query',
  },
  {
    path: '/v1/users/{userId}/locations/history',
    methods: [HttpMethod.GET],
    perPrincipalPerMinute: RATE_LIMITS.HISTORY_READ_PER_USER,
    target: 'location-query',
  },

  // -- live sessions --------------------------------------------------------
  {
    path: '/v1/live-sessions',
    methods: [HttpMethod.GET],
    perPrincipalPerMinute: GENERAL_READ_PER_MINUTE,
  },
  {
    path: '/v1/live-sessions',
    methods: [HttpMethod.POST],
    perPrincipalPerMinute: RATE_LIMITS.LIVE_SESSION_CREATE_PER_USER,
  },
  {
    path: '/v1/live-sessions/{sessionId}/accept',
    methods: [HttpMethod.POST],
    perPrincipalPerMinute: RATE_LIMITS.LIVE_SESSION_CREATE_PER_USER,
  },
  {
    path: '/v1/live-sessions/{sessionId}/reject',
    methods: [HttpMethod.POST],
    perPrincipalPerMinute: RATE_LIMITS.LIVE_SESSION_CREATE_PER_USER,
  },
  {
    // Stopping a session is a withdrawal of consent, so it is sized as a
    // general mutation rather than as a session creation.
    path: '/v1/live-sessions/{sessionId}/stop',
    methods: [HttpMethod.POST],
    perPrincipalPerMinute: RATE_LIMITS.ACCOUNT_MUTATION_PER_USER,
  },

  // -- notifications --------------------------------------------------------
  {
    path: '/v1/notifications',
    methods: [HttpMethod.GET],
    perPrincipalPerMinute: GENERAL_READ_PER_MINUTE,
  },
  {
    path: '/v1/notifications/read',
    methods: [HttpMethod.POST],
    perPrincipalPerMinute: RATE_LIMITS.ACCOUNT_MUTATION_PER_USER,
  },
  {
    path: '/v1/notifications/preferences',
    methods: [HttpMethod.GET],
    perPrincipalPerMinute: GENERAL_READ_PER_MINUTE,
  },
  {
    path: '/v1/notifications/preferences',
    methods: [HttpMethod.PATCH],
    perPrincipalPerMinute: RATE_LIMITS.ACCOUNT_MUTATION_PER_USER,
  },

  // -- saved places ---------------------------------------------------------
  {
    path: '/v1/places',
    methods: [HttpMethod.GET],
    perPrincipalPerMinute: GENERAL_READ_PER_MINUTE,
  },
  {
    path: '/v1/places',
    methods: [HttpMethod.POST],
    perPrincipalPerMinute: RATE_LIMITS.ACCOUNT_MUTATION_PER_USER,
  },
  {
    path: '/v1/places/{placeId}',
    methods: [HttpMethod.PATCH, HttpMethod.DELETE],
    perPrincipalPerMinute: RATE_LIMITS.ACCOUNT_MUTATION_PER_USER,
  },

  // -- privacy --------------------------------------------------------------
  {
    path: '/v1/privacy/sharing',
    methods: [HttpMethod.GET],
    perPrincipalPerMinute: GENERAL_READ_PER_MINUTE,
  },
  {
    // Pausing must always get through: a throttle may never be the reason
    // somebody's sharing stays switched on.
    path: '/v1/privacy/sharing',
    methods: [HttpMethod.PATCH],
    perPrincipalPerMinute: RATE_LIMITS.ACCOUNT_MUTATION_PER_USER,
  },
  {
    path: '/v1/privacy/history',
    methods: [HttpMethod.DELETE],
    perPrincipalPerMinute: RATE_LIMITS.ACCOUNT_MUTATION_PER_USER,
  },
  {
    path: '/v1/privacy/audit',
    methods: [HttpMethod.GET],
    perPrincipalPerMinute: RATE_LIMITS.HISTORY_READ_PER_USER,
  },
  {
    // Asking for a copy of your own data, and collecting the state of that
    // request. The archive itself never travels this way: it is built by a
    // worker that holds the location grants this function deliberately does not,
    // and delivered as a short-lived signed link.
    path: '/v1/privacy/exports',
    methods: [HttpMethod.GET, HttpMethod.POST],
    perPrincipalPerMinute: RATE_LIMITS.HISTORY_READ_PER_USER,
  },
  {
    path: '/v1/privacy/exports/{exportId}',
    methods: [HttpMethod.GET],
    perPrincipalPerMinute: RATE_LIMITS.HISTORY_READ_PER_USER,
  },
  {
    // Read-only, and deliberately so: nothing in the platform honours a
    // per-user retention preference, so an endpoint that accepted one would
    // report a promise it does not keep.
    path: '/v1/privacy/retention',
    methods: [HttpMethod.GET],
    perPrincipalPerMinute: GENERAL_READ_PER_MINUTE,
  },
  {
    path: '/v1/privacy/export',
    methods: [HttpMethod.POST],
    perPrincipalPerMinute: RATE_LIMITS.HISTORY_READ_PER_USER,
  },

  // -- subscriptions --------------------------------------------------------
  {
    path: '/v1/subscriptions/entitlements',
    methods: [HttpMethod.GET],
    perPrincipalPerMinute: GENERAL_READ_PER_MINUTE,
  },
  {
    path: '/v1/subscriptions/receipt',
    methods: [HttpMethod.POST],
    perPrincipalPerMinute: RATE_LIMITS.ACCOUNT_MUTATION_PER_USER,
  },

  // -- support and safety ---------------------------------------------------
  {
    path: '/v1/support/tickets',
    methods: [HttpMethod.GET],
    perPrincipalPerMinute: GENERAL_READ_PER_MINUTE,
  },
  {
    path: '/v1/support/tickets',
    methods: [HttpMethod.POST],
    perPrincipalPerMinute: RATE_LIMITS.ACCOUNT_MUTATION_PER_USER,
  },
  {
    path: '/v1/support/access-grants',
    methods: [HttpMethod.POST],
    perPrincipalPerMinute: RATE_LIMITS.ACCOUNT_MUTATION_PER_USER,
  },
  {
    path: '/v1/support/access-grants/{grantId}',
    methods: [HttpMethod.DELETE],
    perPrincipalPerMinute: RATE_LIMITS.ACCOUNT_MUTATION_PER_USER,
  },
  {
    path: '/v1/support/reports',
    methods: [HttpMethod.POST],
    perPrincipalPerMinute: RATE_LIMITS.ACCOUNT_MUTATION_PER_USER,
    target: 'family-service',
  },
  {
    path: '/v1/support/blocks',
    methods: [HttpMethod.POST],
    perPrincipalPerMinute: RATE_LIMITS.ACCOUNT_MUTATION_PER_USER,
    target: 'family-service',
  },
  {
    path: '/v1/support/blocks/{userId}',
    methods: [HttpMethod.DELETE],
    perPrincipalPerMinute: RATE_LIMITS.ACCOUNT_MUTATION_PER_USER,
    target: 'family-service',
  },

  // -- webhooks: the only unauthenticated routes on this API -----------------
  {
    path: '/v1/webhooks/revenuecat',
    methods: [HttpMethod.POST],
    perPrincipalPerMinute: WEBHOOK_PER_MINUTE,
    target: 'revenuecat-webhook',
    unauthenticated: true,
  },
  {
    path: '/v1/webhooks/apple',
    methods: [HttpMethod.POST],
    perPrincipalPerMinute: WEBHOOK_PER_MINUTE,
    target: 'apple-webhook',
    unauthenticated: true,
  },
  {
    path: '/v1/webhooks/google',
    methods: [HttpMethod.POST],
    perPrincipalPerMinute: WEBHOOK_PER_MINUTE,
    target: 'google-webhook',
    unauthenticated: true,
  },
];

export interface ApiStackProps extends DataConsumerStackProps {
  /** User pool the JWT authorizer validates against. */
  readonly userPool: IUserPool;
  /** Only tokens minted for this app client are accepted. */
  readonly userPoolClient: IUserPoolClient;

  /** `POST /v1/locations/batch`. Owned by LocationStack. */
  readonly familyServiceFunction: IFunction;
  readonly invitationServiceFunction: IFunction;
  readonly locationIngestionFunction: IFunction;
  /** Authorised current and history reads. Owned by LocationStack. */
  readonly locationQueryFunction: IFunction;

  /** Owned by BillingStack; each verifies its provider's signature itself. */
  readonly revenueCatWebhookFunction: IFunction;
  readonly appleWebhookFunction: IFunction;
  readonly googleWebhookFunction: IFunction;
}

export class ApiStack extends Stack {
  public readonly httpApi: HttpApi;
  public readonly stage: HttpStage;
  public readonly domainName: DomainName;
  /** JWT authorizer, exposed so a later stack can add authorised routes. */
  public readonly authorizer: HttpUserPoolAuthorizer;
  /** `services/api`: everything that is neither a coordinate nor a webhook. */
  public readonly apiFunction: IFunction;
  /** Production only — see where it is created for why. */
  public readonly webAcl: CfnWebACL | undefined;
  /** Serves {@link EnvironmentConfig.apiDomain}; carries {@link webAcl}. */
  public readonly distribution: Distribution;
  public readonly accessLogGroup: LogGroup;

  public constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, {
      ...props,
      env: props.env ?? cdkEnvironment(props.config),
      terminationProtection: props.terminationProtection ?? props.config.isProduction,
      description:
        props.description ?? 'KinMap public HTTP API: routing, authorization and edge protection.',
      // Only materialises resources when the WebACL below actually lands in a
      // different region from this stack.
      crossRegionReferences: true,
    });

    const { config, foundation, tables } = props;

    applyStandardTags(this, config);

    // Where a us-east-1-only resource has to go. The foundation creates an edge
    // stack exactly when the primary region is not us-east-1; when it is, that
    // stack does not exist and `this` is already in the right region.
    const edgeScope: Construct = foundation.edgeStack ?? this;

    // -----------------------------------------------------------------------
    // The general API service
    // -----------------------------------------------------------------------
    const apiService = new NodeService(this, 'ApiService', {
      config,
      serviceName: 'api',
      description: 'KinMap v1 HTTP API: accounts, families, invitations, places, privacy.',
      memorySize: 1024,
      // Comfortably inside the 30s API Gateway integration ceiling, so a slow
      // dependency surfaces as the standard JSON error envelope rather than as
      // a gateway timeout the client cannot interpret.
      timeout: Duration.seconds(20),
      alarmTopic: foundation.alarmTopic,
      environment: {
        API_DOMAIN: config.apiDomain,
        WEB_DOMAIN: config.webDomain,
        USER_POOL_ID: props.userPool.userPoolId,
        USER_POOL_CLIENT_ID: props.userPoolClient.userPoolClientId,
        USERS_TABLE: tables.users.tableName,
        DEVICES_TABLE: tables.devices.tableName,
        FAMILIES_TABLE: tables.families.tableName,
        FAMILY_MEMBERSHIPS_TABLE: tables.familyMemberships.tableName,
        INVITATIONS_TABLE: tables.invitations.tableName,
        SAVED_PLACES_TABLE: tables.savedPlaces.tableName,
        NOTIFICATION_PREFERENCES_TABLE: tables.notificationPreferences.tableName,
        LIVE_SESSIONS_TABLE: tables.liveSessions.tableName,
        NOTIFICATIONS_TABLE: tables.notifications.tableName,
        CURRENT_LOCATIONS_TABLE: tables.currentLocations.tableName,
        LOCATION_HISTORY_TABLE: tables.locationHistory.tableName,
        SUBSCRIPTIONS_TABLE: tables.subscriptions.tableName,
        AUDIT_EVENTS_TABLE: tables.auditEvents.tableName,
        IDEMPOTENCY_TABLE: tables.idempotency.tableName,
        REMOTE_CONFIGURATION_TABLE: tables.remoteConfiguration.tableName,
        DELETION_JOBS_TABLE: tables.deletionJobs.tableName,
      },
    });
    this.apiFunction = apiService.function;

    // Least privilege, table by table.
    //
    // Note what is absent: currentLocations, locationHistory, geofenceState and
    // the coordinate KMS key. This function cannot read a coordinate even if it
    // is compromised, because the routes that handle one are integrated with
    // the LocationStack functions that hold the decrypt grant.
    tables.users.grantReadWriteData(this.apiFunction);
    tables.devices.grantReadWriteData(this.apiFunction);
    tables.families.grantReadWriteData(this.apiFunction);
    tables.familyMemberships.grantReadWriteData(this.apiFunction);
    tables.invitations.grantReadWriteData(this.apiFunction);
    tables.savedPlaces.grantReadWriteData(this.apiFunction);
    tables.notificationPreferences.grantReadWriteData(this.apiFunction);
    tables.liveSessions.grantReadWriteData(this.apiFunction);
    tables.notifications.grantReadWriteData(this.apiFunction);

    // Counting, and only counting.
    //
    // The deletion preview has to say how many location rows an account would
    // lose, and being wrong about that is how somebody deletes more than they
    // meant to. But this function holds no coordinate key, and it must not be
    // able to read a row either — so the grant is Query conditioned on Select
    // being COUNT. A query that asked for attributes is denied by IAM, not by a
    // convention someone has to remember.
    this.apiFunction.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['dynamodb:Query'],
        resources: [tables.currentLocations.tableArn, tables.locationHistory.tableArn],
        conditions: { StringEquals: { 'dynamodb:Select': 'COUNT' } },
      }),
    );
    tables.idempotency.grantReadWriteData(this.apiFunction);
    // Erasure is asynchronous: the API records the request and a worker
    // performs the deletion, so the API needs the job table but not the data.
    tables.deletionJobs.grantReadWriteData(this.apiFunction);
    // Entitlements are derived from the subscription record, which is only ever
    // written by BillingStack from a verified provider webhook.
    tables.subscriptions.grantReadData(this.apiFunction);
    // Remote configuration is authored out of band and only served from here.
    tables.remoteConfiguration.grantReadData(this.apiFunction);
    // The audit trail is append-and-read: `GET /v1/privacy/audit` shows a user
    // who looked them up, so nothing in the API may rewrite that history.
    // UpdateItem and DeleteItem are deliberately not granted.
    tables.auditEvents.grantReadData(this.apiFunction);
    tables.auditEvents.grant(this.apiFunction, 'dynamodb:PutItem');

    // -----------------------------------------------------------------------
    // HTTP API, JWT authorizer and custom domain
    // -----------------------------------------------------------------------
    this.authorizer = new HttpUserPoolAuthorizer('JwtAuthorizer', props.userPool, {
      authorizerName: `${config.resourcePrefix}-jwt`,
      userPoolClients: [props.userPoolClient],
      identitySource: ['$request.header.Authorization'],
    });

    // API Gateway answers on `origin-label.<domain>`, not on `api.<domain>`.
    //
    // `api.<domain>` is served by the CloudFront distribution created further
    // down, which is what carries the WebACL. CloudFront has to be given an
    // origin hostname that is not the hostname it serves — an alias record
    // pointing at a distribution whose origin is that same name would be its
    // own target — so the gateway keeps a private-by-convention name and the
    // public one moves to the edge.
    this.domainName = new DomainName(this, 'ApiDomainName', {
      domainName: config.apiOriginDomain,
      certificate: foundation.certificate,
    });

    // A custom domain with no DNS record fails silently in the worst way: API
    // Gateway reports AVAILABLE, the certificate is ISSUED, and every client
    // still gets NXDOMAIN. Nothing in the deploy complains.
    new ARecord(this, 'ApiOriginAliasRecord', {
      zone: foundation.hostedZone,
      recordName: config.apiOriginDomain,
      target: RecordTarget.fromAlias(
        new ApiGatewayv2DomainProperties(
          this.domainName.regionalDomainName,
          this.domainName.regionalHostedZoneId,
        ),
      ),
      comment: `Kinmap ${config.envName} API origin — CloudFront talks to this, clients do not`,
    });

    this.httpApi = new HttpApi(this, 'HttpApi', {
      apiName: `${config.resourcePrefix}-api`,
      description: `KinMap v1 API (${config.envName})`,
      // The stage is created explicitly below so that access logging and both
      // default and per-route throttling can be attached to it.
      createDefaultStage: false,
      defaultAuthorizer: this.authorizer,
      // Closed in every environment, not just production.
      //
      // The default `<apiId>.execute-api.<region>.amazonaws.com` endpoint is
      // derivable by anyone who can see an API id, and it bypasses both the
      // custom domain and — now that the WebACL lives on CloudFront — every WAF
      // rule with it. Leaving it open in development would mean the environment
      // used to rehearse changes is the one environment where the protection
      // being rehearsed is absent.
      disableExecuteApiEndpoint: true,
      corsPreflight: {
        allowOrigins: [`https://${config.webDomain}`],
        allowMethods: [
          CorsHttpMethod.GET,
          CorsHttpMethod.POST,
          CorsHttpMethod.PATCH,
          CorsHttpMethod.DELETE,
          CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: [
          'authorization',
          'content-type',
          'idempotency-key',
          'x-request-id',
          'x-app-version',
          'x-platform',
          // The fallback `resolveDeviceId` reads when a token carries no signed
          // `custom:device_id` claim. Omitting it here made every location read
          // from a browser fail preflight.
          'x-device-id',
        ],
        allowCredentials: false,
        maxAge: Duration.days(1),
      },
    });

    // One integration per owning service, reused across that service's routes.
    const integrations: Array<[RouteTarget, HttpLambdaIntegration]> = [
      ['api', lambdaIntegration('ApiIntegration', this.apiFunction)],
      ['family-service', lambdaIntegration('FamilyIntegration', props.familyServiceFunction)],
      [
        'invitation-service',
        lambdaIntegration('InvitationIntegration', props.invitationServiceFunction),
      ],
      [
        'location-ingestion',
        lambdaIntegration('IngestionIntegration', props.locationIngestionFunction),
      ],
      ['location-query', lambdaIntegration('QueryIntegration', props.locationQueryFunction)],
      [
        'revenuecat-webhook',
        lambdaIntegration('RevenueCatIntegration', props.revenueCatWebhookFunction),
      ],
      ['apple-webhook', lambdaIntegration('AppleWebhookIntegration', props.appleWebhookFunction)],
      [
        'google-webhook',
        lambdaIntegration('GoogleWebhookIntegration', props.googleWebhookFunction),
      ],
    ];

    // A single instance suffices: the authorizer is stateless, and every route
    // that opts out of authentication opts out in exactly the same way.
    const noAuthorizer = new HttpNoneAuthorizer();

    const allRoutes: IConstruct[] = [];

    for (const [target, integration] of integrations) {
      for (const route of API_ROUTES) {
        if ((route.target ?? 'api') !== target) {
          continue;
        }
        allRoutes.push(
          ...this.httpApi.addRoutes({
            path: route.path,
            methods: route.methods,
            integration,
            // `undefined` inherits the API's default JWT authorizer; only the
            // webhooks opt out of it.
            authorizer: route.unauthenticated === true ? noAuthorizer : undefined,
          }),
        );
      }
    }

    // -----------------------------------------------------------------------
    // Stage: access logging and throttling
    // -----------------------------------------------------------------------
    this.accessLogGroup = new LogGroup(this, 'AccessLogs', {
      // The vendedlogs prefix is what API Gateway's log delivery expects.
      logGroupName: `/aws/vendedlogs/apigateway/${config.resourcePrefix}-api`,
      // Access logs are evidence in an abuse investigation, so they follow the
      // audit retention rather than the shorter application retention.
      retention: config.auditLogRetention,
      removalPolicy: config.removalPolicy,
    });

    this.stage = new HttpStage(this, 'DefaultStage', {
      httpApi: this.httpApi,
      autoDeploy: true,
      domainMapping: { domainName: this.domainName },
    });

    // ---------------------------------------------------------------------
    // Collapse per-route Lambda permissions into one wildcard per function.
    //
    // HttpLambdaIntegration adds an AWS::Lambda::Permission for every route it
    // backs, each scoped to that route's execute-api ARN. A Lambda resource
    // policy is capped at 20 KB and 53 routes overflow it:
    //
    //   The final policy size (20721) is bigger than the limit (20480).
    //
    // One statement per function, scoped to this API, keeps the policy at six
    // statements. The grant is broader — any route on this API rather than an
    // enumerated one — but every route on this API already targets one of these
    // functions, so nothing new becomes reachable. Authorisation is enforced by
    // the JWT authorizer and, beyond it, by each service's own membership
    // checks; this permission only decides whether API Gateway may invoke.
    // ---------------------------------------------------------------------
    const backingFunctions: Array<[string, IFunction]> = [
      ['Api', this.apiFunction],
      ['Family', props.familyServiceFunction],
      ['Invitation', props.invitationServiceFunction],
      ['Ingestion', props.locationIngestionFunction],
      ['Query', props.locationQueryFunction],
      ['RevenueCat', props.revenueCatWebhookFunction],
      ['AppleWebhook', props.appleWebhookFunction],
      ['GoogleWebhook', props.googleWebhookFunction],
    ];
    const backingArns = new Set(backingFunctions.map(([, fn]) => fn.functionArn));

    for (const node of this.httpApi.node.findAll()) {
      if (node instanceof CfnPermission && backingArns.has(node.functionName)) {
        node.node.scope?.node.tryRemoveChild(node.node.id);
      }
    }

    const invokeSourceArn = Stack.of(this).formatArn({
      service: 'execute-api',
      resource: this.httpApi.apiId,
      resourceName: '*/*/*',
    });
    for (const [label, fn] of backingFunctions) {
      new CfnPermission(this, `Invoke${label}Permission`, {
        action: 'lambda:InvokeFunction',
        functionName: fn.functionArn,
        principal: 'apigateway.amazonaws.com',
        sourceArn: invokeSourceArn,
      });
    }

    // RouteSettings names each route by key, and API Gateway validates those
    // keys when the stage is created — "Unable to find Route by key ..." if a
    // route does not exist yet. CloudFormation sees no reference between the
    // stage and the routes, so the ordering has to be stated explicitly.
    for (const route of allRoutes) {
      this.stage.node.addDependency(route);
    }

    const cfnStage = this.stage.node.defaultChild as CfnStage;
    const concurrency = config.isProduction
      ? CONCURRENT_PRINCIPALS.production
      : CONCURRENT_PRINCIPALS.nonProduction;

    // Throttles and the log format are applied through property overrides
    // because per-route settings have no L2 representation; keeping all three
    // on the same escape hatch stops them from fighting the L2 construct.
    const defaultThrottle = fleetThrottle(RATE_LIMITS.ACCOUNT_MUTATION_PER_USER, concurrency);
    cfnStage.addPropertyOverride('DefaultRouteSettings', {
      ThrottlingRateLimit: defaultThrottle.rateLimit,
      ThrottlingBurstLimit: defaultThrottle.burstLimit,
      DetailedMetricsEnabled: true,
    });
    cfnStage.addPropertyOverride('RouteSettings', buildRouteSettings(concurrency, config));

    // The allowlist below is the whole logging contract for this API: no
    // `$context.path` (it carries user, family and session ids), no query
    // string, no request or response body, no Authorization header and no
    // authorizer claims. A line says "somebody read a location history"
    // without saying whose.
    cfnStage.addPropertyOverride('AccessLogSettings', {
      DestinationArn: this.accessLogGroup.logGroupArn,
      Format: JSON.stringify({
        requestId: '$context.requestId',
        requestTime: '$context.requestTime',
        routeKey: '$context.routeKey',
        status: '$context.status',
        protocol: '$context.protocol',
        responseLength: '$context.responseLength',
        responseLatencyMs: '$context.responseLatency',
        integrationLatencyMs: '$context.integrationLatency',
        integrationStatus: '$context.integrationStatus',
        integrationErrorMessage: '$context.integrationErrorMessage',
        errorMessage: '$context.error.message',
        authorizerError: '$context.authorizer.error',
        // Retained for abuse investigation and expired with the log group.
        sourceIp: '$context.identity.sourceIp',
        userAgent: '$context.identity.userAgent',
        stage: '$context.stage',
        apiId: '$context.apiId',
      }),
    });

    // -----------------------------------------------------------------------
    // WAF
    // -----------------------------------------------------------------------
    //
    // CLOUDFRONT scope, and therefore attached to the distribution below rather
    // than to the API directly. WAFv2 associates only with an Application Load
    // Balancer, an API Gateway REST API, an AppSync API, a Cognito user pool, an
    // App Runner service or a CloudFront distribution; an API Gateway HTTP API
    // is not on that list, and attempting it fails with a misleading complaint
    // about a malformed ARN when the ARN is in fact correct.
    //
    // A CLOUDFRONT-scoped ACL is a us-east-1 resource whatever region the rest
    // of the platform runs in, so it is created in the edge stack when one
    // exists — the same rule the foundation applies to CloudFront certificates.
    // Created in production only.
    //
    // A WebACL costs $5 a month plus $1 per rule, so these three rules are
    // about $8 per environment per month — $16 of which was being spent
    // filtering attacks against development and staging, which have no users
    // and no publicised hostname. The distribution is still created in every
    // environment, so attaching an ACL to a lower one later is a one-line
    // change, and the guard test requires production to have one.
    this.webAcl = !config.isProduction
      ? undefined
      : new CfnWebACL(edgeScope, 'ApiWebAcl', {
          name: `${config.resourcePrefix}-api`,
          // WAF validates descriptions against ^[\w+=:#@/\-,\.][\w+=:#@/\-,\.\s]+[\w+=:#@/\-,\.]$
          // — parentheses are rejected outright, so this reads as plain words.
          description: `Kinmap API protection - ${config.envName}`,
          scope: 'CLOUDFRONT',
          defaultAction: { allow: {} },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: `${config.resourcePrefix}-api-waf`,
            // Sampled requests keep request URIs and headers in the WAF console.
            // A URI carries user and family ids, so sampling stays off everywhere.
            sampledRequestsEnabled: false,
          },
          rules: [
            {
              name: 'AWSManagedRulesCommonRuleSet',
              priority: 10,
              overrideAction: { none: {} },
              statement: {
                managedRuleGroupStatement: {
                  vendorName: 'AWS',
                  name: 'AWSManagedRulesCommonRuleSet',
                  // SizeRestrictions_BODY blocks bodies over 8 KB, which would
                  // reject a legitimate location batch. The real ceiling is
                  // LIMITS.MAX_BATCH_PAYLOAD_BYTES, enforced by the ingestion
                  // service, so this one rule counts rather than blocks.
                  ruleActionOverrides: [
                    { name: 'SizeRestrictions_BODY', actionToUse: { count: {} } },
                  ],
                },
              },
              visibilityConfig: {
                cloudWatchMetricsEnabled: true,
                metricName: `${config.resourcePrefix}-waf-common`,
                sampledRequestsEnabled: false,
              },
            },
            {
              name: 'AWSManagedRulesKnownBadInputsRuleSet',
              priority: 20,
              overrideAction: { none: {} },
              statement: {
                managedRuleGroupStatement: {
                  vendorName: 'AWS',
                  name: 'AWSManagedRulesKnownBadInputsRuleSet',
                },
              },
              visibilityConfig: {
                cloudWatchMetricsEnabled: true,
                metricName: `${config.resourcePrefix}-waf-known-bad-inputs`,
                sampledRequestsEnabled: false,
              },
            },
            {
              // Volumetric backstop per source IP, sitting above every per-route
              // throttle. It exists to blunt credential stuffing and invitation
              // token guessing, not to shape ordinary traffic.
              name: 'RateLimitPerIp',
              priority: 30,
              action: { block: {} },
              statement: {
                rateBasedStatement: {
                  aggregateKeyType: 'IP',
                  limit: config.isProduction ? 3000 : 600,
                },
              },
              visibilityConfig: {
                cloudWatchMetricsEnabled: true,
                metricName: `${config.resourcePrefix}-waf-rate-limit`,
                sampledRequestsEnabled: false,
              },
            },
          ],
        });

    // -----------------------------------------------------------------------
    // Edge: the distribution clients actually reach
    // -----------------------------------------------------------------------
    //
    // This exists to carry the WebACL, not to cache. Every route is either
    // authorised per-principal or a provider webhook, so there is nothing here
    // that two different callers may share a response for, and caching is
    // disabled outright rather than tuned down: a cached authorised response is
    // a location leak between family members, which is the one failure this
    // product cannot have.
    //
    // What it does buy beyond the ACL is TLS termination at the edge and the
    // ability to shed a volumetric attack before it reaches Lambda.
    this.distribution = new Distribution(this, 'ApiDistribution', {
      comment: `Kinmap ${config.envName} API`,
      domainNames: [config.apiDomain],
      // CloudFront accepts certificates only from us-east-1; the foundation
      // creates this one there whatever region the platform runs in.
      certificate: foundation.cloudFrontCertificate,
      webAclId: this.webAcl?.attrArn,
      httpVersion: HttpVersion.HTTP2_AND_3,
      minimumProtocolVersion: SecurityPolicyProtocol.TLS_V1_2_2021,
      priceClass: config.isProduction ? PriceClass.PRICE_CLASS_ALL : PriceClass.PRICE_CLASS_100,
      enableIpv6: true,
      // Standard access logs record the full request URI, and a URI here
      // carries user, family, place and session ids. Off, for the same reason
      // the access log format above logs `routeKey` rather than `path` and WAF
      // request sampling is disabled.
      enableLogging: false,
      defaultBehavior: {
        // `origin-label.<domain>` is a public name, so reaching it directly and
        // skipping these rules is possible for anyone who finds it. The shared
        // secret that closes that path is added by the origin-verification
        // change; what stands in front of the origin until then is the JWT
        // authorizer, the per-route throttles configured above and the
        // per-principal token bucket in services/api — all of which apply
        // whichever hostname a request arrives on.
        origin: new HttpOrigin(config.apiOriginDomain, {
          protocolPolicy: OriginProtocolPolicy.HTTPS_ONLY,
          originSslProtocols: [OriginSslPolicy.TLS_V1_2],
          readTimeout: Duration.seconds(30),
          keepaliveTimeout: Duration.seconds(30),
        }),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: AllowedMethods.ALLOW_ALL,
        cachePolicy: CachePolicy.CACHING_DISABLED,
        // Everything the viewer sent except Host, which must stay the origin's
        // own name: API Gateway selects the custom domain mapping by Host, and
        // forwarding `api.<domain>` to a gateway that only knows
        // `origin-label.<domain>` would 403 every request.
        originRequestPolicy: OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        compress: true,
      },
    });

    new ARecord(this, 'ApiAliasRecord', {
      zone: foundation.hostedZone,
      recordName: config.apiDomain,
      target: RecordTarget.fromAlias(new CloudFrontTarget(this.distribution)),
      comment: `Kinmap ${config.envName} API`,
    });
    // IPv6 is enabled on the distribution, so a client on an IPv6-only mobile
    // network resolves nothing at all without this record.
    new AaaaRecord(this, 'ApiAliasRecordIpv6', {
      zone: foundation.hostedZone,
      recordName: config.apiDomain,
      target: RecordTarget.fromAlias(new CloudFrontTarget(this.distribution)),
      comment: `Kinmap ${config.envName} API`,
    });

    // -----------------------------------------------------------------------
    // Outputs
    // -----------------------------------------------------------------------
    new CfnOutput(this, 'ApiUrl', {
      value: `https://${config.apiDomain}`,
      description: 'Public API base URL',
      exportName: `${config.resourcePrefix}-api-url`,
    });
    new CfnOutput(this, 'ApiId', {
      value: this.httpApi.apiId,
      description: 'HTTP API id',
      exportName: `${config.resourcePrefix}-api-id`,
    });
    // The default execute-api endpoint is disabled in every environment now, so
    // there is no such URL to output. Reading `apiEndpoint` would throw.
    new CfnOutput(this, 'ApiOriginDomainName', {
      value: config.apiOriginDomain,
      description: 'Origin hostname CloudFront forwards to; not for clients',
    });
    new CfnOutput(this, 'ApiRegionalDomainName', {
      value: this.domainName.regionalDomainName,
      description: 'Alias target for the origin-label.<domain> record',
    });
    new CfnOutput(this, 'ApiRegionalHostedZoneId', {
      value: this.domainName.regionalHostedZoneId,
      description: 'Alias hosted zone id for the origin-label.<domain> record',
    });
    new CfnOutput(this, 'ApiDistributionDomainName', {
      value: this.distribution.distributionDomainName,
      description: 'Alias target for the api.<domain> record',
    });
    if (this.webAcl !== undefined) {
      new CfnOutput(this, 'ApiWebAclArn', {
        value: this.webAcl.attrArn,
        description: 'CLOUDFRONT WAF WebACL attached to the API distribution',
      });
    }
    new CfnOutput(this, 'ApiMaxBatchPayloadBytes', {
      value: String(LIMITS.MAX_BATCH_PAYLOAD_BYTES),
      description: 'Ingestion payload ceiling the WAF size rule is relaxed for',
    });
  }
}

/** Every route uses the same payload format; only the target differs. */
function lambdaIntegration(id: string, handler: IFunction): HttpLambdaIntegration {
  return new HttpLambdaIntegration(id, handler, {
    payloadFormatVersion: PayloadFormatVersion.VERSION_2_0,
  });
}

/**
 * Converts a per-principal-per-minute ceiling into a fleet-wide
 * requests-per-second stage throttle. Burst is twice the steady rate, with a
 * floor that stops a low-volume route from being throttled by one client
 * retrying a handful of times.
 */
function fleetThrottle(
  perPrincipalPerMinute: number,
  concurrentPrincipals: number,
): { rateLimit: number; burstLimit: number } {
  const rateLimit = Math.max(1, Math.ceil((perPrincipalPerMinute / 60) * concurrentPrincipals));
  return { rateLimit, burstLimit: Math.max(rateLimit * 2, 10) };
}

/**
 * Builds the stage's per-route throttle map, keyed by API Gateway route key
 * (`"GET /v1/places"`). Written in CloudFormation casing because it is applied
 * through a property override rather than through typed L1 properties.
 */
function buildRouteSettings(
  concurrentPrincipals: number,
  config: EnvironmentConfig,
): Record<string, Record<string, number | boolean>> {
  const settings: Record<string, Record<string, number | boolean>> = {};
  for (const route of API_ROUTES) {
    const throttle = fleetThrottle(route.perPrincipalPerMinute, concurrentPrincipals);
    for (const method of route.methods) {
      settings[`${method} ${route.path}`] = {
        ThrottlingRateLimit: throttle.rateLimit,
        ThrottlingBurstLimit: throttle.burstLimit,
        // Per-route metrics are billed per route, so they are a production-only
        // expense.
        DetailedMetricsEnabled: config.isProduction,
      };
    }
  }
  return settings;
}
