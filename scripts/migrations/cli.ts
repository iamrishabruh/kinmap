#!/usr/bin/env tsx
/**
 * Data migration runner (spec §15).
 *
 *   pnpm migration:list
 *   pnpm migration:plan     --env development
 *   pnpm migration:apply    --env development [--dry-run] [--approved-only]
 *   pnpm migration:verify   --env development
 *   pnpm migration:rollback --env development --id <id>
 *
 * Every migration is idempotent, resume-safe, checkpointed, rate limited and
 * environment scoped. Production runs additionally require GitHub environment
 * approval, which is enforced by .github/workflows/data-migration.yml rather
 * than here — but this CLI refuses an unattended production apply as a
 * second line of defence.
 */
import { readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { DataMigration } from '@family/contracts';

type Env = 'development' | 'staging' | 'production';
type Action = 'list' | 'plan' | 'apply' | 'verify' | 'rollback';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../migrations/data');

type Args = {
  action: Action;
  env: Env;
  id?: string;
  dryRun: boolean;
  approvedOnly: boolean;
};

function parseArgs(argv: string[]): Args {
  const [action] = argv;
  const valid: Action[] = ['list', 'plan', 'apply', 'verify', 'rollback'];
  if (!action || !valid.includes(action as Action)) {
    console.error(
      `Usage: migration <${valid.join('|')}> --env <environment> [--id <id>] [--dry-run]`,
    );
    process.exit(2);
  }

  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  const env = (get('--env') ?? 'development') as Env;
  if (!['development', 'staging', 'production'].includes(env)) {
    console.error(`Unknown environment: ${env}`);
    process.exit(2);
  }

  return {
    action: action as Action,
    env,
    id: get('--id'),
    dryRun: argv.includes('--dry-run'),
    approvedOnly: argv.includes('--approved-only'),
  };
}

async function loadMigrations(): Promise<DataMigration[]> {
  let entries: string[];
  try {
    entries = (await readdir(MIGRATIONS_DIR)).filter(
      (f) =>
        (f.endsWith('.ts') || f.endsWith('.js')) && !f.endsWith('.d.ts') && !f.includes('.test.'),
    );
  } catch {
    return [];
  }

  const loaded: DataMigration[] = [];
  for (const file of entries.sort()) {
    const mod = (await import(pathToFileURL(join(MIGRATIONS_DIR, file)).href)) as {
      default?: DataMigration;
      migration?: DataMigration;
    };
    const migration = mod.default ?? mod.migration;
    if (!migration?.id) {
      console.warn(`Skipping ${file}: no default export implementing DataMigration.`);
      continue;
    }
    loaded.push(migration);
  }
  // Migration ids are date-prefixed, so lexical order is execution order.
  return loaded.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Applied-state lives in the DataMigrations DynamoDB table. It is loaded through
 * a late import so that `list` works with no AWS credentials at all.
 */
async function loadState(env: Env): Promise<{
  applied: Set<string>;
  record: (id: string, status: string) => Promise<void>;
}> {
  const tableName = process.env.DATA_MIGRATIONS_TABLE ?? `family-location-${env}-DataMigrations`;

  if (process.env.MIGRATION_STATE_OFFLINE === '1') {
    const applied = new Set<string>();
    return { applied, record: async (id) => void applied.add(id) };
  }

  const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
  const { DynamoDBDocumentClient, ScanCommand, PutCommand } = await import('@aws-sdk/lib-dynamodb');
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));

  const scanned = await doc.send(
    new ScanCommand({
      TableName: tableName,
      ProjectionExpression: 'id, #s',
      ExpressionAttributeNames: { '#s': 'status' },
    }),
  );

  const applied = new Set<string>(
    (scanned.Items ?? [])
      .filter((i) => i['status'] === 'APPLIED' || i['status'] === 'VERIFIED')
      .map((i) => String(i['id'])),
  );

  return {
    applied,
    record: async (id, status) => {
      await doc.send(
        new PutCommand({
          TableName: tableName,
          Item: { id, status, environment: env, updatedAt: new Date().toISOString() },
        }),
      );
    },
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const migrations = await loadMigrations();

  if (migrations.length === 0) {
    console.log('No migrations found in migrations/data.');
    if (args.action !== 'list') process.exit(0);
  }

  if (args.action === 'list') {
    console.log(`${migrations.length} migration(s):`);
    for (const m of migrations) {
      console.log(`  ${m.id}  ${m.description}  (created ${m.createdAt})`);
    }
    return;
  }

  const state = await loadState(args.env);
  const pending = migrations.filter((m) => !state.applied.has(m.id));

  if (args.action === 'plan') {
    console.log(`Environment: ${args.env}`);
    console.log(`Already applied: ${state.applied.size}`);
    console.log(`Pending: ${pending.length}`);
    for (const m of pending) console.log(`  + ${m.id}  ${m.description}`);
    return;
  }

  if (args.action === 'verify') {
    let failed = 0;
    for (const m of migrations.filter((x) => state.applied.has(x.id))) {
      try {
        await m.verify();
        console.log(`  ✓ ${m.id}`);
      } catch (error) {
        failed++;
        console.error(`  ✗ ${m.id}: ${(error as Error).message}`);
      }
    }
    if (failed) process.exit(1);
    console.log('All applied migrations verified.');
    return;
  }

  if (args.action === 'rollback') {
    if (!args.id) {
      console.error('rollback requires --id <migration-id>');
      process.exit(2);
    }
    const target = migrations.find((m) => m.id === args.id);
    if (!target) {
      console.error(`Unknown migration: ${args.id}`);
      process.exit(1);
    }
    if (!target.rollback) {
      console.error(`Migration ${target.id} declares no rollback. Roll forward instead.`);
      process.exit(1);
    }
    console.log(`Rolling back ${target.id} in ${args.env}…`);
    await target.rollback();
    await state.record(target.id, 'ROLLED_BACK');
    console.log('Rollback complete. Verify the data before proceeding.');
    return;
  }

  // action === 'apply'
  if (args.env === 'production' && !process.env.CI && !args.dryRun) {
    console.error(
      'Refusing an interactive production apply.\n' +
        'Run it through .github/workflows/data-migration.yml so the environment approval and audit trail apply.',
    );
    process.exit(1);
  }

  if (pending.length === 0) {
    console.log('Nothing to apply.');
    return;
  }

  for (const m of pending) {
    if (args.dryRun) {
      console.log(`  (dry run) would apply ${m.id}  ${m.description}`);
      continue;
    }
    console.log(`Applying ${m.id}  ${m.description}`);
    await state.record(m.id, 'RUNNING');
    try {
      await m.apply();
      await state.record(m.id, 'APPLIED');
      await m.verify();
      await state.record(m.id, 'VERIFIED');
      console.log(`  ✓ ${m.id} applied and verified`);
    } catch (error) {
      await state.record(m.id, 'FAILED');
      console.error(`  ✗ ${m.id} failed: ${(error as Error).message}`);
      console.error('Migrations are resume-safe: fix the cause and re-run apply.');
      process.exit(1);
    }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
