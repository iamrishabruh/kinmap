import { z } from 'zod';

import { AppError } from '@family/contracts';
import {
  BootstrapConfigurationResponseSchema,
  ConfigurationResponseSchema,
  type BootstrapConfigurationResponse,
  type ConfigurationResponse,
} from '@family/schemas';

import { type DocumentClient, type Item } from './document-client.js';

/**
 * Remote configuration is authored out of band and is read-only here.
 *
 * The table is versioned (`configKey` + numeric `version`) so a bad rollout can
 * be pinned back without a deployment. The newest row wins; the client verifies
 * the detached signature before applying whatever it is handed, so this service
 * never has to be the thing that decides a document is trustworthy.
 */

export const ENGINE_CONFIG_KEY = 'engine';
export const BOOTSTRAP_CONFIG_KEY = 'bootstrap';

const StoredConfigurationSchema = z.object({
  configKey: z.string(),
  version: z.number().int().nonnegative(),
  document: z.unknown(),
});

export interface RemoteConfigurationRepository {
  getEngineConfiguration(): Promise<ConfigurationResponse | null>;
  getBootstrapConfiguration(): Promise<BootstrapConfigurationResponse | null>;
}

export function createRemoteConfigurationRepository(
  client: DocumentClient,
  tableName: string,
): RemoteConfigurationRepository {
  async function latest(configKey: string): Promise<unknown | null> {
    const page = await client.query({
      TableName: tableName,
      KeyConditionExpression: '#k = :k',
      ExpressionAttributeNames: { '#k': 'configKey' },
      ExpressionAttributeValues: { ':k': configKey },
      ScanIndexForward: false,
      Limit: 1,
    });
    const item: Item | undefined = (page.Items ?? [])[0];
    if (item === undefined) {
      return null;
    }
    const parsed = StoredConfigurationSchema.safeParse(item);
    if (!parsed.success) {
      throw new AppError('INTERNAL_ERROR', 'The remote configuration could not be read.');
    }
    return parsed.data.document;
  }

  return {
    async getEngineConfiguration(): Promise<ConfigurationResponse | null> {
      const document = await latest(ENGINE_CONFIG_KEY);
      if (document === null) {
        return null;
      }
      const parsed = ConfigurationResponseSchema.safeParse(document);
      if (!parsed.success) {
        // A configuration that no longer satisfies its guardrails is not served
        // at all: the device keeps the last document it verified.
        throw new AppError('UPSTREAM_UNAVAILABLE', 'Configuration is temporarily unavailable.');
      }
      return parsed.data;
    },

    async getBootstrapConfiguration(): Promise<BootstrapConfigurationResponse | null> {
      const document = await latest(BOOTSTRAP_CONFIG_KEY);
      if (document === null) {
        return null;
      }
      const parsed = BootstrapConfigurationResponseSchema.safeParse(document);
      if (!parsed.success) {
        throw new AppError('UPSTREAM_UNAVAILABLE', 'Configuration is temporarily unavailable.');
      }
      return parsed.data;
    },
  };
}
