import { createLogger, createMemorySink, type LogRecord, type Logger } from '@family/observability';
import {
  InMemoryDocumentClient,
  PutCommand,
  TransactWriteCommand,
  type TableDefinition,
} from '@family/test-utils';

import { createTriggerHandler, type AuthEventsDependencies } from '../../src/dispatch.js';
import type { AuthEventsConfig } from '../../src/env.js';
import type {
  CustomMessageEvent,
  CustomMessageSource,
  PostConfirmationEvent,
  PostConfirmationSource,
  PreSignUpEvent,
  PreSignUpSource,
  PreTokenGenerationEvent,
  TokenGenerationSource,
  UserAttributes,
} from '../../src/events.js';
import {
  createUserProfileRepository,
  type DocumentClient,
  type UserProfileRepository,
} from '../../src/users-repository.js';

/**
 * The trigger function wired to the in-memory DynamoDB fake, which really
 * enforces condition expressions and really rolls transactions back — so the
 * idempotency of profile creation is exercised rather than asserted.
 */

export const USERS_TABLE = 'Users';
export const USER_POOL_ID = 'eu-west-2_testpool';

const TABLE_DEFINITIONS: TableDefinition[] = [
  {
    name: USERS_TABLE,
    keySchema: { partitionKey: 'userId' },
    indexes: { byEmailHash: { partitionKey: 'emailHash' } },
  },
];

export const TERMS_VERSION = '2026-02-01';
export const PRIVACY_VERSION = '2026-02-02';

export function testUuid(sequence: number): string {
  return `000000a1-0000-4000-8000-${sequence.toString(16).padStart(12, '0')}`;
}

export function createFakeDocumentClient(store: InMemoryDocumentClient): DocumentClient {
  return {
    async put(input) {
      await store.send(PutCommand({ ...input }));
    },
    async transactWrite(input) {
      await store.send(TransactWriteCommand({ TransactItems: [...input.TransactItems] }));
    },
  };
}

export type Harness = {
  readonly store: InMemoryDocumentClient;
  readonly users: UserProfileRepository;
  readonly config: AuthEventsConfig;
  readonly logs: LogRecord[];
  readonly logger: Logger;
  readonly handle: ReturnType<typeof createTriggerHandler>;
  now(): Date;
};

export function createHarness(overrides: Partial<AuthEventsConfig> = {}): Harness {
  const store = new InMemoryDocumentClient(TABLE_DEFINITIONS);
  const users = createUserProfileRepository(createFakeDocumentClient(store), USERS_TABLE);

  const config: AuthEventsConfig = {
    env: 'development',
    serviceName: 'auth-events',
    logLevel: 'debug',
    appDomain: 'kinmap.test',
    usersTable: USERS_TABLE,
    termsVersion: TERMS_VERSION,
    privacyPolicyVersion: PRIVACY_VERSION,
    emailHashSecret: 'test-email-secret',
    ...overrides,
  };

  const memory = createMemorySink();
  const logger = createLogger({
    service: config.serviceName,
    env: config.env,
    level: 'debug',
    sink: memory.sink,
  });

  const now = (): Date => new Date('2026-03-01T12:00:00.000Z');

  const dependencies: AuthEventsDependencies = { config, users, logger, now };

  return {
    store,
    users,
    config,
    logs: memory.records,
    logger,
    handle: createTriggerHandler(dependencies),
    now,
  };
}

// ---------------------------------------------------------------------------
// Event builders
// ---------------------------------------------------------------------------

const base = {
  version: '1',
  region: 'eu-west-2',
  userPoolId: USER_POOL_ID,
  callerContext: { awsSdkVersion: '3.980.0', clientId: 'test-client' },
} as const;

export function preSignUpEvent(input: {
  triggerSource?: PreSignUpSource;
  userName?: string;
  userAttributes?: UserAttributes;
  validationData?: Record<string, string> | null;
  clientMetadata?: Record<string, string> | null;
}): PreSignUpEvent {
  return {
    ...base,
    triggerSource: input.triggerSource ?? 'PreSignUp_SignUp',
    userName: input.userName ?? 'test-user',
    request: {
      userAttributes: input.userAttributes ?? { email: 'person@example.test' },
      validationData: input.validationData ?? null,
      clientMetadata: input.clientMetadata ?? null,
    },
    response: {},
  };
}

export function currentAcceptance(): Record<string, string> {
  return { termsVersion: TERMS_VERSION, privacyPolicyVersion: PRIVACY_VERSION };
}

export function postConfirmationEvent(input: {
  triggerSource?: PostConfirmationSource;
  userName?: string;
  userAttributes: UserAttributes;
}): PostConfirmationEvent {
  return {
    ...base,
    triggerSource: input.triggerSource ?? 'PostConfirmation_ConfirmSignUp',
    userName: input.userName ?? 'test-user',
    request: { userAttributes: input.userAttributes, clientMetadata: null },
    response: {},
  };
}

export function tokenGenerationEvent(
  input: {
    triggerSource?: TokenGenerationSource;
    userAttributes?: UserAttributes;
  } = {},
): PreTokenGenerationEvent {
  return {
    ...base,
    triggerSource: input.triggerSource ?? 'TokenGeneration_Authentication',
    userName: 'test-user',
    request: {
      userAttributes: input.userAttributes ?? {
        sub: testUuid(1),
        email: 'person@example.test',
        email_verified: 'true',
      },
      groupConfiguration: { groupsToOverride: [], iamRolesToOverride: [], preferredRole: null },
      clientMetadata: null,
    },
    response: {},
  };
}

export function customMessageEvent(input: {
  triggerSource: CustomMessageSource;
  userAttributes?: UserAttributes;
  codeParameter?: string;
}): CustomMessageEvent {
  return {
    ...base,
    triggerSource: input.triggerSource,
    userName: 'test-user',
    request: {
      userAttributes: input.userAttributes ?? {
        sub: testUuid(1),
        email: 'person@example.test',
        name: 'Alex Doe',
      },
      codeParameter: input.codeParameter ?? '{####}',
      usernameParameter: null,
      linkParameter: null,
      clientMetadata: null,
    },
    response: {},
  };
}
