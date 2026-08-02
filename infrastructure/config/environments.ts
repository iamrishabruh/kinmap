/**
 * Compatibility surface for stacks that import the environment vocabulary from
 * `../config/environments.js`.
 *
 * The definitions live in `./types.ts` alongside the cross-stack prop
 * interfaces; this module re-exports them so both import paths resolve to the
 * same declarations rather than to two types that merely look alike.
 */
export * from './types.js';
