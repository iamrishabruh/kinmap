import type { ConfigurationResponse } from '@family/schemas';

/**
 * Remote-configuration freshness.
 *
 * The device sends the version it already holds. Answering `304 Not Modified`
 * saves the payload, but only when the device's copy is genuinely the one we
 * would serve — a device claiming a *newer* version than the table holds has
 * either been rolled back deliberately or is lying, and in both cases it must
 * receive the current document rather than be told to keep what it has.
 */
export function isConfigurationUnchanged(input: {
  clientVersion: number | null;
  servedVersion: number;
}): boolean {
  return input.clientVersion !== null && input.clientVersion === input.servedVersion;
}

/**
 * A device must never apply an expired configuration. Serving one that has
 * already lapsed would push a document the client is obliged to reject, so it
 * is reported as an upstream problem instead.
 */
export function isConfigurationExpired(config: ConfigurationResponse, now: Date): boolean {
  const expiresAt = Date.parse(config.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt <= now.getTime();
}
