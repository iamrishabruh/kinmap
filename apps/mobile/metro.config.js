// @ts-check
const path = require('node:path');

const { getDefaultConfig } = require('expo/metro-config');

/**
 * Metro, taught to read this monorepo.
 *
 * Two things it cannot do on its own here.
 *
 * 1. RESOLVE `./thing.js` TO `./thing.ts`. Every workspace package writes its
 *    relative imports with a `.js` extension, which is what Node's ESM resolver
 *    requires of compiled TypeScript and is therefore correct. Metro resolves
 *    the literal string, finds no `tokens.js` next to `tokens.ts`, and fails:
 *
 *      None of these files exist: packages/design-system/src/tokens.js
 *
 *    This went unnoticed for as long as it did because the app had exactly one
 *    route file and it imported no workspace package. The first screen that
 *    imported the design system broke the bundle — the EAS builds that passed
 *    earlier were building an app with no screens in it.
 *
 * 2. WATCH THE WHOLE WORKSPACE. Metro's default project root is this directory,
 *    so a change in packages/ would not be picked up and, worse, the packages
 *    would resolve through a second copy of React.
 */
const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '..', '..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];

// pnpm's store is content-addressed and symlinked; Metro has to follow both the
// app's own node_modules and the workspace root's.
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];
config.resolver.disableHierarchicalLookup = true;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  // Only relative TypeScript-style specifiers. A bare `.js` from a real
  // dependency is left alone: rewriting those would break any package that
  // genuinely ships JavaScript.
  if (moduleName.startsWith('.') && moduleName.endsWith('.js')) {
    const asTypeScript = `${moduleName.slice(0, -'.js'.length)}`;
    try {
      return context.resolveRequest(context, asTypeScript, platform);
    } catch {
      // Fall through: it really was JavaScript, or it does not exist at all and
      // the original error is the more useful one to surface.
    }
  }

  // `context.resolveRequest` is Metro's own resolver, not this function, so
  // this is a delegation rather than a recursion.
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
