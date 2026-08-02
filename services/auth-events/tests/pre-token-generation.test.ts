import { beforeEach, describe, expect, it } from 'vitest';

import { TOKEN_GENERATION_SOURCES } from '../src/events.js';
import { SUPPRESSED_CLAIMS } from '../src/triggers/pre-token-generation.js';

import { createHarness, tokenGenerationEvent, type Harness } from './support/harness.js';

/**
 * The rule this trigger exists to keep is negative: no authorization decision is
 * ever carried in a token. These tests assert the absence, because that is the
 * property a future change is most likely to break — adding "just the family id"
 * to a claim is a one-line change that quietly makes a removed member's access
 * survive until their token expires.
 */

/** Anything a reviewer would consider an authorization fact. */
const FORBIDDEN_CLAIM_PATTERN =
  /famil|member|role|owner|admin|sharing|visib|permission|scope_|entitle|plan|tier|device_id/i;

describe('preTokenGeneration', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness();
  });

  it('adds only inert claims', async () => {
    const result = await harness.handle(tokenGenerationEvent());

    const claims = (
      result.response as {
        claimsOverrideDetails?: { claimsToAddOrOverride?: Record<string, string> };
      }
    ).claimsOverrideDetails?.claimsToAddOrOverride;

    expect(claims).toEqual({ app_env: 'development', profile_schema_version: '1' });
  });

  it('never emits a claim that looks like an authorization decision', async () => {
    for (const triggerSource of TOKEN_GENERATION_SOURCES) {
      const result = await harness.handle(tokenGenerationEvent({ triggerSource }));

      const claims = (
        result.response as {
          claimsOverrideDetails?: { claimsToAddOrOverride?: Record<string, string> };
        }
      ).claimsOverrideDetails?.claimsToAddOrOverride;

      for (const [key, value] of Object.entries(claims ?? {})) {
        expect(key).not.toMatch(FORBIDDEN_CLAIM_PATTERN);
        expect(value).not.toMatch(FORBIDDEN_CLAIM_PATTERN);
      }
    }
  });

  it('suppresses the profile claims the product never uses', async () => {
    const result = await harness.handle(tokenGenerationEvent());

    const suppressed = (
      result.response as { claimsOverrideDetails?: { claimsToSuppress?: string[] } }
    ).claimsOverrideDetails?.claimsToSuppress;

    expect(suppressed).toEqual([...SUPPRESSED_CLAIMS]);
    expect(suppressed).toContain('phone_number');
    expect(suppressed).toContain('address');
  });

  it('does not override group membership', async () => {
    const result = await harness.handle(tokenGenerationEvent());

    const details = (
      result.response as { claimsOverrideDetails?: { groupOverrideDetails?: unknown } }
    ).claimsOverrideDetails;

    // Present-but-empty would silently drop whatever the pool assigned.
    expect(details).not.toHaveProperty('groupOverrideDetails');
  });

  it('leaves the rest of the event untouched', async () => {
    const event = tokenGenerationEvent();

    const result = await harness.handle(event);

    expect(result.userName).toBe(event.userName);
    expect(result.userPoolId).toBe(event.userPoolId);
    expect(result.triggerSource).toBe(event.triggerSource);
  });

  it('reads nothing from the database', async () => {
    await harness.handle(tokenGenerationEvent());

    // Token generation sits in the sign-in latency path; it must not depend on a
    // table read, and it must not be able to leak one into a claim.
    expect(harness.store.size('Users')).toBe(0);
  });
});
