import { useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import type { FamilyId, UserId } from '@family/contracts';

import { Spacing } from '@/constants/theme';
import {
  LIVE_SESSION_DURATION_CHOICES,
  clampLiveSessionSeconds,
} from '@/features/live/session-model';
import { useRequestLiveSession } from '@/features/live/use-live-session';
import { userMessageFor } from '@/features/query/errors';
import { useEffectiveEntitlements } from '@/features/query/hooks';
import { formatDuration } from '@/features/ui/format';
import { AppButton, Body, Card, Label, Pill } from '@/features/ui/primitives';

/**
 * Asking to follow someone live.
 *
 * A request is a request. It creates nothing until the other person accepts on
 * their own device, the copy here says so plainly, and the duration options
 * stop at the ten-minute cap — there is no "until I turn it off" option, by
 * design.
 */

export function RequestLiveSessionCard({
  familyId,
  targetUserId,
  targetDisplayName,
  disabledReason,
}: {
  familyId: FamilyId;
  targetUserId: UserId;
  targetDisplayName: string;
  /** Set when the target is not currently sharing at all. */
  disabledReason?: string;
}) {
  const router = useRouter();
  const { liveSessionsEnabled } = useEffectiveEntitlements();
  const request = useRequestLiveSession();
  const [selectedSeconds, setSelectedSeconds] = useState<number>(
    LIVE_SESSION_DURATION_CHOICES[0] ?? 300,
  );

  if (!liveSessionsEnabled) {
    return (
      <Card>
        <Label>Live session</Label>
        <Body tone="secondary">
          Following someone live is part of a paid plan. Everyone in the family keeps their normal
          sharing controls either way.
        </Body>
        <AppButton
          title="See plans"
          variant="secondary"
          onPress={() => router.push('/(tabs)/settings')}
        />
      </Card>
    );
  }

  if (disabledReason !== undefined) {
    return (
      <Card>
        <Label>Live session</Label>
        <Body tone="secondary">{disabledReason}</Body>
      </Card>
    );
  }

  return (
    <Card>
      <Label>Live session</Label>
      <Body tone="secondary">
        {targetDisplayName} will get a request on their phone. Nothing is shared unless they accept,
        they see a banner the whole time, and it stops on its own.
      </Body>

      <View style={styles.choices}>
        {LIVE_SESSION_DURATION_CHOICES.map((seconds) => {
          const selected = seconds === selectedSeconds;
          return (
            <AppButton
              key={seconds}
              title={formatDuration(seconds)}
              variant={selected ? 'primary' : 'secondary'}
              onPress={() => setSelectedSeconds(seconds)}
            />
          );
        })}
      </View>

      <AppButton
        title={`Ask to follow for ${formatDuration(clampLiveSessionSeconds(selectedSeconds))}`}
        busy={request.isPending}
        accessibilityHint={`Sends ${targetDisplayName} a request. They must accept before anything is shared.`}
        onPress={() => {
          request.mutate(
            { familyId, targetUserId, durationSeconds: selectedSeconds },
            {
              onSuccess: (session) =>
                router.push({
                  pathname: '/live-session/[sessionId]',
                  params: { sessionId: session.sessionId },
                }),
            },
          );
        }}
      />

      {request.isError ? (
        <Body tone="danger">{userMessageFor(request.error)}</Body>
      ) : (
        <View style={styles.footnote}>
          <Pill text={`Max ${formatDuration(clampLiveSessionSeconds(Number.MAX_SAFE_INTEGER))}`} />
          <Body tone="muted">Live sessions always end automatically.</Body>
        </View>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  choices: { flexDirection: 'row', gap: Spacing.two },
  footnote: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two, flexWrap: 'wrap' },
});
