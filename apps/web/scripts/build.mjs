#!/usr/bin/env node
/**
 * Copies public/ to dist/ for S3 + CloudFront deployment.
 *
 * Deliberately not a framework. Everything this site serves is static — legal
 * text, a support page, and the two association files that make deep links
 * work. A build toolchain here would add a dependency surface and a failure
 * mode to a site whose entire job is to be reliably readable, including by
 * Apple's and Google's crawlers.
 */
import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(root, 'public');
const target = join(root, 'dist');

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true });

/** Association files must be served as application/json with no extension. */
const REQUIRED = [
  '.well-known/apple-app-site-association',
  '.well-known/assetlinks.json',
  // The distribution points both its 403 and 404 error responses here. Without
  // it a missing object returns the error page, which is also missing, and the
  // visitor gets raw S3 AccessDenied XML.
  '404.html',
  // The landing pages for every path the association file advertises to iOS.
  // If one of these is absent the deep link opens a browser and dies there.
  'invite/index.html',
  'live/index.html',
];

for (const relative of REQUIRED) {
  try {
    await stat(join(target, relative));
  } catch {
    throw new Error(
      `Missing ${relative}. Deep links silently fall back to the browser without it.`,
    );
  }
}

async function count(dir) {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    total += entry.isDirectory() ? await count(join(dir, entry.name)) : 1;
  }
  return total;
}

console.log(`Built ${await count(target)} files into dist/`);
