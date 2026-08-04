import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';

import {
  CreateFamilyResponseSchema,
  FamilyNameSchema,
  type CreateFamilyRequest,
} from '@family/schemas';

import {
  Body,
  Button,
  Callout,
  Caption,
  Field,
  LinkButton,
  Screen,
  Stack,
  StatusRow,
  Title,
} from '@/components/ui';
import { currentTimeZone } from '@/features/auth/api';
import { ROUTES } from '@/features/auth/routing';
import { ACCOUNT_QUERY_KEY } from '@/features/auth/session-provider';
import { describeError, request } from '@/lib/api';

/**
 * Creating the family this person will own.
 *
 * THE TIME ZONE IS READ, NOT ASKED. `POST /v1/families` rejects a body without
 * one — `CreateFamilyRequestSchema` is a strict object with `timeZone` required
 * — and the device already knows the answer. Putting a time-zone picker in
 * front of somebody on their first run to collect a value we can derive is a
 * question asked for the server's benefit, not theirs. It is still SHOWN, with
 * what it is used for and where to change it, because reading something off the
 * device silently is the habit that leads to reading other things off the
 * device silently.
 *
 * `currentTimeZone()` is the same helper the auth surface uses and it falls
 * back to UTC rather than sending an identifier the contract would reject.
 *
 * Creating a family shares nothing. It produces a family with one member and an
 * OWNER membership; sharing is a separate, later, explicit decision.
 */

/** Matches `FamilyNameSchema` (1..80). The schema below is the actual gate. */
const NAME_LIMIT_COPY = '80 characters or fewer';

export default function CreateFamilyScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();

  const [name, setName] = useState('');
  const timeZone = useMemo(() => currentTimeZone(), []);

  const trimmedName = name.trim();
  const validatedName = FamilyNameSchema.safeParse(trimmedName);
  const nameTooLong = trimmedName.length > 0 && !validatedName.success;

  /**
   * No `Idempotency-Key` is sent, because `POST /v1/families` does not honour
   * one — `family-service` has no idempotency middleware, unlike the routes
   * served by `services/api`. Sending the header anyway would look like a
   * safeguard in this file while doing nothing on the wire, so the duplicate is
   * prevented where it actually originates: mutations never auto-retry (the
   * root query client sets `mutations: { retry: 0 }`) and the button is busy
   * and disabled for the whole flight, so one intent cannot become two families.
   */
  const createFamily = useMutation({
    mutationFn: (input: CreateFamilyRequest) =>
      request({
        method: 'POST',
        path: '/v1/families',
        body: input,
        schema: CreateFamilyResponseSchema,
      }),
    onSuccess: async () => {
      // The account snapshot is what the routing guard reads `familyIds` from,
      // so it is refreshed BEFORE navigating. Awaiting it here also keeps the
      // button in its busy state until the app genuinely knows the family
      // exists, rather than flashing the next screen against stale state.
      await queryClient.invalidateQueries({ queryKey: ACCOUNT_QUERY_KEY });
      router.replace(ROUTES.locationPrimer);
    },
  });

  return (
    <Screen
      footer={
        <Button
          accessibilityHint="Creates the family and moves on to how location sharing works. Creating a family does not share your location."
          busy={createFamily.isPending}
          disabled={!validatedName.success}
          label="Create family"
          onPress={() => {
            if (!validatedName.success) return;
            createFamily.mutate({ name: validatedName.data, timeZone });
          }}
          testID="create-family-submit"
        />
      }
      testID="onboarding-create-family"
    >
      <Stack gap="four">
        <LinkButton
          accessibilityHint="Returns to the choice between creating a family and joining one."
          label="Back"
          onPress={() => {
            if (router.canGoBack()) {
              router.back();
              return;
            }
            router.replace(ROUTES.createOrJoin);
          }}
          testID="create-family-back"
        />

        <Stack gap="two">
          <Title>Name your family</Title>
          <Body>
            Everyone you invite sees this name, so pick something they will recognise. You can
            rename it later.
          </Body>
        </Stack>

        <Field
          autoCapitalize="words"
          autoCorrect={false}
          editable={!createFamily.isPending}
          error={nameTooLong ? `That name is too long — please use ${NAME_LIMIT_COPY}.` : null}
          helper="For example, the family surname or the household name."
          label="Family name"
          onChangeText={setName}
          onSubmitEditing={() => {
            if (!validatedName.success || createFamily.isPending) return;
            createFamily.mutate({ name: validatedName.data, timeZone });
          }}
          returnKeyType="done"
          testID="create-family-name"
          value={name}
        />

        <StatusRow
          detail="Read from this device so arrival times read in your family's local time. You can change it in Settings later."
          label="Time zone"
          testID="create-family-time-zone"
          value={timeZone}
        />

        <Callout title="This does not start sharing" tone="info">
          You will be the only person in this family until you invite someone and they accept. Your
          location is not shared with anyone until you turn sharing on, which is the next step and
          is yours to decline.
        </Callout>

        {createFamily.isError ? (
          <Callout
            title="We could not create the family"
            tone="danger"
            testID="create-family-error"
          >
            {describeError(createFamily.error)}
          </Callout>
        ) : null}

        <Caption>
          A family is just a group of people who have agreed to share with each other. Nobody
          outside it can see anything.
        </Caption>
      </Stack>
    </Screen>
  );
}
