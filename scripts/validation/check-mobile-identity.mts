/**
 * The mobile app must know who it is without help from the environment.
 *
 * `app.config.ts` reads its slug and EAS project id from `process.env`. The
 * Expo CLI loads `.env.local` automatically; the **EAS CLI does not**. So
 * `eas build` in an ordinary shell resolved neither, the slug fell back to a
 * placeholder, EAS could not find the linked project, and it silently created a
 * second project under the wrong name rather than failing. That happened twice.
 *
 * The first version of this check shelled out to `expo config` with the
 * environment scrubbed, which proved nothing: the Expo CLI re-read `.env.local`
 * and handed back the right answer no matter what the fallback said. This
 * evaluates the config module directly, with the relevant variables deleted and
 * no dotenv loading, which is precisely the state the EAS CLI invokes it in.
 */
const EXPECTED = {
  slug: 'kinmap',
  owner: 'rishabruh',
  projectId: '7cfe193d-e29a-404d-a2f2-20f858aa9c32',
} as const;

/** Everything app.config.ts reads that would mask a missing fallback. */
const SCRUBBED = [
  'EXPO_PROJECT_SLUG',
  'EAS_PROJECT_ID',
  'EXPO_ACCOUNT_OWNER',
  'APP_BUNDLE_ID',
  'APP_DOMAIN',
  'APP_NAME',
  'APP_VARIANT',
];

for (const name of SCRUBBED) {
  delete process.env[name];
}

const module_ = (await import('../../apps/mobile/app.config.ts')) as {
  default: (context: { config: Record<string, unknown> }) => Record<string, unknown>;
};

const config = module_.default({ config: {} });
const extra = config['extra'] as { eas?: { projectId?: string } } | undefined;

const actual = {
  slug: config['slug'],
  owner: config['owner'],
  projectId: extra?.eas?.projectId,
};

let failed = false;
for (const [key, expected] of Object.entries(EXPECTED)) {
  const value = actual[key as keyof typeof actual];
  if (value === expected) {
    console.log(`  ok   ${key}: ${String(value)}`);
    continue;
  }
  failed = true;
  console.error(`  FAIL ${key}: expected '${expected}', resolved '${String(value)}'`);
}

if (failed) {
  console.error('');
  console.error('  A build started without .env.local uses the resolved value. When that');
  console.error('  is a placeholder, EAS creates a new project instead of failing, and');
  console.error("  the mistake only shows up later in the account's project list.");
  process.exit(1);
}

console.log('Mobile identity check passed.');
