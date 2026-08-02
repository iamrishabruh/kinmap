import { CfnOutput, Stack } from 'aws-cdk-lib';
import {
  AttributeType,
  StreamViewType,
  type Attribute,
  type Table,
} from 'aws-cdk-lib/aws-dynamodb';
import type { IKey } from 'aws-cdk-lib/aws-kms';
import type { ITopic } from 'aws-cdk-lib/aws-sns';
import type { Construct } from 'constructs';

import { cdkEnvironment, type BaseStackProps, type DataTables } from '../config/index.js';
import { GuardedTable } from '../constructs/guarded-table.js';

export interface DataStackProps extends BaseStackProps {
  /** Customer-managed key from the foundation stack. */
  readonly encryptionKey: IKey;
  /** Table throttle and system-error alarms publish here. */
  readonly alarmTopic?: ITopic;
}

/** Shorthand for a string key attribute. */
const str = (name: string): Attribute => ({ name, type: AttributeType.STRING });

/** Shorthand for a numeric key attribute. */
const num = (name: string): Attribute => ({ name, type: AttributeType.NUMBER });

/**
 * Maps each table onto the environment variable services read it from. The
 * shared wiring contract is: the table's logical name in SCREAMING_SNAKE_CASE
 * with a `_TABLE` suffix.
 */
export const TABLE_ENVIRONMENT_VARIABLES = {
  users: 'USERS_TABLE',
  devices: 'DEVICES_TABLE',
  families: 'FAMILIES_TABLE',
  familyMemberships: 'FAMILY_MEMBERSHIPS_TABLE',
  invitations: 'INVITATIONS_TABLE',
  currentLocations: 'CURRENT_LOCATIONS_TABLE',
  locationHistory: 'LOCATION_HISTORY_TABLE',
  savedPlaces: 'SAVED_PLACES_TABLE',
  geofenceState: 'GEOFENCE_STATE_TABLE',
  notificationPreferences: 'NOTIFICATION_PREFERENCES_TABLE',
  liveSessions: 'LIVE_SESSIONS_TABLE',
  subscriptions: 'SUBSCRIPTIONS_TABLE',
  auditEvents: 'AUDIT_EVENTS_TABLE',
  idempotency: 'IDEMPOTENCY_TABLE',
  dataMigrations: 'DATA_MIGRATIONS_TABLE',
  remoteConfiguration: 'REMOTE_CONFIGURATION_TABLE',
  deletionJobs: 'DELETION_JOBS_TABLE',
} as const satisfies Record<keyof DataTables, string>;

/**
 * Builds the `<NAME>_TABLE` environment block for a Lambda. A service should
 * still be granted only the tables it actually needs; this is naming, not
 * authorisation.
 */
export function tableEnvironment(tables: DataTables): Record<string, string> {
  return {
    [TABLE_ENVIRONMENT_VARIABLES.users]: tables.users.tableName,
    [TABLE_ENVIRONMENT_VARIABLES.devices]: tables.devices.tableName,
    [TABLE_ENVIRONMENT_VARIABLES.families]: tables.families.tableName,
    [TABLE_ENVIRONMENT_VARIABLES.familyMemberships]: tables.familyMemberships.tableName,
    [TABLE_ENVIRONMENT_VARIABLES.invitations]: tables.invitations.tableName,
    [TABLE_ENVIRONMENT_VARIABLES.currentLocations]: tables.currentLocations.tableName,
    [TABLE_ENVIRONMENT_VARIABLES.locationHistory]: tables.locationHistory.tableName,
    [TABLE_ENVIRONMENT_VARIABLES.savedPlaces]: tables.savedPlaces.tableName,
    [TABLE_ENVIRONMENT_VARIABLES.geofenceState]: tables.geofenceState.tableName,
    [TABLE_ENVIRONMENT_VARIABLES.notificationPreferences]: tables.notificationPreferences.tableName,
    [TABLE_ENVIRONMENT_VARIABLES.liveSessions]: tables.liveSessions.tableName,
    [TABLE_ENVIRONMENT_VARIABLES.subscriptions]: tables.subscriptions.tableName,
    [TABLE_ENVIRONMENT_VARIABLES.auditEvents]: tables.auditEvents.tableName,
    [TABLE_ENVIRONMENT_VARIABLES.idempotency]: tables.idempotency.tableName,
    [TABLE_ENVIRONMENT_VARIABLES.dataMigrations]: tables.dataMigrations.tableName,
    [TABLE_ENVIRONMENT_VARIABLES.remoteConfiguration]: tables.remoteConfiguration.tableName,
    [TABLE_ENVIRONMENT_VARIABLES.deletionJobs]: tables.deletionJobs.tableName,
  };
}

/**
 * Every DynamoDB table in the platform.
 *
 * Design notes that matter beyond the key schema:
 *
 *  - `LocationHistory` is partitioned per user **per day** so that a history
 *    query is a bounded `Query` over at most `MAX_HISTORY_RANGE_DAYS`
 *    partitions, and so that "delete my history for last Tuesday" is a
 *    partition-scoped delete rather than a scan.
 *  - `FamilyMemberships` is the authorisation source of truth. Every sensitive
 *    read checks it server-side; the `byUser` index exists so that check is a
 *    single-key lookup rather than a scan, because an authorisation check that
 *    is slow is an authorisation check that gets cached badly.
 *  - `AuditEvents` is keyed by the person who was looked at, not by the person
 *    who did the looking, because the question that has to be answerable in one
 *    query is "who accessed my location?".
 *  - `Invitations` is keyed by a hash of the token, never the token itself, so
 *    a database dump does not yield usable invitation links.
 *  - Coordinates stored in `CurrentLocations` and `LocationHistory` are already
 *    envelope-encrypted by the application before they arrive (spec §20). The
 *    customer-managed key here is defence in depth, not the primary control.
 */
export class DataStack extends Stack implements DataTables {
  readonly users: Table;
  readonly devices: Table;
  readonly families: Table;
  readonly familyMemberships: Table;
  readonly invitations: Table;
  readonly currentLocations: Table;
  readonly locationHistory: Table;
  readonly savedPlaces: Table;
  readonly geofenceState: Table;
  readonly notificationPreferences: Table;
  readonly liveSessions: Table;
  readonly subscriptions: Table;
  readonly auditEvents: Table;
  readonly idempotency: Table;
  readonly dataMigrations: Table;
  readonly remoteConfiguration: Table;
  readonly deletionJobs: Table;

  /** The same tables as a single object, for passing to consuming stacks. */
  readonly tables: DataTables;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, {
      ...props,
      env: cdkEnvironment(props.config),
      terminationProtection: props.terminationProtection ?? props.config.isProduction,
      description: props.description ?? `Kinmap ${props.config.envName} — DynamoDB tables`,
    });

    const { config, encryptionKey, alarmTopic } = props;
    const shared = { config, encryptionKey, alarmTopic };

    // -- Identity ----------------------------------------------------------

    this.users = new GuardedTable(this, 'Users', {
      ...shared,
      tableName: 'Users',
      partitionKey: str('userId'),
      globalSecondaryIndexes: [
        // Sign-in resolves an account from a salted hash of the email address;
        // the plaintext address is never a key, so it cannot be enumerated.
        { indexName: 'byEmailHash', partitionKey: str('emailHash') },
      ],
    });

    this.devices = new GuardedTable(this, 'Devices', {
      ...shared,
      tableName: 'Devices',
      partitionKey: str('userId'),
      sortKey: str('deviceId'),
      globalSecondaryIndexes: [
        // Ingestion authenticates a device before it knows which user it is.
        { indexName: 'byDeviceId', partitionKey: str('deviceId') },
      ],
    });

    // -- Families and membership ------------------------------------------

    this.families = new GuardedTable(this, 'Families', {
      ...shared,
      tableName: 'Families',
      partitionKey: str('familyId'),
      globalSecondaryIndexes: [
        { indexName: 'byOwner', partitionKey: str('ownerUserId'), sortKey: str('createdAt') },
      ],
    });

    this.familyMemberships = new GuardedTable(this, 'FamilyMemberships', {
      ...shared,
      tableName: 'FamilyMemberships',
      partitionKey: str('familyId'),
      sortKey: str('userId'),
      // Removing a member must invalidate every cached authorisation decision
      // immediately, so this table's changes are streamed.
      stream: StreamViewType.NEW_AND_OLD_IMAGES,
      globalSecondaryIndexes: [
        { indexName: 'byUser', partitionKey: str('userId'), sortKey: str('familyId') },
      ],
    });

    this.invitations = new GuardedTable(this, 'Invitations', {
      ...shared,
      tableName: 'Invitations',
      partitionKey: str('tokenHash'),
      timeToLiveAttribute: 'expiresAt',
      globalSecondaryIndexes: [
        { indexName: 'byFamily', partitionKey: str('familyId'), sortKey: str('createdAt') },
      ],
    });

    // -- Location ----------------------------------------------------------

    this.currentLocations = new GuardedTable(this, 'CurrentLocations', {
      ...shared,
      tableName: 'CurrentLocations',
      partitionKey: str('userId'),
      sortKey: str('deviceId'),
      // Geofence evaluation and live-session fan-out consume this stream.
      stream: StreamViewType.NEW_AND_OLD_IMAGES,
    });

    this.locationHistory = new GuardedTable(this, 'LocationHistory', {
      ...shared,
      tableName: 'LocationHistory',
      // pk: USER#<userId>#DAY#<yyyy-mm-dd>   sk: TIME#<iso>#EVENT#<eventId>
      partitionKey: str('pk'),
      sortKey: str('sk'),
      timeToLiveAttribute: 'expiresAt',
    });

    // -- Places and geofencing --------------------------------------------

    this.savedPlaces = new GuardedTable(this, 'SavedPlaces', {
      ...shared,
      tableName: 'SavedPlaces',
      partitionKey: str('familyId'),
      sortKey: str('placeId'),
      globalSecondaryIndexes: [
        { indexName: 'byCreator', partitionKey: str('createdBy'), sortKey: str('placeId') },
      ],
    });

    this.geofenceState = new GuardedTable(this, 'GeofenceState', {
      ...shared,
      tableName: 'GeofenceState',
      // One row per (user, place): whether they are currently inside, and when
      // that last changed. Needed to emit ARRIVAL/DEPARTURE exactly once.
      partitionKey: str('userId'),
      sortKey: str('placeId'),
      timeToLiveAttribute: 'expiresAt',
    });

    // -- Notifications and live sessions ----------------------------------

    this.notificationPreferences = new GuardedTable(this, 'NotificationPreferences', {
      ...shared,
      tableName: 'NotificationPreferences',
      partitionKey: str('userId'),
      sortKey: str('familyId'),
    });

    this.liveSessions = new GuardedTable(this, 'LiveSessions', {
      ...shared,
      tableName: 'LiveSessions',
      partitionKey: str('sessionId'),
      timeToLiveAttribute: 'expiresAt',
      globalSecondaryIndexes: [
        // "Is anyone watching me right now?" must be answerable by the target,
        // and the concurrency limit is enforced against this index.
        { indexName: 'byTarget', partitionKey: str('targetUserId'), sortKey: str('startedAt') },
        {
          indexName: 'byRequester',
          partitionKey: str('requesterUserId'),
          sortKey: str('startedAt'),
        },
      ],
    });

    // -- Billing -----------------------------------------------------------

    this.subscriptions = new GuardedTable(this, 'Subscriptions', {
      ...shared,
      tableName: 'Subscriptions',
      partitionKey: str('userId'),
      // Entitlement changes fan out to the API's cache and to the mobile push.
      stream: StreamViewType.NEW_AND_OLD_IMAGES,
      globalSecondaryIndexes: [
        // Store server notifications arrive keyed by the original transaction.
        {
          indexName: 'byOriginalTransactionId',
          partitionKey: str('originalTransactionId'),
        },
        { indexName: 'byFamily', partitionKey: str('familyId'), sortKey: str('userId') },
      ],
    });

    // -- Audit and platform -----------------------------------------------

    this.auditEvents = new GuardedTable(this, 'AuditEvents', {
      ...shared,
      tableName: 'AuditEvents',
      // pk: the user who was looked at.  sk: <occurredAt>#<auditId>
      partitionKey: str('targetUserId'),
      sortKey: str('sk'),
      timeToLiveAttribute: 'expiresAt',
      globalSecondaryIndexes: [
        { indexName: 'byActor', partitionKey: str('actorUserId'), sortKey: str('sk') },
        { indexName: 'byFamily', partitionKey: str('familyId'), sortKey: str('sk') },
      ],
    });

    this.idempotency = new GuardedTable(this, 'Idempotency', {
      ...shared,
      tableName: 'Idempotency',
      partitionKey: str('idempotencyKey'),
      timeToLiveAttribute: 'expiresAt',
    });

    this.dataMigrations = new GuardedTable(this, 'DataMigrations', {
      ...shared,
      tableName: 'DataMigrations',
      partitionKey: str('migrationId'),
      globalSecondaryIndexes: [
        { indexName: 'byStatus', partitionKey: str('status'), sortKey: str('recordedAt') },
      ],
    });

    this.remoteConfiguration = new GuardedTable(this, 'RemoteConfiguration', {
      ...shared,
      tableName: 'RemoteConfiguration',
      // Versioned so a bad rollout can be pinned back without a deployment, and
      // so a device can report which version it is running (spec §30).
      partitionKey: str('configKey'),
      sortKey: num('version'),
    });

    this.deletionJobs = new GuardedTable(this, 'DeletionJobs', {
      ...shared,
      tableName: 'DeletionJobs',
      partitionKey: str('jobId'),
      globalSecondaryIndexes: [
        { indexName: 'byUser', partitionKey: str('userId'), sortKey: str('requestedAt') },
        // The scheduler sweeps due jobs off this index; account deletion has a
        // hard deadline and must not depend on a scan finding it in time.
        { indexName: 'byStatus', partitionKey: str('status'), sortKey: str('scheduledFor') },
      ],
    });

    this.tables = {
      users: this.users,
      devices: this.devices,
      families: this.families,
      familyMemberships: this.familyMemberships,
      invitations: this.invitations,
      currentLocations: this.currentLocations,
      locationHistory: this.locationHistory,
      savedPlaces: this.savedPlaces,
      geofenceState: this.geofenceState,
      notificationPreferences: this.notificationPreferences,
      liveSessions: this.liveSessions,
      subscriptions: this.subscriptions,
      auditEvents: this.auditEvents,
      idempotency: this.idempotency,
      dataMigrations: this.dataMigrations,
      remoteConfiguration: this.remoteConfiguration,
      deletionJobs: this.deletionJobs,
    };

    for (const [key, variable] of Object.entries(TABLE_ENVIRONMENT_VARIABLES)) {
      const table = this.tables[key as keyof DataTables];
      new CfnOutput(this, `${key}TableNameOutput`, {
        value: table.tableName,
        description: `${variable} for every service granted access to it`,
      });
    }
  }

  /**
   * `<NAME>_TABLE` environment block for a Lambda in a consuming stack.
   *
   * Deliberately NOT named `environment`: CDK's `Stack` already declares an
   * `environment` string property, and shadowing it with a method makes
   * DataStack structurally incompatible with Stack everywhere it is passed.
   */
  tableEnvironmentVariables(): Record<string, string> {
    return tableEnvironment(this.tables);
  }
}
