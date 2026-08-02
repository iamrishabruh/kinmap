import { beforeEach, describe, expect, it } from 'vitest';

import { buildAuthorizationChecker } from '@family/auth';
import type { AppError } from '@family/contracts';
import { createLogger, createMemorySink } from '@family/observability';
import {
  CreateFamilyResponseSchema,
  GetFamilyResponseSchema,
  RemoveFamilyMemberResponseSchema,
  TransferFamilyOwnershipResponseSchema,
} from '@family/schemas';

import { createInMemoryRateLimiter } from '../src/repositories/rate-limiter.js';
import {
  blockUser,
  createFamily,
  getFamily,
  removeFamilyMember,
  reportAbuse,
  transferFamilyOwnership,
  updateFamilyMember,
  type FamilyServiceDependencies,
} from '../src/service.js';

import {
  ADMIN,
  authContext,
  FAMILY_ID,
  familyRecord,
  InMemoryAccounts,
  InMemoryDevices,
  InMemoryFamilies,
  InMemoryMemberships,
  InMemorySubscriptions,
  MEMBER,
  membershipRow,
  newId,
  NOW,
  OUTSIDER,
  OWNER,
  RecordingAudit,
  RecordingEvents,
  SECOND_ADMIN,
} from './fixtures.js';

type Harness = {
  deps: FamilyServiceDependencies;
  families: InMemoryFamilies;
  memberships: InMemoryMemberships;
  events: RecordingEvents;
  audit: RecordingAudit;
  logLines: string[];
};

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (thrown) {
    return thrown as AppError;
  }
  throw new Error('Expected the operation to be denied.');
}

function harness(): Harness {
  const accounts = new InMemoryAccounts()
    .add(OWNER)
    .add(ADMIN)
    .add(MEMBER)
    .add(SECOND_ADMIN)
    .add(OUTSIDER);

  const devices = new InMemoryDevices()
    .add(OWNER)
    .add(ADMIN)
    .add(MEMBER)
    .add(SECOND_ADMIN)
    .add(OUTSIDER);

  const memberships = new InMemoryMemberships()
    .seed(membershipRow({ userId: OWNER, role: 'OWNER' }))
    .seed(membershipRow({ userId: ADMIN, role: 'ADMIN' }))
    .seed(membershipRow({ userId: MEMBER, role: 'MEMBER' }))
    .seed(membershipRow({ userId: SECOND_ADMIN, role: 'ADMIN' }));

  const families = new InMemoryFamilies(memberships).seed(familyRecord());
  const events = new RecordingEvents();
  const audit = new RecordingAudit();
  const memory = createMemorySink();
  const subscriptions = new InMemorySubscriptions();

  return {
    families,
    memberships,
    events,
    audit,
    logLines: memory.lines,
    deps: {
      checker: buildAuthorizationChecker({
        accounts,
        devices,
        memberships,
        subscriptions,
        rateLimiter: createInMemoryRateLimiter(() => NOW.getTime()),
        now: () => NOW,
      }),
      accounts,
      families,
      memberships,
      subscriptions,
      events,
      audit,
      logger: createLogger({ service: 'family-service', env: 'development', sink: memory.sink }),
      now: () => NOW,
      newId,
      safetyResourcesUrl: 'https://example.test/safety',
    },
  };
}

describe('createFamily', () => {
  it('makes the creator the sole owner, with sharing off until they opt in', async () => {
    const context = harness();
    context.families.records.clear();
    context.memberships.rows.length = 0;

    const response = await createFamily(
      { auth: authContext(OWNER), body: { name: 'New Family', timeZone: 'Europe/London' } },
      context.deps,
    );

    expect(CreateFamilyResponseSchema.parse(response)).toEqual(response);
    expect(response.membership.role).toBe('OWNER');
    expect(response.membership.sharingStatus).toBe('NEVER_ENABLED');
    expect(response.family.ownerUserId).toBe(OWNER);
    expect(context.events.of('FAMILY_CREATED')).toHaveLength(1);
  });

  it('refuses a second family when the plan allows one', async () => {
    const context = harness();
    const free = { ...context.deps, subscriptions: new InMemorySubscriptions('FREE', 'EXPIRED') };

    const error = await rejection(
      createFamily(
        { auth: authContext(OWNER), body: { name: 'Another', timeZone: 'Europe/London' } },
        free,
      ),
    );

    expect(error.code).toBe('PLAN_LIMIT_EXCEEDED');
  });
});

describe('getFamily', () => {
  it('shows every member and the caller’s own role', async () => {
    const context = harness();

    const response = await getFamily(
      { auth: authContext(MEMBER), familyId: FAMILY_ID },
      context.deps,
    );

    expect(GetFamilyResponseSchema.parse(response)).toEqual(response);
    expect(response.callerRole).toBe('MEMBER');
    expect(response.members).toHaveLength(4);
    // Membership responses carry sharing status, never a position.
    expect(JSON.stringify(response)).not.toContain('latitude');
  });

  it('denies an outsider opaquely', async () => {
    const context = harness();

    const error = await rejection(
      getFamily({ auth: authContext(OUTSIDER), familyId: FAMILY_ID }, context.deps),
    );

    expect(error.code).toBe('FORBIDDEN');
    expect(error.message).toBe('You do not have access to this resource.');
  });
});

describe('removeFamilyMember', () => {
  let context: Harness;

  beforeEach(() => {
    context = harness();
  });

  it('revokes location access in the same write as the removal', async () => {
    const response = await removeFamilyMember(
      { auth: authContext(ADMIN), familyId: FAMILY_ID, targetUserId: MEMBER, deleteHistory: true },
      context.deps,
    );

    expect(RemoveFamilyMemberResponseSchema.parse(response)).toEqual(response);
    expect(response.status).toBe('REMOVED');

    const row = context.memberships.find(FAMILY_ID, MEMBER);
    expect(row?.status).toBe('REMOVED');
    // Not merely inactive: sharing is off and the allow-list names nobody, so a
    // check that raced the removal still fails.
    expect(row?.sharingStatus).toBe('DISABLED');
    expect(row?.visibleToUserIds).toEqual([]);
  });

  it('emits an event telling clients to purge cached locations', async () => {
    await removeFamilyMember(
      { auth: authContext(ADMIN), familyId: FAMILY_ID, targetUserId: MEMBER, deleteHistory: false },
      context.deps,
    );

    const [event] = context.events.of('MEMBERSHIP_ENDED');
    expect(event?.purgeCachedLocations).toBe(true);
    expect(event?.userId).toBe(MEMBER);
    expect(event?.status).toBe('REMOVED');
  });

  it('records an audit event for the removal', async () => {
    await removeFamilyMember(
      { auth: authContext(ADMIN), familyId: FAMILY_ID, targetUserId: MEMBER, deleteHistory: false },
      context.deps,
    );

    const entry = context.audit.events.find((event) => event.action === 'MEMBER_REMOVED');
    expect(entry?.actorUserId).toBe(ADMIN);
    expect(entry?.targetUserId).toBe(MEMBER);
  });

  it('treats a self-removal as leaving', async () => {
    const response = await removeFamilyMember(
      {
        auth: authContext(MEMBER),
        familyId: FAMILY_ID,
        targetUserId: MEMBER,
        deleteHistory: false,
      },
      context.deps,
    );

    expect(response.status).toBe('LEFT');
    expect(context.memberships.find(FAMILY_ID, MEMBER)?.status).toBe('LEFT');
  });

  it('refuses to remove the owner', async () => {
    const error = await rejection(
      removeFamilyMember(
        {
          auth: authContext(ADMIN),
          familyId: FAMILY_ID,
          targetUserId: OWNER,
          deleteHistory: false,
        },
        context.deps,
      ),
    );

    expect(error.code).toBe('FORBIDDEN');
    expect(context.memberships.find(FAMILY_ID, OWNER)?.status).toBe('ACTIVE');
  });

  it('refuses to let the owner leave without transferring first', async () => {
    const error = await rejection(
      removeFamilyMember(
        {
          auth: authContext(OWNER),
          familyId: FAMILY_ID,
          targetUserId: OWNER,
          deleteHistory: false,
        },
        context.deps,
      ),
    );

    expect(error.code).toBe('CONFLICT');
    expect(context.memberships.find(FAMILY_ID, OWNER)?.role).toBe('OWNER');
  });

  it('refuses an admin removing a peer admin', async () => {
    const error = await rejection(
      removeFamilyMember(
        {
          auth: authContext(ADMIN),
          familyId: FAMILY_ID,
          targetUserId: SECOND_ADMIN,
          deleteHistory: false,
        },
        context.deps,
      ),
    );

    expect(error.code).toBe('FORBIDDEN');
  });

  it('refuses an ordinary member removing someone else', async () => {
    const error = await rejection(
      removeFamilyMember(
        {
          auth: authContext(MEMBER),
          familyId: FAMILY_ID,
          targetUserId: SECOND_ADMIN,
          deleteHistory: false,
        },
        context.deps,
      ),
    );

    expect(error.code).toBe('FORBIDDEN');
  });
});

describe('transferFamilyOwnership', () => {
  it('moves ownership and leaves exactly one owner', async () => {
    const context = harness();

    const response = await transferFamilyOwnership(
      { auth: authContext(OWNER), familyId: FAMILY_ID, targetUserId: ADMIN },
      context.deps,
    );

    expect(TransferFamilyOwnershipResponseSchema.parse(response)).toEqual(response);
    expect(context.memberships.find(FAMILY_ID, ADMIN)?.role).toBe('OWNER');
    expect(context.memberships.find(FAMILY_ID, OWNER)?.role).toBe('ADMIN');
    expect(context.families.records.get(FAMILY_ID)?.ownerUserId).toBe(ADMIN);

    const owners = (await context.memberships.listByFamily(FAMILY_ID)).filter(
      (row) => row.role === 'OWNER' && row.status === 'ACTIVE',
    );
    expect(owners).toHaveLength(1);
  });

  it('refuses a transfer attempted by an admin', async () => {
    const context = harness();

    const error = await rejection(
      transferFamilyOwnership(
        { auth: authContext(ADMIN), familyId: FAMILY_ID, targetUserId: MEMBER },
        context.deps,
      ),
    );

    expect(error.code).toBe('FORBIDDEN');
    expect(context.families.records.get(FAMILY_ID)?.ownerUserId).toBe(OWNER);
  });

  it('lets the former owner leave once ownership has moved', async () => {
    const context = harness();

    await transferFamilyOwnership(
      { auth: authContext(OWNER), familyId: FAMILY_ID, targetUserId: ADMIN },
      context.deps,
    );
    const response = await removeFamilyMember(
      { auth: authContext(OWNER), familyId: FAMILY_ID, targetUserId: OWNER, deleteHistory: true },
      context.deps,
    );

    expect(response.status).toBe('LEFT');
  });
});

describe('updateFamilyMember', () => {
  it('lets the owner promote a member', async () => {
    const context = harness();

    const response = await updateFamilyMember(
      {
        auth: authContext(OWNER),
        familyId: FAMILY_ID,
        targetUserId: MEMBER,
        body: { role: 'ADMIN' },
      },
      context.deps,
    );

    expect(response.member.role).toBe('ADMIN');
    expect(context.events.of('MEMBER_ROLE_CHANGED')).toHaveLength(1);
    expect(context.audit.events.some((event) => event.action === 'MEMBER_ROLE_CHANGED')).toBe(true);
  });

  it('refuses to change the owner’s role', async () => {
    const context = harness();

    const error = await rejection(
      updateFamilyMember(
        {
          auth: authContext(OWNER),
          familyId: FAMILY_ID,
          targetUserId: OWNER,
          body: { role: 'ADMIN' },
        },
        context.deps,
      ),
    );

    expect(error.code).toBe('FORBIDDEN');
  });
});

describe('blockUser', () => {
  it('is symmetric: neither party can see the other afterwards', async () => {
    const context = harness();

    await blockUser(
      {
        auth: authContext(MEMBER),
        body: { blockedUserId: ADMIN, removeFromSharedFamilies: false },
      },
      context.deps,
    );

    expect(context.memberships.find(FAMILY_ID, MEMBER)?.hiddenFromUserIds).toContain(ADMIN);
    expect(context.memberships.find(FAMILY_ID, ADMIN)?.hiddenFromUserIds).toContain(MEMBER);
    expect(context.audit.events.some((event) => event.action === 'USER_BLOCKED')).toBe(true);
    expect(context.events.of('USER_BLOCKED')).toHaveLength(1);
  });

  it('lets a member leave the family when they cannot remove the person they blocked', async () => {
    const context = harness();

    const response = await blockUser(
      { auth: authContext(MEMBER), body: { blockedUserId: OWNER, removeFromSharedFamilies: true } },
      context.deps,
    );

    expect(response.block.removedFromSharedFamilies).toBe(true);
    expect(context.memberships.find(FAMILY_ID, MEMBER)?.status).toBe('LEFT');
    // The owner keeps their family; blocking is not a removal power.
    expect(context.memberships.find(FAMILY_ID, OWNER)?.status).toBe('ACTIVE');
  });

  it('removes the blocked member when the blocker outranks them', async () => {
    const context = harness();

    await blockUser(
      { auth: authContext(OWNER), body: { blockedUserId: MEMBER, removeFromSharedFamilies: true } },
      context.deps,
    );

    expect(context.memberships.find(FAMILY_ID, MEMBER)?.status).toBe('REMOVED');
    expect(context.memberships.find(FAMILY_ID, MEMBER)?.sharingStatus).toBe('DISABLED');
  });

  it('refuses to block yourself', async () => {
    const context = harness();

    const error = await rejection(
      blockUser(
        {
          auth: authContext(MEMBER),
          body: { blockedUserId: MEMBER, removeFromSharedFamilies: false },
        },
        context.deps,
      ),
    );

    expect(error.code).toBe('VALIDATION_FAILED');
  });
});

describe('reportAbuse', () => {
  it('records the report, blocks, and offers safety resources', async () => {
    const context = harness();

    const response = await reportAbuse(
      {
        auth: authContext(MEMBER),
        body: {
          reportedUserId: ADMIN,
          familyId: FAMILY_ID,
          category: 'UNWANTED_TRACKING',
          description: 'Being tracked without consent.',
          blockImmediately: true,
          leaveFamily: true,
        },
      },
      context.deps,
    );

    expect(response.blocked).toBe(true);
    expect(response.leftFamily).toBe(true);
    expect(response.safetyResourcesUrl).toBe('https://example.test/safety');
    expect(context.audit.events.some((event) => event.action === 'ABUSE_REPORTED')).toBe(true);
    expect(context.memberships.find(FAMILY_ID, MEMBER)?.status).toBe('LEFT');
  });

  it('reveals nothing about enforcement against the reported account', async () => {
    const context = harness();

    const response = await reportAbuse(
      {
        auth: authContext(MEMBER),
        body: {
          reportedUserId: ADMIN,
          familyId: null,
          category: 'HARASSMENT',
          description: 'Abusive messages.',
          blockImmediately: false,
          leaveFamily: false,
        },
      },
      context.deps,
    );

    expect(Object.keys(response).sort()).toEqual([
      'blocked',
      'leftFamily',
      'reportId',
      'safetyResourcesUrl',
      'submittedAt',
    ]);
    expect(response.safetyResourcesUrl).toBeNull();
  });

  it('does not log the report description', async () => {
    const context = harness();

    await reportAbuse(
      {
        auth: authContext(MEMBER),
        body: {
          reportedUserId: ADMIN,
          familyId: null,
          category: 'HARASSMENT',
          description: 'A very identifying free-text description.',
          blockImmediately: false,
          leaveFamily: false,
        },
      },
      context.deps,
    );

    expect(context.logLines.join('\n')).not.toContain('very identifying');
  });
});
