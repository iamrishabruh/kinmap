/**
 * Family stack — who is in a family, and who was invited to be.
 *
 * These two services existed in `services/` for the entire life of the project
 * and were deployed by nothing. Their routes were declared in API Gateway and
 * pointed at `services/api`, which registers no handler for any of them, so the
 * whole family and invitation surface answered 404 to an authenticated caller
 * while every stack reported CREATE_COMPLETE.
 *
 * Neither service ever touches a coordinate. They decide membership; the
 * location stack decides what a membership lets you see. That separation is why
 * neither function here is granted `kms:Decrypt` on the coordinate key, and why
 * neither is given read access to any location table.
 *
 * Wiring contract, as everywhere else:
 *   - table names reach services as `<TABLE>_TABLE`
 *   - each service is `services/<name>/src/handler.ts`, named export `handler`
 *
 * Stack dependency direction: this stack is synthesised before ApiStack, which
 * takes both functions as props and integrates them. Nothing here depends on
 * the API.
 */
import { CfnOutput, Duration, Stack } from 'aws-cdk-lib';
import { EventBus } from 'aws-cdk-lib/aws-events';
import { type IFunction } from 'aws-cdk-lib/aws-lambda';
import { type Construct } from 'constructs';

import { applyStandardTags, cdkEnvironment } from '../config/index.js';
import { type DataConsumerStackProps } from '../config/types.js';
import { NodeService } from '../constructs/node-service.js';

/**
 * EventBridge vocabulary, handed to the publisher as an environment variable so
 * a producer and any future rule cannot drift apart. Mirrors the equivalent
 * constant in the location stack.
 */
const FAMILY_EVENT_SOURCE = 'kinmap.family';

const FAMILY_SERVICE_TIMEOUT = Duration.seconds(15);
const INVITATION_SERVICE_TIMEOUT = Duration.seconds(15);

export interface FamilyStackProps extends DataConsumerStackProps {
  /**
   * Cognito pool, for the in-process token verifier used when a route is
   * reached without the HTTP API's JWT authorizer in front of it.
   */
  readonly userPoolId?: string;
  readonly userPoolClientId?: string;
}

export class FamilyStack extends Stack {
  public readonly familyServiceFunction: IFunction;
  public readonly invitationServiceFunction: IFunction;

  /** Membership lifecycle events. No coordinate is ever published here. */
  public readonly familyEventBus: EventBus;

  constructor(scope: Construct, id: string, props: FamilyStackProps) {
    super(scope, id, {
      ...props,
      env: props.env ?? cdkEnvironment(props.config),
      terminationProtection: props.terminationProtection ?? props.config.isProduction,
      description: props.description ?? 'Kinmap families, memberships and invitations.',
    });

    const { config, foundation, tables } = props;

    applyStandardTags(this, config);

    // -----------------------------------------------------------------------
    // Membership events
    //
    // FAMILY_CREATED, MEMBERSHIP_ENDED, MEMBER_ROLE_CHANGED,
    // OWNERSHIP_TRANSFERRED, USER_BLOCKED, ABUSE_REPORTED. Nothing subscribes
    // yet; the bus exists because the publisher throws UPSTREAM_UNAVAILABLE on
    // a non-zero FailedEntryCount, so an absent bus fails the whole request
    // rather than losing the announcement quietly.
    // -----------------------------------------------------------------------

    this.familyEventBus = new EventBus(this, 'FamilyEventBus', {
      eventBusName: `${config.resourcePrefix}-family`,
    });

    // -----------------------------------------------------------------------
    // services/family-service
    // -----------------------------------------------------------------------

    const familyService = new NodeService(this, 'FamilyService', {
      config,
      serviceName: 'family-service',
      // Routed to by the public API, so it must be able to tell a request
      // that came through CloudFront from one that went around it.
      edgeVerificationSecret: foundation.edgeVerificationSecret,
      description: 'Families, memberships, blocks and abuse reports.',
      memorySize: 1024,
      timeout: FAMILY_SERVICE_TIMEOUT,
      environment: {
        FAMILIES_TABLE: tables.families.tableName,
        FAMILY_MEMBERSHIPS_TABLE: tables.familyMemberships.tableName,
        USERS_TABLE: tables.users.tableName,
        DEVICES_TABLE: tables.devices.tableName,
        SUBSCRIPTIONS_TABLE: tables.subscriptions.tableName,
        AUDIT_EVENTS_TABLE: tables.auditEvents.tableName,
        FAMILY_EVENT_BUS_NAME: this.familyEventBus.eventBusName,
        FAMILY_EVENT_SOURCE,
        // Reached from a support response when someone reports being tracked
        // against their will, so it must point at a page that exists.
        SAFETY_RESOURCES_URL: `https://${config.webDomain}/safety`,
        ...(props.userPoolId === undefined ? {} : { USER_POOL_ID: props.userPoolId }),
        ...(props.userPoolClientId === undefined
          ? {}
          : { USER_POOL_CLIENT_ID: props.userPoolClientId }),
      },
    });
    this.familyServiceFunction = familyService.function;

    tables.families.grantReadWriteData(this.familyServiceFunction);
    tables.familyMemberships.grantReadWriteData(this.familyServiceFunction);
    tables.users.grantReadData(this.familyServiceFunction);
    tables.devices.grantReadData(this.familyServiceFunction);
    tables.subscriptions.grantReadData(this.familyServiceFunction);
    // Append-only. The service never updates, deletes or reads an audit row, so
    // `grantWriteData` would hand over more than it uses — and the audit trail
    // is the one record a compromised function must not be able to edit.
    tables.auditEvents.grant(this.familyServiceFunction, 'dynamodb:PutItem');
    this.familyEventBus.grantPutEventsTo(this.familyServiceFunction);

    // -----------------------------------------------------------------------
    // services/invitation-service
    // -----------------------------------------------------------------------

    const invitationService = new NodeService(this, 'InvitationService', {
      config,
      serviceName: 'invitation-service',
      // Routed to by the public API, so it must be able to tell a request
      // that came through CloudFront from one that went around it.
      edgeVerificationSecret: foundation.edgeVerificationSecret,
      description: 'Issues, previews, accepts and revokes family invitations.',
      memorySize: 1024,
      timeout: INVITATION_SERVICE_TIMEOUT,
      environment: {
        INVITATIONS_TABLE: tables.invitations.tableName,
        FAMILIES_TABLE: tables.families.tableName,
        FAMILY_MEMBERSHIPS_TABLE: tables.familyMemberships.tableName,
        USERS_TABLE: tables.users.tableName,
        DEVICES_TABLE: tables.devices.tableName,
        SUBSCRIPTIONS_TABLE: tables.subscriptions.tableName,
        AUDIT_EVENTS_TABLE: tables.auditEvents.tableName,
        // The base of the link that is texted to an invitee. It has to match the
        // paths the association file advertises, or the link opens a browser
        // instead of the app.
        INVITE_LINK_BASE_URL: `https://${config.webDomain}/invite`,
        ...(props.userPoolId === undefined ? {} : { USER_POOL_ID: props.userPoolId }),
        ...(props.userPoolClientId === undefined
          ? {}
          : { USER_POOL_CLIENT_ID: props.userPoolClientId }),
      },
    });
    this.invitationServiceFunction = invitationService.function;

    tables.invitations.grantReadWriteData(this.invitationServiceFunction);
    tables.families.grantReadData(this.invitationServiceFunction);
    tables.familyMemberships.grantReadWriteData(this.invitationServiceFunction);
    tables.users.grantReadData(this.invitationServiceFunction);
    tables.devices.grantReadData(this.invitationServiceFunction);
    tables.subscriptions.grantReadData(this.invitationServiceFunction);
    tables.auditEvents.grant(this.invitationServiceFunction, 'dynamodb:PutItem');

    new CfnOutput(this, 'FamilyEventBusNameOutput', {
      value: this.familyEventBus.eventBusName,
      description: 'Membership lifecycle events',
    });
  }
}
