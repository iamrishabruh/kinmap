import * as Sentry from '@sentry/react-native';
import { buildSentryBeforeSend, type SentryEvent } from '@family/observability';

import { env, isProduction } from '@/config/env';

/**
 * Crash and error reporting.
 *
 * The redaction contract lives in `@family/observability` and is applied here
 * as Sentry's `beforeSend`, so a coordinate cannot reach Sentry even if some
 * future code path attaches an event body to an exception. This module adds the
 * client-side rules that only make sense in the app:
 *
 *   - PII is off at the SDK level (`sendDefaultPii: false`).
 *   - Breadcrumbs are stripped of query strings; our URLs never carry a
 *     coordinate, but they do carry invitation codes.
 *   - The user context is an opaque user id and nothing else. No email, no
 *     display name, no IP, no family.
 */

let initialised = false;

export function initialiseObservability(): void {
  if (initialised) return;
  initialised = true;

  const dsn = env.sentryDsn;
  if (dsn === undefined || dsn.length === 0) {
    // No DSN in local development is normal and must not be fatal.
    return;
  }

  Sentry.init({
    dsn,
    environment: env.appEnv,
    release: env.appVersion,
    debug: false,
    // Never let the SDK infer PII (IP address, username, cookies).
    sendDefaultPii: false,
    // Screenshots and view hierarchies of this app contain a map.
    attachScreenshot: false,
    attachViewHierarchy: false,
    tracesSampleRate: isProduction ? 0.05 : 1.0,
    // @family/observability scrubs against its own structural event shape so it
    // stays SDK-agnostic and testable; this adapter is the one place the
    // Sentry React Native event type is bridged onto it.
    beforeSend: (event, _hint) => {
      const scrubbed = buildSentryBeforeSend()(event as unknown as SentryEvent);
      return scrubbed as unknown as typeof event | null;
    },
    beforeBreadcrumb: (breadcrumb) => {
      if (typeof breadcrumb.data?.url === 'string') {
        const [path] = breadcrumb.data.url.split('?');
        return { ...breadcrumb, data: { ...breadcrumb.data, url: path ?? '' } };
      }
      return breadcrumb;
    },
  });
}

/**
 * Associates reports with an opaque user id so a support request can be found.
 * Nothing else about the person is attached, ever.
 */
export function setObservabilityUser(userId: string | null): void {
  if (!initialised) return;
  Sentry.setUser(userId === null ? null : { id: userId });
}

/**
 * Records a navigation-guard decision. Reasons are a closed enum defined in
 * `features/auth/routing.ts`; no identifier or path parameter is included.
 */
export function recordGuardRedirect(reason: string, to: string): void {
  if (!initialised) return;
  Sentry.addBreadcrumb({
    category: 'navigation.guard',
    level: 'info',
    message: reason,
    data: { to },
  });
}
