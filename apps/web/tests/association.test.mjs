import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * A typo in the Team ID or bundle ID does not fail any build — it silently
 * makes every invitation link open Safari instead of the app, and you only
 * find out from a confused user. These assertions are the guard.
 */
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const wellKnown = join(root, 'public', '.well-known');

const TEAM_ID = 'HH7Q2DUJ9U';
const BUNDLE_ID = 'app.kinmap';

test('apple-app-site-association is valid JSON', async () => {
  const raw = await readFile(join(wellKnown, 'apple-app-site-association'), 'utf8');
  assert.doesNotThrow(() => JSON.parse(raw));
});

test('AASA has no file extension', async () => {
  // Apple fetches the extensionless path exactly; a .json suffix is not read.
  await assert.doesNotReject(readFile(join(wellKnown, 'apple-app-site-association')));
});

test('AASA declares the production app with the correct Team ID prefix', async () => {
  const aasa = JSON.parse(await readFile(join(wellKnown, 'apple-app-site-association'), 'utf8'));
  const appIDs = aasa.applinks.details.flatMap((d) => d.appIDs ?? [d.appID]);
  assert.ok(
    appIDs.includes(`${TEAM_ID}.${BUNDLE_ID}`),
    `expected ${TEAM_ID}.${BUNDLE_ID} in ${JSON.stringify(appIDs)}`,
  );
  for (const id of appIDs) {
    assert.match(id, /^[A-Z0-9]{10}\./, `appID "${id}" must start with a 10-char Team ID`);
  }
});

test('AASA covers the invitation path', async () => {
  const aasa = JSON.parse(await readFile(join(wellKnown, 'apple-app-site-association'), 'utf8'));
  const paths = aasa.applinks.details.flatMap((d) =>
    (d.components ?? []).map((c) => c['/']).concat(d.paths ?? []),
  );
  assert.ok(
    paths.some((p) => p?.startsWith('/invite')),
    'invitation links will not open the app without an /invite path',
  );
});

test('webcredentials is declared so the password manager offers saved logins', async () => {
  const aasa = JSON.parse(await readFile(join(wellKnown, 'apple-app-site-association'), 'utf8'));
  assert.ok(aasa.webcredentials?.apps?.includes(`${TEAM_ID}.${BUNDLE_ID}`));
});

test('assetlinks.json is valid and names the Android package', async () => {
  const links = JSON.parse(await readFile(join(wellKnown, 'assetlinks.json'), 'utf8'));
  assert.ok(Array.isArray(links) && links.length > 0);
  assert.equal(links[0].target.package_name, BUNDLE_ID);
  assert.ok(links[0].relation.includes('delegate_permission/common.handle_all_urls'));
});

test('assetlinks fingerprint placeholder is still flagged as unset', async () => {
  // Android App Links stay broken until the real Play App Signing SHA-256 is in
  // place. Fail loudly rather than shipping a file that looks configured.
  const links = JSON.parse(await readFile(join(wellKnown, 'assetlinks.json'), 'utf8'));
  const fingerprints = links[0].target.sha256_cert_fingerprints;
  const unset = fingerprints.some((f) => f.startsWith('REPLACE_'));
  assert.ok(
    !unset || process.env.ALLOW_UNSET_ANDROID_FINGERPRINT === '1',
    'Android App Links are not configured: replace the SHA-256 fingerprint from ' +
      'Play Console > Setup > App signing, or set ALLOW_UNSET_ANDROID_FINGERPRINT=1 ' +
      'while the project is iOS-only.',
  );
});

test('every path the association file advertises has a landing page', async () => {
  // iOS only consults this file; it has no idea whether the path it is told to
  // claim actually serves anything. An advertised path with no page means the
  // link opens a browser and dies on an error, which is indistinguishable to
  // the user from the app being broken.
  const aasa = JSON.parse(await readFile(join(wellKnown, 'apple-app-site-association'), 'utf8'));
  const paths = aasa.applinks.details.flatMap((d) =>
    (d.components ?? []).map((c) => c['/']).concat(d.paths ?? []),
  );

  // Each advertised path is a prefix pattern like /invite/*; the page that
  // serves it is <prefix>/index.html.
  const landingPages = {
    '/invite': 'invite/index.html',
    '/i': 'invite/index.html',
    '/live': 'live/index.html',
  };

  for (const pattern of new Set(paths.filter(Boolean))) {
    const prefix = pattern.replace(/\/\*$/, '');
    const page = landingPages[prefix];
    assert.ok(
      page,
      `the association file advertises ${pattern} but no landing page is mapped for it`,
    );
    await assert.doesNotReject(
      readFile(join(root, 'public', page)),
      `${pattern} is advertised to iOS but ${page} does not exist`,
    );
  }
});

test('the error page the distribution points at exists', async () => {
  // Both the 403 and 404 error responses target /404.html. When it is missing,
  // a missing object returns the error page, which is also missing, and the
  // visitor gets raw S3 AccessDenied XML instead.
  await assert.doesNotReject(readFile(join(root, 'public', '404.html')));
});
