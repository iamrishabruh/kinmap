import type { RegisteredRoute } from '../router.js';

import { accountRoutes } from './account.js';
import { configurationRoutes } from './configuration.js';
import { deviceRoutes } from './devices.js';
import { healthRoutes } from './health.js';
import { privacyRoutes } from './privacy.js';
import { subscriptionRoutes } from './subscriptions.js';
import { supportRoutes } from './support.js';

/**
 * The v1 surface this function owns.
 *
 * What is deliberately absent is as informative as what is here: no route in
 * this table touches a coordinate. `/v1/locations/*` is integrated directly with
 * the location service, which holds the decrypt grant, and the billing webhooks
 * with the service that holds the provider secrets. This function is granted no
 * access to any location table and none to the coordinate key, so a bug in any
 * route below cannot reach anybody's position.
 */
export const routes: RegisteredRoute[] = [
  ...accountRoutes,
  ...configurationRoutes,
  ...deviceRoutes,
  ...healthRoutes,
  ...privacyRoutes,
  ...subscriptionRoutes,
  ...supportRoutes,
];

export {
  accountRoutes,
  configurationRoutes,
  deviceRoutes,
  healthRoutes,
  privacyRoutes,
  subscriptionRoutes,
  supportRoutes,
};
