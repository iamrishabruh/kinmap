// @ts-check
const { withEntitlementsPlist, withInfoPlist } = require('expo/config-plugins');

/**
 * iOS configuration for the native location engine (spec §9, §25).
 *
 * Anything Expo's own plugins already set is left to them. This plugin adds
 * only what they do not: the background-task identifiers the engine registers,
 * the Sign in with Apple entitlement, and a defensive assertion that the
 * location usage strings are actually present and specific.
 *
 * Usage strings live in app.config.ts rather than here so a reviewer reads them
 * in one place next to the rest of the public configuration.
 *
 * WHY THIS IS JAVASCRIPT AND NOT TYPESCRIPT
 *
 * The EAS CLI resolves config plugins with a plain `require`, which cannot load
 * a `.ts` file — `node -e "require('./plugins/withLocationEngine')"` fails with
 * MODULE_NOT_FOUND. The Expo CLI registers a TypeScript loader first, so
 * `expo config` and `expo prebuild` resolved these happily while every
 * `eas build` died at:
 *
 *   Failed to resolve plugin for module "./plugins/withLocationEngine"
 *
 * That divergence is why the failure looked intermittent and why `eas config`
 * appeared to prove the plugins were fine — it does not evaluate them. Type
 * checking is preserved through `// @ts-check` and JSDoc rather than lost.
 */

/**
 * Background task identifiers permitted for this app.
 *
 * RENAMED FROM `com.familylocation.engine.*`, which was a prefix belonging to no
 * bundle this project ships. `BGTaskScheduler` requires a submitted task's
 * identifier to appear in `BGTaskSchedulerPermittedIdentifiers`, and Apple's
 * guidance is that it be namespaced under the app's own bundle identifier —
 * `app.kinmap*` here. The old prefix predates the rename to Kinmap and would
 * have been a permanent oddity in the shipped Info.plist.
 *
 * NOTHING REGISTERS THESE YET. The Swift engine contains no
 * `BGTaskScheduler.shared.register` call, so today this list only declares an
 * intent. It is kept, and corrected, because the declaration has to exist in the
 * binary *before* the engine can ever schedule work — Info.plist is read at
 * launch and cannot be added over the air — and because a wrong prefix left in
 * place would fail at the first registration attempt rather than here.
 *
 * @type {string[]}
 */
const BACKGROUND_TASK_IDENTIFIERS = ['app.kinmap.engine.refresh', 'app.kinmap.engine.processing'];

/** @type {string[]} */
const REQUIRED_USAGE_KEYS = [
  'NSLocationWhenInUseUsageDescription',
  'NSLocationAlwaysAndWhenInUseUsageDescription',
];

/**
 * Copy that describes *what* is shared, *with whom*, and *how to stop* is a
 * store-review requirement and an honesty requirement. A short string is almost
 * always the vague kind App Review rejects, so the build fails early rather
 * than at submission.
 */
const MIN_USAGE_DESCRIPTION_LENGTH = 60;

/**
 * @param {import('expo/config-plugins').ExpoConfig} config
 * @returns {import('expo/config-plugins').ExpoConfig}
 */
const withLocationEngine = (config) => {
  // Each `with*` helper returns a new config rather than mutating in place, so
  // the result is threaded through a local instead of reassigning the parameter.
  let next = withInfoPlist(config, (mod) => {
    const plist = mod.modResults;

    for (const key of REQUIRED_USAGE_KEYS) {
      const value = plist[key];
      if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(
          `[withLocationEngine] ${key} is missing. Background location cannot ship without it.`,
        );
      }
      if (value.trim().length < MIN_USAGE_DESCRIPTION_LENGTH) {
        throw new Error(
          `[withLocationEngine] ${key} is too short to explain what is shared, with whom, ` +
            'and how to stop. Vague permission copy is rejected by App Review.',
        );
      }
    }

    // Registered so the engine can schedule deferred upload and maintenance
    // work; without this the BGTaskScheduler registration throws at runtime.
    const existing = Array.isArray(plist.BGTaskSchedulerPermittedIdentifiers)
      ? plist.BGTaskSchedulerPermittedIdentifiers
      : [];
    plist.BGTaskSchedulerPermittedIdentifiers = [
      ...new Set([...existing, ...BACKGROUND_TASK_IDENTIFIERS]),
    ];

    const modes = Array.isArray(plist.UIBackgroundModes) ? plist.UIBackgroundModes : [];
    plist.UIBackgroundModes = [...new Set([...modes, 'location', 'fetch', 'processing'])];

    return mod;
  });

  next = withEntitlementsPlist(next, (mod) => {
    // Sign in with Apple is mandatory for any app offering third-party sign-in.
    mod.modResults['com.apple.developer.applesignin'] = ['Default'];
    return mod;
  });

  return next;
};

module.exports = withLocationEngine;
module.exports.default = withLocationEngine;
module.exports.BACKGROUND_TASK_IDENTIFIERS = BACKGROUND_TASK_IDENTIFIERS;
