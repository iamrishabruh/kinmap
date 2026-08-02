import { AppEnvSchema, type AppEnv } from '@family/contracts';

import type { ForwardPolicy } from './forward.js';

/**
 * Typed configuration for services/mail-forwarder. Fails closed: a missing
 * destination inbox or a missing bucket makes the function refuse to start
 * rather than silently accept mail and drop it on the floor.
 */

export type EnvSource = Readonly<Record<string, string | undefined>>;

export class ConfigurationError extends Error {
  constructor(readonly variable: string) {
    super(`Required environment variable ${variable} is missing or empty.`);
    this.name = 'ConfigurationError';
  }
}

export function requireString(source: EnvSource, name: string): string {
  const raw = source[name];
  if (raw === undefined) throw new ConfigurationError(name);
  const trimmed = raw.trim();
  if (trimmed.length === 0) throw new ConfigurationError(name);
  return trimmed;
}

export function optionalString(source: EnvSource, name: string): string | undefined {
  const raw = source[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function optionalNumber(source: EnvSource, name: string, fallback: number): number {
  const raw = optionalString(source, name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Comma-separated list; empty entries are dropped, an empty result is fatal. */
export function requireList(source: EnvSource, name: string): string[] {
  const parts = requireString(source, name)
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) throw new ConfigurationError(name);
  return parts;
}

export function readAppEnv(source: EnvSource): AppEnv {
  const parsed = AppEnvSchema.safeParse(optionalString(source, 'APP_ENV') ?? 'development');
  return parsed.success ? parsed.data : 'development';
}

/**
 * SES accepts a 40 MB message and so does its receiving side, but the mailbox
 * on the far end usually does not. 20 MiB leaves room under every consumer
 * provider's limit; anything larger is answered with a notice instead.
 */
export const DEFAULT_MAX_FORWARD_BYTES = 20 * 1024 * 1024;

export interface MailForwarderConfig {
  readonly appEnv: AppEnv;
  readonly serviceName: string;
  readonly metricsNamespace: string;
  /** Bucket the SES receipt rule spools raw messages into. */
  readonly bucketName: string;
  /** Key prefix within that bucket; the object key is `${prefix}${messageId}`. */
  readonly objectKeyPrefix: string;
  readonly policy: ForwardPolicy;
}

export function loadConfig(source: EnvSource = process.env): MailForwarderConfig {
  const appEnv = readAppEnv(source);

  const forwardedAddresses = requireList(source, 'MAIL_FORWARDED_ADDRESSES').map((address) =>
    address.toLowerCase(),
  );
  const fromAddress = requireString(source, 'MAIL_FORWARD_FROM').toLowerCase();

  // Sending as one of the addresses we also receive would mean every reply,
  // vacation responder and bounce came straight back into the receipt rule.
  if (forwardedAddresses.includes(fromAddress)) {
    throw new ConfigurationError(
      'MAIL_FORWARD_FROM (must not be one of MAIL_FORWARDED_ADDRESSES — that is a mail loop)',
    );
  }

  return {
    appEnv,
    serviceName: optionalString(source, 'SERVICE_NAME') ?? 'mail-forwarder',
    metricsNamespace: optionalString(source, 'METRICS_NAMESPACE') ?? `Kinmap/${appEnv}`,
    bucketName: requireString(source, 'MAIL_BUCKET'),
    objectKeyPrefix: optionalString(source, 'MAIL_OBJECT_PREFIX') ?? 'inbound/',
    policy: {
      forwardedAddresses,
      fromAddress,
      destinations: requireList(source, 'MAIL_FORWARD_TO'),
      maxForwardBytes: optionalNumber(source, 'MAIL_MAX_FORWARD_BYTES', DEFAULT_MAX_FORWARD_BYTES),
    },
  };
}
