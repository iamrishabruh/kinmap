import type { RateLimiter } from '@family/auth';

import type { ApiConfig } from './env.js';
import type { AccountsRepository } from './repositories/accounts.js';
import type { AuditRepository } from './repositories/audit.js';
import type { RemoteConfigurationRepository } from './repositories/configuration.js';
import type { DevicesRepository } from './repositories/devices.js';
import type { FamiliesRepository, MembershipsRepository } from './repositories/families.js';
import type { IdempotencyStore } from './repositories/idempotency.js';
import type { JobsRepository } from './repositories/jobs.js';
import type { LiveSessionsRepository } from './repositories/live-sessions.js';
import type { LocationCountsRepository } from './repositories/location-counts.js';
import type {
  NotificationPreferencesRepository,
  NotificationsRepository,
} from './repositories/notifications.js';
import type { PlacesRepository } from './repositories/places.js';
import type { PrivacyExportsRepository } from './repositories/privacy-exports.js';
import type { SubscriptionsRepository } from './repositories/subscriptions.js';
import type { SupportRepository } from './repositories/support.js';

/**
 * Everything a route is allowed to reach.
 *
 * Routes receive this object; they never construct a client, read `process.env`
 * or call `Date.now()` directly. That is what makes a route testable with a
 * fake store and a fixed clock, and it is why the clock and the id generator are
 * dependencies rather than globals.
 */
export type ApiServices = {
  readonly config: ApiConfig;
  readonly accounts: AccountsRepository;
  readonly devices: DevicesRepository;
  readonly families: FamiliesRepository;
  readonly memberships: MembershipsRepository;
  readonly subscriptions: SubscriptionsRepository;
  readonly audit: AuditRepository;
  readonly support: SupportRepository;
  readonly jobs: JobsRepository;
  readonly places: PlacesRepository;
  readonly privacyExports: PrivacyExportsRepository;
  /** Counts location rows. It cannot read one; see the repository. */
  readonly locationCounts: LocationCountsRepository;
  readonly liveSessions: LiveSessionsRepository;
  readonly notifications: NotificationsRepository;
  readonly notificationPreferences: NotificationPreferencesRepository;
  readonly configuration: RemoteConfigurationRepository;
  readonly idempotency: IdempotencyStore;
  readonly rateLimiter: RateLimiter;
  readonly clock: () => Date;
  readonly newId: () => string;
};
