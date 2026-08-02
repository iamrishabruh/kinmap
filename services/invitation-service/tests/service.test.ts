import { beforeEach, describe, expect, it } from 'vitest';

import { buildAuthorizationChecker } from '@family/auth';
import { LIMITS, type AppError } from '@family/contracts';
import { createLogger, createMemorySink } from '@family/observability';
import {
  AcceptInvitationResponseSchema,
  CreateInvitationResponseSchema,
  ListInvitationsResponseSchema,
  PreviewInvitationResponseSchema,
} from '@family/schemas';

import { hashInvitationToken } from '../src/domain/token.js';
import { createInMemoryRateLimiter } from '../src/repositories/rate-limiter.js';
import {
  acceptInvitation,
  createInvitation,
  listInvitations,
  previewInvitation,
  revokeInvitation,
  type InvitationDependencies,
} from '../src/service.js';

import {
  ADMIN,
  authContext,
  FAMILY_ID,
  InMemoryAccounts,
  InMemoryDevices,
  InMemoryFamilies,
  InMemoryInvitations,
  InMemoryMemberships,
  InMemorySubscriptions,
  membershipSummary,
  newId,
  NOW,
  OUTSIDER,
  OWNER,
  RECIPIENT,
  RecordingAudit,
  SECOND_RECIPIENT,
} from './fixtures.js';

type Harness = {
  deps: InvitationDependencies;
  invitations: InMemoryInvitations;
  memberships: InMemoryMemberships;
  audit: RecordingAudit;
  logLines: string[];
};

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (thrown) {
    return thrown as AppError;
  }
  throw new Error('Expected the operation to be rejected.');
}

function harness(options: { now?: () => Date } = {}): Harness {
  const accounts = new InMemoryAccounts()
    .add(OWNER)
    .add(ADMIN)
    .add(RECIPIENT)
    .add(SECOND_RECIPIENT)
    .add(OUTSIDER);

  const devices = new InMemoryDevices()
    .add(OWNER)
    .add(ADMIN)
    .add(RECIPIENT)
    .add(SECOND_RECIPIENT)
    .add(OUTSIDER);

  const memberships = new InMemoryMemberships()
    .seed(membershipSummary({ userId: OWNER, role: 'OWNER', displayName: 'Rishabh' }))
    .seed(membershipSummary({ userId: ADMIN, role: 'ADMIN' }));

  const invitations = new InMemoryInvitations(memberships);
  const audit = new RecordingAudit();
  const memory = createMemorySink();
  const subscriptions = new InMemorySubscriptions();
  const now = options.now ?? ((): Date => NOW);

  return {
    invitations,
    memberships,
    audit,
    logLines: memory.lines,
    deps: {
      checker: buildAuthorizationChecker({
        accounts,
        devices,
        memberships,
        subscriptions,
        rateLimiter: createInMemoryRateLimiter(() => now().getTime()),
        now,
      }),
      accounts,
      subscriptions,
      families: new InMemoryFamilies(),
      memberships,
      invitations,
      rateLimiter: createInMemoryRateLimiter(() => now().getTime()),
      audit,
      logger: createLogger({
        service: 'invitation-service',
        env: 'development',
        sink: memory.sink,
      }),
      now,
      newId,
      inviteLinkBaseUrl: 'https://kinmap.example/invite',
    },
  };
}

async function issue(context: Harness, actor = OWNER): Promise<{ token: string }> {
  const response = await createInvitation(
    {
      auth: authContext(actor),
      familyId: FAMILY_ID,
      body: {
        role: 'MEMBER',
        label: null,
        expiresInHours: LIMITS.INVITATION_TTL_HOURS,
        maxRedemptions: 1,
      },
    },
    context.deps,
  );
  return { token: response.token };
}

describe('createInvitation', () => {
  let context: Harness;

  beforeEach(() => {
    context = harness();
  });

  it('returns the token exactly once, as a universal link', async () => {
    const response = await createInvitation(
      {
        auth: authContext(OWNER),
        familyId: FAMILY_ID,
        body: { role: 'ADULT', label: 'Grandma', expiresInHours: 24, maxRedemptions: 1 },
      },
      context.deps,
    );

    expect(CreateInvitationResponseSchema.parse(response)).toEqual(response);
    expect(response.inviteUrl).toBe(`https://kinmap.example/invite/${response.token}`);
    expect(response.invitation.role).toBe('ADULT');
    expect(response.invitation.maxRedemptions).toBe(1);
    expect(response.invitation.status).toBe('PENDING');
    // The resource itself carries no credential.
    expect(JSON.stringify(response.invitation)).not.toContain(response.token);
  });

  it('NEVER persists or logs the raw token — only its SHA-256 hash', async () => {
    const response = await createInvitation(
      {
        auth: authContext(OWNER),
        familyId: FAMILY_ID,
        body: { role: 'MEMBER', label: null, expiresInHours: 24, maxRedemptions: 1 },
      },
      context.deps,
    );

    const persisted = JSON.stringify(context.invitations.writes);
    const logged = context.logLines.join('\n');
    const audited = JSON.stringify(context.audit.events);

    expect(persisted).not.toContain(response.token);
    expect(logged).not.toContain(response.token);
    expect(audited).not.toContain(response.token);
    expect(logged).not.toContain(response.inviteUrl);

    // What IS stored is the hash, and it is the row's key.
    const stored = context.invitations.records.get(hashInvitationToken(response.token));
    expect(stored).toBeDefined();
    expect(stored?.tokenHash).toBe(hashInvitationToken(response.token));
    expect(persisted).toContain(stored?.tokenHash);
  });

  it('binds the family and the intended role to the token', async () => {
    const response = await createInvitation(
      {
        auth: authContext(OWNER),
        familyId: FAMILY_ID,
        body: { role: 'ADMIN', label: null, expiresInHours: 24, maxRedemptions: 1 },
      },
      context.deps,
    );

    const stored = context.invitations.records.get(hashInvitationToken(response.token));
    expect(stored?.familyId).toBe(FAMILY_ID);
    expect(stored?.role).toBe('ADMIN');
    expect(stored?.maxRedemptions).toBe(LIMITS.MAX_INVITATION_REDEMPTIONS);
    expect(stored?.expiresAt).toBeGreaterThan(Math.floor(NOW.getTime() / 1000));
  });

  it('refuses an invitation from an ordinary member', async () => {
    context.memberships.seed(membershipSummary({ userId: RECIPIENT, role: 'MEMBER' }));

    const error = await rejection(issue(context, RECIPIENT));
    expect(error.code).toBe('FORBIDDEN');
  });

  it('refuses an invitation from someone outside the family', async () => {
    const error = await rejection(issue(context, OUTSIDER));
    expect(error.code).toBe('FORBIDDEN');
  });

  it('caps the number of open invitations a family may hold', async () => {
    // A plan with enough seats that the invitation cap, not the seat cap, is
    // what stops the tenth link being minted.
    const roomy: Harness = {
      ...context,
      deps: { ...context.deps, subscriptions: new InMemorySubscriptions('FAMILY_PLUS_ANNUAL') },
    };

    for (let attempt = 0; attempt < LIMITS.MAX_ACTIVE_INVITATIONS_PER_FAMILY; attempt += 1) {
      await issue(roomy);
    }

    const error = await rejection(issue(roomy));
    expect(error.code).toBe('RATE_LIMITED');
    expect(error.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('rate-limits bursts of invitation creation per family', async () => {
    const bursty: Harness = {
      ...context,
      deps: {
        ...context.deps,
        subscriptions: new InMemorySubscriptions('FAMILY_PLUS_ANNUAL'),
        // The per-minute limiter is keyed by family, not by admin, so two
        // admins share one budget.
        rateLimiter: createInMemoryRateLimiter(() => NOW.getTime()),
      },
    };

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await issue(bursty, attempt % 2 === 0 ? OWNER : ADMIN);
    }

    const error = await rejection(issue(bursty, ADMIN));
    expect(error.code).toBe('RATE_LIMITED');
  });

  it('counts an open invitation against the plan seat limit', async () => {
    const free = harness();
    const capped = {
      ...free.deps,
      subscriptions: new InMemorySubscriptions('FREE', 'EXPIRED'),
    };

    // FREE allows two members; the family already has two.
    const error = await rejection(
      createInvitation(
        {
          auth: authContext(OWNER),
          familyId: FAMILY_ID,
          body: { role: 'MEMBER', label: null, expiresInHours: 24, maxRedemptions: 1 },
        },
        capped,
      ),
    );

    expect(error.code).toBe('PLAN_LIMIT_EXCEEDED');
  });

  it('records an audit event that does not contain the token', async () => {
    const response = await createInvitation(
      {
        auth: authContext(OWNER),
        familyId: FAMILY_ID,
        body: { role: 'MEMBER', label: null, expiresInHours: 24, maxRedemptions: 1 },
      },
      context.deps,
    );

    const entry = context.audit.events.find((event) => event.action === 'INVITATION_CREATED');
    expect(entry).toBeDefined();
    expect(JSON.stringify(entry)).not.toContain(response.token);
  });
});

describe('listInvitations', () => {
  it('never includes a token or a hash', async () => {
    const context = harness();
    const { token } = await issue(context);

    const response = await listInvitations(
      { auth: authContext(OWNER), familyId: FAMILY_ID, query: { status: 'PENDING' } },
      context.deps,
    );

    expect(ListInvitationsResponseSchema.parse(response)).toEqual(response);
    expect(response.invitations).toHaveLength(1);
    const serialized = JSON.stringify(response);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain(hashInvitationToken(token));
  });
});

describe('previewInvitation', () => {
  let context: Harness;

  beforeEach(() => {
    context = harness();
  });

  it('discloses the family and the permissions being granted, and nothing more', async () => {
    const { token } = await issue(context);

    const preview = await previewInvitation({ auth: authContext(RECIPIENT), token }, context.deps);

    expect(PreviewInvitationResponseSchema.parse(preview)).toEqual(preview);
    expect(preview.familyName).toBe('The Chouhans');
    expect(preview.invitedByDisplayName).toBe('Rishabh');
    expect(preview.role).toBe('MEMBER');
    expect(preview.memberCount).toBe(2);
    // No member list, no emails, no positions.
    expect(Object.keys(preview).sort()).toEqual([
      'expiresAt',
      'familyName',
      'invitedByDisplayName',
      'memberCount',
      'role',
    ]);
  });

  it('does not create a membership', async () => {
    const { token } = await issue(context);
    const before = context.memberships.rows.length;

    await previewInvitation({ auth: authContext(RECIPIENT), token }, context.deps);

    expect(context.memberships.rows).toHaveLength(before);
  });

  it('requires an authenticated recipient with a live account', async () => {
    const { token } = await issue(context);
    const unknownUser = '99999999-9999-4999-8999-999999999999' as typeof RECIPIENT;

    const error = await rejection(
      previewInvitation({ auth: authContext(unknownUser), token }, context.deps),
    );
    expect(error.code).toBe('FORBIDDEN');
  });

  it('rejects a token that was never issued', async () => {
    const error = await rejection(
      previewInvitation({ auth: authContext(RECIPIENT), token: 'not-a-real-token' }, context.deps),
    );
    expect(error.code).toBe('INVITATION_INVALID');
  });
});

describe('acceptInvitation', () => {
  let context: Harness;

  beforeEach(() => {
    context = harness();
  });

  const acceptBody = {
    displayName: 'Nani',
    acceptedTermsVersion: '2026-01-01',
    startSharingImmediately: false,
  };

  it('creates the membership and consumes the token', async () => {
    const { token } = await issue(context);

    const response = await acceptInvitation(
      { auth: authContext(RECIPIENT), token, body: acceptBody },
      context.deps,
    );

    expect(AcceptInvitationResponseSchema.parse(response)).toEqual(response);
    expect(response.familyId).toBe(FAMILY_ID);
    expect(response.membership.role).toBe('MEMBER');
    // Joining a family does not start sharing.
    expect(response.membership.sharingStatus).toBe('NEVER_ENABLED');

    const stored = context.invitations.records.get(hashInvitationToken(token));
    expect(stored?.status).toBe('ACCEPTED');
    expect(stored?.redemptionCount).toBe(1);
    expect(stored?.acceptedByUserId).toBe(RECIPIENT);
  });

  it('starts sharing only when the recipient opts in', async () => {
    const { token } = await issue(context);

    const response = await acceptInvitation(
      {
        auth: authContext(RECIPIENT),
        token,
        body: { ...acceptBody, startSharingImmediately: true },
      },
      context.deps,
    );

    expect(response.membership.sharingStatus).toBe('SHARING');
  });

  it('rejects a second use of the same link', async () => {
    const { token } = await issue(context);
    await acceptInvitation({ auth: authContext(RECIPIENT), token, body: acceptBody }, context.deps);

    const error = await rejection(
      acceptInvitation(
        { auth: authContext(SECOND_RECIPIENT), token, body: acceptBody },
        context.deps,
      ),
    );

    expect(error.code).toBe('INVITATION_ALREADY_USED');
    expect(context.memberships.rows.filter((row) => row.userId === SECOND_RECIPIENT)).toHaveLength(
      0,
    );
  });

  it('yields exactly one membership under concurrent double-redemption', async () => {
    const { token } = await issue(context);

    // Both requests pass every pre-check against the same unconsumed token; the
    // single conditional transaction is what has to separate them.
    const outcomes = await Promise.allSettled([
      acceptInvitation({ auth: authContext(RECIPIENT), token, body: acceptBody }, context.deps),
      acceptInvitation(
        { auth: authContext(SECOND_RECIPIENT), token, body: acceptBody },
        context.deps,
      ),
    ]);

    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult | undefined)?.reason).toMatchObject({
      code: 'INVITATION_ALREADY_USED',
    });

    const newMembers = context.memberships.rows.filter(
      (row) => row.userId === RECIPIENT || row.userId === SECOND_RECIPIENT,
    );
    expect(newMembers).toHaveLength(1);
    expect(context.invitations.records.get(hashInvitationToken(token))?.redemptionCount).toBe(1);
  });

  it('rejects a revoked invitation', async () => {
    const { token } = await issue(context);
    const stored = context.invitations.records.get(hashInvitationToken(token));
    expect(stored).toBeDefined();

    await revokeInvitation(
      { auth: authContext(OWNER), familyId: FAMILY_ID, invitationId: stored?.invitationId ?? '' },
      context.deps,
    );

    const error = await rejection(
      acceptInvitation({ auth: authContext(RECIPIENT), token, body: acceptBody }, context.deps),
    );

    expect(error.code).toBe('INVITATION_REVOKED');
    expect(context.memberships.rows.filter((row) => row.userId === RECIPIENT)).toHaveLength(0);
    expect(context.audit.events.some((event) => event.action === 'INVITATION_REVOKED')).toBe(true);
  });

  it('rejects an expired invitation', async () => {
    let clock = NOW;
    const timed = harness({ now: () => clock });
    const { token } = await issue(timed);

    // Walk past the link's lifetime.
    clock = new Date(NOW.getTime() + (LIMITS.INVITATION_TTL_HOURS + 1) * 3_600_000);

    const error = await rejection(
      acceptInvitation({ auth: authContext(RECIPIENT), token, body: acceptBody }, timed.deps),
    );

    expect(error.code).toBe('INVITATION_EXPIRED');
    expect(timed.memberships.rows.filter((row) => row.userId === RECIPIENT)).toHaveLength(0);
  });

  it('rejects a token that hashes to nothing stored', async () => {
    await issue(context);

    const error = await rejection(
      acceptInvitation(
        { auth: authContext(RECIPIENT), token: 'forged-token-value', body: acceptBody },
        context.deps,
      ),
    );

    expect(error.code).toBe('INVITATION_INVALID');
  });

  it('refuses to add someone who is already a member', async () => {
    const { token } = await issue(context);

    const error = await rejection(
      acceptInvitation({ auth: authContext(ADMIN), token, body: acceptBody }, context.deps),
    );

    expect(error.code).toBe('CONFLICT');
  });

  it('records an audit event and never logs the token', async () => {
    const { token } = await issue(context);
    await acceptInvitation({ auth: authContext(RECIPIENT), token, body: acceptBody }, context.deps);

    expect(context.audit.events.some((event) => event.action === 'INVITATION_ACCEPTED')).toBe(true);
    expect(context.logLines.join('\n')).not.toContain(token);
    expect(JSON.stringify(context.audit.events)).not.toContain(token);
  });

  it('refuses when the family has no room left', async () => {
    const capped = harness();
    const limited = { ...capped.deps, subscriptions: new InMemorySubscriptions('FREE', 'EXPIRED') };

    // Issue while entitled, then downgrade before acceptance.
    const { token } = await issue(capped);

    const error = await rejection(
      acceptInvitation({ auth: authContext(RECIPIENT), token, body: acceptBody }, limited),
    );

    expect(error.code).toBe('PLAN_LIMIT_EXCEEDED');
  });
});
