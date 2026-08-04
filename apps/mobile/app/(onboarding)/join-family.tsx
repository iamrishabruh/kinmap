import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMemo, useState } from 'react';

import {
  AcceptInvitationResponseSchema,
  InvitationTokenSchema,
  PreviewInvitationResponseSchema,
  type AcceptInvitationRequest,
  type AssignableFamilyRole,
} from '@family/schemas';

import {
  Body,
  Button,
  Callout,
  Caption,
  Card,
  Field,
  LinkButton,
  Screen,
  Stack,
  StatusRow,
  Title,
} from '@/components/ui';
import { ROUTES } from '@/features/auth/routing';
import { ACCOUNT_QUERY_KEY } from '@/features/auth/session-provider';
import { useSession } from '@/features/auth/use-session';
import { CURRENT_TERMS_VERSION } from '@/features/consent/versions';
import { describeError, request } from '@/lib/api';

/**
 * Joining a family with an invitation.
 *
 * ---------------------------------------------------------------------------
 * THE TOKEN IS A CREDENTIAL
 * ---------------------------------------------------------------------------
 * An invitation token grants membership of a family, which is to say it grants
 * the ability to be shown other people's locations. `@family/schemas` says it
 * must never be logged, echoed in an error, or included in a read response, and
 * this screen holds to that:
 *
 *   - A token arriving from a universal link is NEVER rendered. The screen goes
 *     straight to the preview and says an invitation was received; printing the
 *     credential into a screenshot-able view would be gratuitous.
 *   - It is never interpolated into an error message. Failures show the
 *     server's own wording via `describeError`, which never contains it.
 *   - It does not travel onward. On success this screen is replaced by the next
 *     route, with no parameters at all.
 *   - The preview response is cached with `gcTime: 0`, so neither the token nor
 *     the family name it reveals outlives this screen.
 *
 * ---------------------------------------------------------------------------
 * PREVIEW IS NOT JOINING
 * ---------------------------------------------------------------------------
 * `GET /v1/invitations/{token}` is read-only and creates nothing. Membership is
 * created only by the accept mutation, only from a tap on a button that names
 * the family being joined. Opening a link must never be the act of consent —
 * links get forwarded, mis-tapped and opened out of curiosity, and none of
 * those are agreement to be located.
 *
 * ---------------------------------------------------------------------------
 * JOINING DOES NOT START SHARING
 * ---------------------------------------------------------------------------
 * `startSharingImmediately` is hard-wired to `false`. There is no toggle for it
 * on this screen, pre-ticked or otherwise: bundling "join this family" with
 * "begin transmitting my location" into one tap would be exactly the consent
 * bundling the rest of this codebase refuses. Sharing is asked for separately,
 * on the location primer, where the permission it needs is explained.
 */

/**
 * The token as it appears inside an invitation link: `…/invite/<token>`.
 *
 * People paste whole links at least as often as they paste bare codes, and a
 * link that fails with "that is not a valid code" when it plainly is one is the
 * kind of small dishonesty that makes a person distrust the rest of the screen.
 */
const INVITE_LINK_PATH = /\/invite\/([A-Za-z0-9_-]+)/;

/**
 * Reduces whatever the user has (or the link carried) to a token, or null.
 *
 * Validation is delegated to `InvitationTokenSchema` rather than re-expressed
 * here, so the client and the server agree on what a token is by construction.
 */
function extractInvitationToken(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;

  const direct = InvitationTokenSchema.safeParse(trimmed);
  if (direct.success) return direct.data;

  const embedded = INVITE_LINK_PATH.exec(trimmed)?.[1];
  if (embedded === undefined) return null;

  const fromLink = InvitationTokenSchema.safeParse(embedded);
  return fromLink.success ? fromLink.data : null;
}

/** The enum is never shown raw; `MEMBER` on a first-run screen reads as shouting. */
const ROLE_LABEL: Record<AssignableFamilyRole, string> = {
  ADMIN: 'Admin',
  ADULT: 'Adult',
  MEMBER: 'Member',
};

/**
 * What the invited role actually lets a person do, in the words of
 * `packages/auth`'s policy table rather than a flattering paraphrase. ADULT and
 * MEMBER carry identical permissions there, so they are described identically —
 * inventing a difference to make one sound better would be a lie.
 */
const ROLE_SUMMARY: Record<AssignableFamilyRole, string> = {
  ADMIN: 'You will be able to see the family map, and invite or remove members.',
  ADULT:
    'You will be able to see the family map. Only the owner and admins can change who is in the family.',
  MEMBER:
    'You will be able to see the family map. Only the owner and admins can change who is in the family.',
};

function formatExpiry(isoDateTime: string): string {
  const when = new Date(isoDateTime);
  const day = when.toLocaleDateString(undefined, { day: 'numeric', month: 'long' });
  const time = when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${day} at ${time}`;
}

export default function JoinFamilyScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { account } = useSession();

  const params = useLocalSearchParams();
  const linkedToken = useMemo(
    () => (typeof params.token === 'string' ? extractInvitationToken(params.token) : null),
    [params.token],
  );

  const [typed, setTyped] = useState('');
  const [submittedToken, setSubmittedToken] = useState<string | null>(null);
  /** Set only after a failed attempt, so an untouched field is never scolded. */
  const [showFormatError, setShowFormatError] = useState(false);

  const token = submittedToken ?? linkedToken;

  /**
   * Cache policy mirrors `CACHE_POLICIES.invitationPreview`: nothing is kept
   * (`gcTime: 0`), nothing is refetched behind the user's back, and nothing is
   * retried. `INVITATION_INVALID` is not a transient failure, and the preview
   * and the redemption share the tightest rate-limit ceiling in the contract
   * precisely because token guessing is the cheapest way into a family — so
   * retrying a rejection would spend somebody else's budget to learn nothing.
   */
  const preview = useQuery({
    queryKey: ['invitation-preview', token],
    queryFn: ({ signal }) => {
      if (token === null) throw new Error('An invitation token is required.');
      return request({
        method: 'GET',
        path: `/v1/invitations/${encodeURIComponent(token)}`,
        schema: PreviewInvitationResponseSchema,
        signal,
      });
    },
    enabled: token !== null,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });

  const acceptInvitation = useMutation({
    mutationFn: (input: { token: string }) =>
      request({
        method: 'POST',
        path: `/v1/invitations/${encodeURIComponent(input.token)}/accept`,
        body: {
          // The family sees a name rather than the server's 'Member' fallback.
          displayName: account?.displayName ?? null,
          // A restatement of the acceptance already on this account, not a new
          // consent: the routing guard will not let anyone reach onboarding
          // with an out-of-date agreement, so this is the version the server
          // itself recorded. The shipped constant is only a floor for the
          // impossible case where the snapshot has not been written yet.
          acceptedTermsVersion: account?.acceptedTermsVersion ?? CURRENT_TERMS_VERSION,
          // Never true from this screen. See the note at the top of the file.
          startSharingImmediately: false,
        } satisfies AcceptInvitationRequest,
        schema: AcceptInvitationResponseSchema,
      }),
    onSuccess: async () => {
      // `familyIds` on the account is what the routing guard reads, so it is
      // refreshed before moving on. The token is deliberately not carried into
      // the next route.
      await queryClient.invalidateQueries({ queryKey: ACCOUNT_QUERY_KEY });
      router.replace(ROUTES.locationPrimer);
    },
  });

  const invitation = preview.data;
  const isCheckingInvitation = token !== null && preview.isPending;
  const cameFromLink = linkedToken !== null && submittedToken === null;

  /**
   * The heading copy tracks the state rather than the entry point, because the
   * two diverge: a link whose invitation has expired drops the user back to the
   * field, and telling them "we picked up your invitation" at that moment would
   * be describing a screen they are no longer on.
   */
  function introCopy(): string {
    if (invitation !== undefined) {
      return 'Check that this is the family you expected. Nothing has been joined yet — that happens when you tap the button below.';
    }
    if (isCheckingInvitation) {
      return cameFromLink
        ? 'We picked up an invitation from the link you opened, and we are looking up which family it is for.'
        : 'We are looking up which family this invitation is for.';
    }
    return 'Paste the invitation link you were sent, or type the code from it. We will show you which family it is for before you join anything.';
  }

  function submitTypedInvitation(): void {
    const parsed = extractInvitationToken(typed);
    if (parsed === null) {
      setShowFormatError(true);
      return;
    }
    setShowFormatError(false);
    setSubmittedToken(parsed);
  }

  return (
    <Screen
      footer={
        invitation === undefined ? (
          <Button
            accessibilityHint="Looks up the invitation and shows you the family and who invited you. This does not join anything."
            busy={isCheckingInvitation}
            disabled={typed.trim().length === 0 || isCheckingInvitation}
            label="Check invitation"
            onPress={submitTypedInvitation}
            testID="join-family-check"
          />
        ) : (
          <Stack gap="two">
            <Button
              accessibilityHint={`Joins ${invitation.familyName}. Your location is not shared until you turn sharing on.`}
              busy={acceptInvitation.isPending}
              label={`Join ${invitation.familyName}`}
              onPress={() => {
                if (token === null) return;
                acceptInvitation.mutate({ token });
              }}
              testID="join-family-accept"
            />
            <Button
              accessibilityHint="Discards this invitation without joining, and lets you enter a different one."
              disabled={acceptInvitation.isPending}
              label="Use a different invitation"
              onPress={() => {
                setSubmittedToken(null);
                setTyped('');
                acceptInvitation.reset();
                router.setParams({ token: '' });
              }}
              testID="join-family-reset"
              variant="secondary"
            />
          </Stack>
        )
      }
      testID="onboarding-join-family"
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
          testID="join-family-back"
        />

        <Stack gap="two">
          <Title>Join a family</Title>
          <Body>{introCopy()}</Body>
        </Stack>

        {invitation === undefined && !isCheckingInvitation ? (
          <Field
            autoCapitalize="none"
            autoComplete="off"
            autoCorrect={false}
            editable={!isCheckingInvitation}
            error={
              showFormatError
                ? 'That does not look like a Kinmap invitation. Paste the whole link you were sent, or the code from the end of it.'
                : null
            }
            helper="It looks like a link ending in /invite/… or a long code."
            label="Invitation link or code"
            onChangeText={(next) => {
              setTyped(next);
              setShowFormatError(false);
            }}
            onSubmitEditing={submitTypedInvitation}
            returnKeyType="go"
            testID="join-family-input"
            value={typed}
          />
        ) : null}

        {isCheckingInvitation ? (
          <Callout title="Checking this invitation" tone="info" testID="join-family-checking">
            Looking up which family this invitation is for. Nothing has been joined.
          </Callout>
        ) : null}

        {preview.isError ? (
          <Callout
            title="We could not use that invitation"
            tone="danger"
            testID="join-family-preview-error"
          >
            {describeError(preview.error)}
          </Callout>
        ) : null}

        {invitation !== undefined ? (
          <Card testID="join-family-preview">
            <Title>{invitation.familyName}</Title>
            <StatusRow label="Invited by" value={invitation.invitedByDisplayName} />
            <StatusRow
              detail={ROLE_SUMMARY[invitation.role]}
              label="You would join as"
              value={ROLE_LABEL[invitation.role]}
            />
            <StatusRow
              label="Members already in this family"
              value={String(invitation.memberCount)}
            />
            <StatusRow
              detail="After that the invitation stops working and you would need a new one."
              label="Invitation expires"
              value={formatExpiry(invitation.expiresAt)}
            />
          </Card>
        ) : null}

        {invitation !== undefined ? (
          <Callout title="What joining does, and does not, do" tone="info">
            Joining puts you in this family so you can see the members who are sharing. It does not
            switch your own sharing on — nobody here can see where you are until you turn it on
            yourself, and you can leave this family at any time, which ends their access
            immediately.
          </Callout>
        ) : null}

        {acceptInvitation.isError ? (
          <Callout
            title="We could not join that family"
            tone="danger"
            testID="join-family-accept-error"
          >
            {describeError(acceptInvitation.error)}
          </Callout>
        ) : null}

        <Caption>
          Only accept invitations from people you know. An invitation is how someone gets to see
          your location once you turn sharing on.
        </Caption>
      </Stack>
    </Screen>
  );
}
