import { GetSecretValueCommand, type SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

/**
 * Small cached reader for Secrets Manager.
 *
 * Secrets are fetched lazily and held for a short TTL so a warm container does
 * not call Secrets Manager on every webhook, while a rotation still takes
 * effect within minutes. Values are never logged and never returned in an error
 * message — a failure surfaces as `undefined`, which every caller treats as
 * "this provider is not configured" and therefore fails closed.
 */

const DEFAULT_TTL_MS = 5 * 60 * 1000;

type CacheEntry = { value: string | undefined; expiresAtMs: number };

export class SecretCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(
    private readonly client: SecretsManagerClient,
    private readonly ttlMs: number = DEFAULT_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  async get(secretArn: string | undefined): Promise<string | undefined> {
    if (secretArn === undefined || secretArn.length === 0) return undefined;

    const cached = this.entries.get(secretArn);
    if (cached !== undefined && this.now() < cached.expiresAtMs) {
      return cached.value;
    }

    let value: string | undefined;
    try {
      const response = await this.client.send(new GetSecretValueCommand({ SecretId: secretArn }));
      value = response.SecretString ?? undefined;
    } catch {
      value = undefined;
    }

    this.entries.set(secretArn, { value, expiresAtMs: this.now() + this.ttlMs });
    return value;
  }

  /**
   * Reads one field out of a JSON secret, falling back to the whole string when
   * the secret is stored as a bare value.
   */
  async getField(secretArn: string | undefined, field: string): Promise<string | undefined> {
    const raw = await this.get(secretArn);
    if (raw === undefined) return undefined;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const value = (parsed as Record<string, unknown>)[field];
        return typeof value === 'string' && value.length > 0 ? value : undefined;
      }
    } catch {
      // Not JSON: the secret is the value.
    }
    return raw;
  }
}
