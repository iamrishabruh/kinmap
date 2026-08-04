import type { Logger } from '@family/observability';

import type { AuthEventsConfig } from './env.js';
import {
  isCustomMessage,
  isPostConfirmation,
  isPreSignUp,
  isTokenGeneration,
  type UnknownTriggerEvent,
} from './events.js';
import { handleCustomMessage } from './triggers/custom-message.js';
import { handlePostConfirmation } from './triggers/post-confirmation.js';
import { handlePreSignUp } from './triggers/pre-signup.js';
import { handlePreTokenGeneration } from './triggers/pre-token-generation.js';
import type { UserProfileRepository } from './users-repository.js';

/**
 * Trigger dispatch, with its dependencies injected.
 *
 * Kept out of `handler.ts` on purpose: the composition root creates a DynamoDB
 * client at module scope, and a unit test that imported it would drag the AWS
 * SDK — and a credential provider — into the process just to check what a
 * custom message says.
 *
 * Cognito's contract is that the handler returns the event, mutated where the
 * trigger has a response to give, so every branch returns an event rather than a
 * value of its own. An unrecognised trigger source is passed through untouched:
 * it means the pool gained a trigger this code has not learned yet, and refusing
 * it would take sign-in down over something this function has no opinion about.
 *
 * A trigger that *does* fail fails loudly. Pre sign-up rejecting a stale terms
 * acceptance is the intended behaviour, not an outage.
 */

export type AuthEventsDependencies = {
  readonly config: AuthEventsConfig;
  readonly users: UserProfileRepository;
  readonly logger: Logger;
  readonly now: () => Date;
};

export type TriggerHandler = (event: UnknownTriggerEvent) => Promise<UnknownTriggerEvent>;

export function createTriggerHandler(dependencies: AuthEventsDependencies): TriggerHandler {
  return async function dispatch(event: UnknownTriggerEvent): Promise<UnknownTriggerEvent> {
    const logger = dependencies.logger.child({ triggerSource: event.triggerSource });

    if (isPreSignUp(event)) {
      return handlePreSignUp(event, dependencies.config);
    }

    if (isPostConfirmation(event)) {
      return handlePostConfirmation(event, {
        config: dependencies.config,
        users: dependencies.users,
        logger,
        now: dependencies.now,
      });
    }

    if (isTokenGeneration(event)) {
      return await handlePreTokenGeneration(event, {
        config: dependencies.config,
        users: dependencies.users,
        logger,
        now: dependencies.now,
      });
    }

    if (isCustomMessage(event)) {
      return handleCustomMessage(event, dependencies.config);
    }

    logger.warn('unhandled_trigger_source');
    return event;
  };
}
