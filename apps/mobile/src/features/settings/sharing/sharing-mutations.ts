import type { QueryClient, UseMutationOptions } from '@tanstack/react-query';

import type { SharingStatus } from '@family/contracts';

import type { SharingSettings } from '../api/contracts';
import {
  pauseSharing as pauseSharingRequest,
  resumeSharing as resumeSharingRequest,
  updateSharingSettings,
} from '../api/endpoints';
import { settingsQueryKeys } from '../api/query-keys';
import { pauseNativeSharing, resumeNativeSharing } from '../native/location-engine';

/**
 * Mutations for the sharing screen.
 *
 * WHY OPTIMISTIC
 * --------------
 * Pausing location sharing is the one control in this product that must feel
 * instantaneous. A user tapping "pause" is often doing so because they do not
 * want to be seen *right now*; making them watch a spinner while a request
 * flies over a bad connection is a privacy failure, not a UX nit.
 *
 * So the pause happens in three places, in this order:
 *   1. the native engine stops collecting immediately (the part that actually
 *      protects the user);
 *   2. the query cache flips to PAUSED so every screen re-renders at once;
 *   3. the server is told, and its answer replaces the local guess.
 *
 * If step 3 fails, steps 1 and 2 are both undone and the user is told the pause
 * did not stick. We never leave the UI claiming a state the server disagrees
 * with — a user who believes they are hidden while the server is still handing
 * out their position is the worst outcome this codebase can produce.
 */

export type SharingMutationDeps = {
  queryClient: QueryClient;
  /** Injected in tests; defaults to the real endpoints and native engine. */
  pause?: typeof pauseSharingRequest;
  resume?: typeof resumeSharingRequest;
  update?: typeof updateSharingSettings;
  pauseNative?: typeof pauseNativeSharing;
  resumeNative?: typeof resumeNativeSharing;
  now?: () => Date;
};

/** Snapshot taken before an optimistic write so it can be reversed exactly. */
export type SharingMutationContext = {
  previous: SharingSettings | undefined;
  /** True when the engine was actively collecting before we touched it. */
  nativeWasCollecting: boolean;
};

type Deps = Required<Omit<SharingMutationDeps, 'queryClient'>> & {
  queryClient: QueryClient;
};

function withDefaults(deps: SharingMutationDeps): Deps {
  return {
    queryClient: deps.queryClient,
    pause: deps.pause ?? pauseSharingRequest,
    resume: deps.resume ?? resumeSharingRequest,
    update: deps.update ?? updateSharingSettings,
    pauseNative: deps.pauseNative ?? pauseNativeSharing,
    resumeNative: deps.resumeNative ?? resumeNativeSharing,
    now: deps.now ?? (() => new Date()),
  };
}

/** Statuses in which this device is still producing and uploading points. */
const COLLECTING_STATUSES: readonly SharingStatus[] = ['SHARING'];

export function isCollecting(settings: SharingSettings | undefined): boolean {
  return settings !== undefined && COLLECTING_STATUSES.includes(settings.status);
}

// ---------------------------------------------------------------------------
// Pure projections — what the cache should look like the instant a control is
// tapped. Exported so they can be asserted directly, and reused by any screen
// that needs to preview a change without performing it.
// ---------------------------------------------------------------------------

/**
 * `pausedUntil` is a local ESTIMATE only. The server owns the real deadline
 * (a device with a skewed clock must not be able to un-pause itself early), and
 * `onSettled` replaces this value with the authoritative one.
 */
export function projectPause(
  settings: SharingSettings,
  durationMinutes: number | null,
  now: Date,
): SharingSettings {
  return {
    ...settings,
    // Pausing is not disabling: the master switch stays on.
    sharingEnabled: settings.sharingEnabled,
    status: 'PAUSED',
    pausedAt: now.toISOString(),
    pausedUntil:
      durationMinutes === null
        ? null
        : new Date(now.getTime() + durationMinutes * 60_000).toISOString(),
    updatedAt: now.toISOString(),
  };
}

export function projectResume(settings: SharingSettings, now: Date): SharingSettings {
  return {
    ...settings,
    status: settings.sharingEnabled ? 'SHARING' : 'DISABLED',
    pausedAt: null,
    pausedUntil: null,
    updatedAt: now.toISOString(),
  };
}

export function projectMasterSwitch(
  settings: SharingSettings,
  enabled: boolean,
  now: Date,
): SharingSettings {
  // Do not claim we are sharing when the OS has already blocked us — the user
  // would be told they are visible while nothing is being sent.
  const enabledStatus: SharingStatus =
    settings.status === 'PERMISSION_BLOCKED' ? 'PERMISSION_BLOCKED' : 'SHARING';

  return {
    ...settings,
    sharingEnabled: enabled,
    status: enabled ? enabledStatus : 'DISABLED',
    pausedAt: enabled ? settings.pausedAt : null,
    pausedUntil: enabled ? settings.pausedUntil : null,
    updatedAt: now.toISOString(),
  };
}

export function projectMemberVisibility(
  settings: SharingSettings,
  target: { familyId: string; memberUserId: string; visibleToMember: boolean },
  now: Date,
): SharingSettings {
  return {
    ...settings,
    memberRules: settings.memberRules.map((rule) =>
      rule.familyId === target.familyId && rule.memberUserId === target.memberUserId
        ? { ...rule, visibleToMember: target.visibleToMember, updatedAt: now.toISOString() }
        : rule,
    ),
    updatedAt: now.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Shared optimistic plumbing
// ---------------------------------------------------------------------------

const KEY = settingsQueryKeys.sharing();

async function beginOptimisticWrite(
  deps: Deps,
  project: (previous: SharingSettings) => SharingSettings,
): Promise<SharingMutationContext> {
  // Stop an in-flight refetch from landing on top of the optimistic value.
  await deps.queryClient.cancelQueries({ queryKey: KEY });

  const previous = deps.queryClient.getQueryData<SharingSettings>(KEY);
  if (previous) {
    deps.queryClient.setQueryData<SharingSettings>(KEY, project(previous));
  }

  return { previous, nativeWasCollecting: isCollecting(previous) };
}

function rollback(deps: Deps, context: SharingMutationContext | undefined): void {
  if (!context) return;
  if (context.previous) {
    deps.queryClient.setQueryData<SharingSettings>(KEY, context.previous);
  } else {
    deps.queryClient.removeQueries({ queryKey: KEY, exact: true });
  }
}

function settle(deps: Deps): Promise<void> {
  return deps.queryClient.invalidateQueries({ queryKey: KEY });
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export type PauseSharingVariables = { durationMinutes: number | null };

export function pauseSharingMutationOptions(
  rawDeps: SharingMutationDeps,
): UseMutationOptions<SharingSettings, unknown, PauseSharingVariables, SharingMutationContext> {
  const deps = withDefaults(rawDeps);

  return {
    mutationKey: [...KEY, 'pause'],
    mutationFn: (variables) => deps.pause(variables.durationMinutes),

    async onMutate(variables) {
      const context = await beginOptimisticWrite(deps, (previous) =>
        projectPause(previous, variables.durationMinutes, deps.now()),
      );

      // The part that actually hides the user. Deliberately not awaited behind
      // the network call, and deliberately not allowed to fail the mutation:
      // if the engine is already stopped this is a no-op.
      try {
        await deps.pauseNative();
      } catch {
        // Server-side pause is authoritative; a native hiccup must not block it.
      }

      return context;
    },

    onError(_error, _variables, context) {
      rollback(deps, context);
      // Only resume collection if it was genuinely running before the attempt.
      if (context?.nativeWasCollecting) {
        void deps.resumeNative().catch(() => undefined);
      }
    },

    onSuccess(serverSettings) {
      // The server's deadline replaces our estimate immediately, before the
      // invalidation round-trip, so the countdown shown is never our guess.
      deps.queryClient.setQueryData<SharingSettings>(KEY, serverSettings);
    },

    onSettled: () => settle(deps),
  };
}

export function resumeSharingMutationOptions(
  rawDeps: SharingMutationDeps,
): UseMutationOptions<SharingSettings, unknown, void, SharingMutationContext> {
  const deps = withDefaults(rawDeps);

  return {
    mutationKey: [...KEY, 'resume'],
    mutationFn: () => deps.resume(),

    async onMutate() {
      const context = await beginOptimisticWrite(deps, (previous) =>
        projectResume(previous, deps.now()),
      );
      try {
        await deps.resumeNative();
      } catch {
        // Ignored: the server response drives the authoritative state.
      }
      return context;
    },

    onError(_error, _variables, context) {
      rollback(deps, context);
      // Resuming failed, so we must go back to not collecting.
      void deps.pauseNative().catch(() => undefined);
    },

    onSuccess(serverSettings) {
      deps.queryClient.setQueryData<SharingSettings>(KEY, serverSettings);
    },

    onSettled: () => settle(deps),
  };
}

export type MasterSwitchVariables = { enabled: boolean };

export function setMasterSharingMutationOptions(
  rawDeps: SharingMutationDeps,
): UseMutationOptions<SharingSettings, unknown, MasterSwitchVariables, SharingMutationContext> {
  const deps = withDefaults(rawDeps);

  return {
    mutationKey: [...KEY, 'master'],
    mutationFn: (variables) => deps.update({ sharingEnabled: variables.enabled }),

    async onMutate(variables) {
      const context = await beginOptimisticWrite(deps, (previous) =>
        projectMasterSwitch(previous, variables.enabled, deps.now()),
      );
      try {
        await (variables.enabled ? deps.resumeNative() : deps.pauseNative());
      } catch {
        // Ignored; see pauseSharingMutationOptions.
      }
      return context;
    },

    onError(_error, _variables, context) {
      rollback(deps, context);
      // Put the engine back where it was, not where the user asked it to go.
      const restore = context?.nativeWasCollecting ? deps.resumeNative : deps.pauseNative;
      void restore().catch(() => undefined);
    },

    onSuccess(serverSettings) {
      deps.queryClient.setQueryData<SharingSettings>(KEY, serverSettings);
    },

    onSettled: () => settle(deps),
  };
}

export type MemberVisibilityVariables = {
  familyId: string;
  memberUserId: string;
  visibleToMember: boolean;
};

export function setMemberVisibilityMutationOptions(
  rawDeps: SharingMutationDeps,
): UseMutationOptions<SharingSettings, unknown, MemberVisibilityVariables, SharingMutationContext> {
  const deps = withDefaults(rawDeps);

  return {
    mutationKey: [...KEY, 'member-visibility'],
    mutationFn: (variables) =>
      deps.update({
        memberRules: [
          {
            familyId: variables.familyId,
            memberUserId: variables.memberUserId,
            visibleToMember: variables.visibleToMember,
          },
        ],
      }),

    onMutate: (variables) =>
      beginOptimisticWrite(deps, (previous) =>
        projectMemberVisibility(previous, variables, deps.now()),
      ),

    onError(_error, _variables, context) {
      rollback(deps, context);
    },

    onSuccess(serverSettings) {
      deps.queryClient.setQueryData<SharingSettings>(KEY, serverSettings);
    },

    onSettled: () => settle(deps),
  };
}
