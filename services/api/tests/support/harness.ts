import type { AuthContext, TokenVerifier } from '@family/auth';
import type { AppEnv, DeviceId, FamilyId, UserId } from '@family/contracts';
import { createLogger, createMemorySink, type LogRecord, type Logger } from '@family/observability';
import {
  DeleteCommand,
  GetCommand,
  InMemoryDocumentClient,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type TableDefinition,
} from '@family/test-utils';

import type { ApiConfig } from '../../src/env.js';
import { createTokenBucketRateLimiter } from '../../src/middleware/rateLimit.js';
import { createPipeline, type Pipeline } from '../../src/pipeline.js';
import { createAccountsRepository } from '../../src/repositories/accounts.js';
import { createAuditRepository } from '../../src/repositories/audit.js';
import { createRemoteConfigurationRepository } from '../../src/repositories/configuration.js';
import { createDevicesRepository } from '../../src/repositories/devices.js';
import type { DocumentClient, Item } from '../../src/repositories/document-client.js';
import {
  createFamiliesRepository,
  createMembershipsRepository,
} from '../../src/repositories/families.js';
import {
  createIdempotencyStore,
  createTokenBucketStore,
} from '../../src/repositories/idempotency.js';
import { createJobsRepository } from '../../src/repositories/jobs.js';
import { createLiveSessionsRepository } from '../../src/repositories/live-sessions.js';
import {
  createNotificationPreferencesRepository,
  createNotificationsRepository,
} from '../../src/repositories/notifications.js';
import { createPlacesRepository } from '../../src/repositories/places.js';
import { createSubscriptionsRepository } from '../../src/repositories/subscriptions.js';
import { createSupportRepository } from '../../src/repositories/support.js';
import { createRouter } from '../../src/router.js';
import { routes } from '../../src/routes/index.js';
import type { ApiServices } from '../../src/services.js';
import type { HttpMethod, HttpRequest } from '../../src/types.js';

/**
 * A complete API in a variable: real repositories, real middleware, real route
 * table, backed by the in-memory DynamoDB fake from `@family/test-utils` — which
 * really evaluates condition expressions, so idempotency claims and token-bucket
 * compare-and-set are exercised rather than stubbed.
 */

export const TABLES = {
  users: 'Users',
  devices: 'Devices',
  families: 'Families',
  familyMemberships: 'FamilyMemberships',
  subscriptions: 'Subscriptions',
  auditEvents: 'AuditEvents',
  idempotency: 'Idempotency',
  remoteConfiguration: 'RemoteConfiguration',
  deletionJobs: 'DeletionJobs',
  savedPlaces: 'SavedPlaces',
  liveSessions: 'LiveSessions',
  notifications: 'Notifications',
  notificationPreferences: 'NotificationPreferences',
} as const;

const TABLE_DEFINITIONS: TableDefinition[] = [
  { name: TABLES.users, keySchema: { partitionKey: 'userId' } },
  {
    name: TABLES.devices,
    keySchema: { partitionKey: 'userId', sortKey: 'deviceId' },
    indexes: { byDeviceId: { partitionKey: 'deviceId' } },
  },
  { name: TABLES.families, keySchema: { partitionKey: 'familyId' } },
  {
    name: TABLES.savedPlaces,
    keySchema: { partitionKey: 'familyId', sortKey: 'placeId' },
    indexes: { byCreator: { partitionKey: 'createdBy', sortKey: 'placeId' } },
  },
  {
    name: TABLES.liveSessions,
    keySchema: { partitionKey: 'sessionId' },
    indexes: {
      byTarget: { partitionKey: 'targetUserId', sortKey: 'startedAt' },
      byRequester: { partitionKey: 'requesterUserId', sortKey: 'startedAt' },
    },
  },
  { name: TABLES.notifications, keySchema: { partitionKey: 'userId', sortKey: 'sortKey' } },
  {
    name: TABLES.notificationPreferences,
    keySchema: { partitionKey: 'userId', sortKey: 'familyId' },
  },
  {
    name: TABLES.familyMemberships,
    keySchema: { partitionKey: 'familyId', sortKey: 'userId' },
    indexes: { byUser: { partitionKey: 'userId', sortKey: 'familyId' } },
  },
  {
    name: TABLES.subscriptions,
    keySchema: { partitionKey: 'userId' },
    indexes: { byFamily: { partitionKey: 'familyId', sortKey: 'userId' } },
  },
  {
    name: TABLES.auditEvents,
    keySchema: { partitionKey: 'targetUserId', sortKey: 'sk' },
    indexes: {
      byActor: { partitionKey: 'actorUserId', sortKey: 'sk' },
      byFamily: { partitionKey: 'familyId', sortKey: 'sk' },
    },
  },
  { name: TABLES.idempotency, keySchema: { partitionKey: 'idempotencyKey' } },
  {
    name: TABLES.remoteConfiguration,
    keySchema: { partitionKey: 'configKey', sortKey: 'version' },
  },
  {
    name: TABLES.deletionJobs,
    keySchema: { partitionKey: 'jobId' },
    indexes: {
      byUser: { partitionKey: 'userId', sortKey: 'requestedAt' },
      byStatus: { partitionKey: 'status', sortKey: 'scheduledFor' },
    },
  },
];

/** v4-shaped, hex-only, and stable across runs so failures are readable. */
export function testUuid(group: number, sequence: number): string {
  return `${group.toString(16).padStart(8, '0')}-0000-4000-8000-${sequence
    .toString(16)
    .padStart(12, '0')}`;
}

export const userIdOf = (n: number): UserId => testUuid(0xa1, n);
export const familyIdOf = (n: number): FamilyId => testUuid(0xb2, n);
export const deviceIdOf = (n: number): DeviceId => testUuid(0xc3, n);

export function createFakeDocumentClient(store: InMemoryDocumentClient): DocumentClient {
  return {
    async get(input) {
      return (await store.send(GetCommand({ ...input }))) as { Item?: Item };
    },
    async put(input) {
      await store.send(PutCommand({ ...input }));
    },
    async update(input) {
      return (await store.send(UpdateCommand({ ...input }))) as { Attributes?: Item };
    },
    async delete(input) {
      await store.send(DeleteCommand({ ...input }));
    },
    async query(input) {
      return (await store.send(QueryCommand({ ...input }))) as {
        Items?: Item[];
        LastEvaluatedKey?: Item;
      };
    },
    async transactWrite(input) {
      await store.send(TransactWriteCommand({ TransactItems: [...input.TransactItems] }));
    },
  };
}

export type Harness = {
  readonly store: InMemoryDocumentClient;
  readonly client: DocumentClient;
  readonly services: ApiServices;
  readonly pipeline: Pipeline;
  readonly logger: Logger;
  readonly logs: LogRecord[];
  readonly config: ApiConfig;
  /** Moves the injected clock, which the token bucket refills against. */
  advance(ms: number): void;
  now(): Date;
  request(input: Partial<HttpRequest> & { method: HttpMethod; path: string }): HttpRequest;
  call(input: Partial<HttpRequest> & { method: HttpMethod; path: string }): Promise<{
    statusCode: number;
    headers: Record<string, string>;
    body: unknown;
  }>;
};

export type HarnessOptions = {
  readonly env?: AppEnv;
  readonly startTime?: string;
};

export function createHarness(options: HarnessOptions = {}): Harness {
  const store = new InMemoryDocumentClient(TABLE_DEFINITIONS);
  const client = createFakeDocumentClient(store);

  let current = new Date(options.startTime ?? '2026-03-01T12:00:00.000Z');
  const clock = (): Date => new Date(current.getTime());

  let idCounter = 0;
  const newId = (): string => {
    idCounter += 1;
    return testUuid(0xf1, idCounter);
  };

  const config: ApiConfig = {
    env: options.env ?? 'development',
    serviceName: 'api',
    logLevel: 'debug',
    userPoolId: 'test-pool',
    userPoolClientId: 'test-client',
    webDomain: 'kinmap.test',
    tables: TABLES,
    auditIpHashSecret: 'test-audit-secret',
    accountDeletionGraceDays: 30,
    metricsNamespace: 'Kinmap/test',
    idempotencyTtlSeconds: 86_400,
    auditRetentionDays: 365,
  };

  const memory = createMemorySink();
  const logger = createLogger({
    service: config.serviceName,
    env: config.env,
    level: 'debug',
    sink: memory.sink,
  });

  const services: ApiServices = {
    config,
    accounts: createAccountsRepository(client, TABLES.users),
    devices: createDevicesRepository(client, TABLES.devices),
    families: createFamiliesRepository(client, TABLES.families),
    memberships: createMembershipsRepository(client, TABLES.familyMemberships),
    subscriptions: createSubscriptionsRepository(client, TABLES.subscriptions),
    audit: createAuditRepository(client, TABLES.auditEvents, config.auditRetentionDays),
    support: createSupportRepository(client, TABLES.auditEvents),
    jobs: createJobsRepository(client, TABLES.deletionJobs),
    places: createPlacesRepository(client, TABLES.savedPlaces),
    liveSessions: createLiveSessionsRepository(client, TABLES.liveSessions),
    notifications: createNotificationsRepository(client, TABLES.notifications),
    notificationPreferences: createNotificationPreferencesRepository(
      client,
      TABLES.notificationPreferences,
    ),
    configuration: createRemoteConfigurationRepository(client, TABLES.remoteConfiguration),
    idempotency: createIdempotencyStore(client, TABLES.idempotency, config.idempotencyTtlSeconds),
    rateLimiter: createTokenBucketRateLimiter(createTokenBucketStore(client, TABLES.idempotency), {
      now: clock,
    }),
    clock,
    newId,
  };

  const pipeline = createPipeline({
    router: createRouter(routes),
    services,
    logger,
    verifier: createFakeVerifier(),
  });

  function request(
    input: Partial<HttpRequest> & { method: HttpMethod; path: string },
  ): HttpRequest {
    return {
      method: input.method,
      path: input.path,
      headers: input.headers ?? {},
      query: input.query ?? {},
      rawBody: input.rawBody ?? null,
      sourceIp: input.sourceIp ?? '203.0.113.7',
      gatewayRequestId: input.gatewayRequestId ?? 'gateway-request-id',
    };
  }

  return {
    store,
    client,
    services,
    pipeline,
    logger,
    logs: memory.records,
    config,
    advance(ms) {
      current = new Date(current.getTime() + ms);
    },
    now: clock,
    request,
    async call(input) {
      const response = await pipeline(request(input));
      return {
        statusCode: response.statusCode,
        headers: response.headers,
        body: response.body === '' ? null : (JSON.parse(response.body) as unknown),
      };
    },
  };
}

/**
 * Stands in for Cognito. The bearer token IS the user id, so a test authenticates
 * as somebody by naming them — there is no key material or signing involved.
 */
export function createFakeVerifier(): TokenVerifier {
  return {
    async verify(token: string): Promise<unknown> {
      return {
        sub: token,
        token_use: 'access',
        iss: 'https://cognito-idp.test/test-pool',
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
        client_id: 'test-client',
      };
    },
  };
}

export function authHeaders(
  userId: UserId,
  extra: Record<string, string> = {},
): Record<string, string> {
  return { authorization: `Bearer ${userId}`, ...extra };
}

/** An `AuthContext` shaped exactly as `verifyAccessToken` would produce one. */
export function authContextFor(input: {
  userId: UserId;
  deviceId?: DeviceId | null;
  requestId?: string;
}): AuthContext {
  return {
    userId: input.userId,
    deviceId: input.deviceId ?? null,
    tokenUse: 'access',
    claims: {
      sub: input.userId,
      token_use: 'access',
      iss: 'https://cognito-idp.test/test-pool',
      exp: 0,
      iat: 0,
    },
    requestId: input.requestId ?? 'test-request',
  };
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

export function seedUser(
  harness: Harness,
  input: { userId: UserId; status?: string; displayName?: string },
): void {
  const timestamp = harness.now().toISOString();
  harness.store.seed(TABLES.users, [
    {
      userId: input.userId,
      displayName: input.displayName ?? 'Test Person',
      avatarUrl: null,
      email: null,
      phoneNumber: null,
      locale: 'en',
      timeZone: 'UTC',
      status: input.status ?? 'ACTIVE',
      acceptedTermsVersion: '2026-01-01',
      acceptedPrivacyPolicyVersion: '2026-01-01',
      sharingStatus: 'SHARING',
      sharingPausedUntil: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      scheduledPurgeAt: null,
    },
  ]);
}

export function seedFamily(
  harness: Harness,
  input: { familyId: FamilyId; ownerUserId: UserId; name?: string },
): void {
  harness.store.seed(TABLES.families, [
    {
      familyId: input.familyId,
      name: input.name ?? 'Test Family',
      ownerUserId: input.ownerUserId,
      createdAt: harness.now().toISOString(),
    },
  ]);
}

export function seedMembership(
  harness: Harness,
  input: {
    familyId: FamilyId;
    userId: UserId;
    role?: string;
    status?: string;
    sharingStatus?: string;
    visibleToUserIds?: UserId[] | null;
    hiddenFromUserIds?: UserId[];
  },
): void {
  const timestamp = harness.now().toISOString();
  harness.store.seed(TABLES.familyMemberships, [
    {
      familyId: input.familyId,
      userId: input.userId,
      role: input.role ?? 'MEMBER',
      status: input.status ?? 'ACTIVE',
      sharingStatus: input.sharingStatus ?? 'SHARING',
      visibleToUserIds: input.visibleToUserIds ?? null,
      hiddenFromUserIds: input.hiddenFromUserIds ?? [],
      pausedUntil: null,
      pausedScope: null,
      sharingChangedAt: timestamp,
      joinedAt: timestamp,
      updatedAt: timestamp,
    },
  ]);
}

export function seedDevice(
  harness: Harness,
  input: { userId: UserId; deviceId: DeviceId; status?: string },
): void {
  const timestamp = harness.now().toISOString();
  harness.store.seed(TABLES.devices, [
    {
      userId: input.userId,
      deviceId: input.deviceId,
      platform: 'IOS',
      osVersion: '18.2',
      appVersion: '1.0.0',
      appBuild: '100',
      modelIdentifier: 'iPhone16,2',
      deviceName: 'Test Phone',
      status: input.status ?? 'ACTIVE',
      pushToken: null,
      trackingState: 'STATIONARY',
      locale: 'en',
      timeZone: 'UTC',
      health: null,
      registeredAt: timestamp,
      updatedAt: timestamp,
      lastSeenAt: null,
      lastUploadAt: null,
      revokedAt: null,
    },
  ]);
}
