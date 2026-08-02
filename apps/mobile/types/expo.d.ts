/// <reference types="expo/types" />

// Expo generates `expo-env.d.ts` with this same reference, but that file is
// git-ignored and only appears after a local `expo start` or `prebuild`. CI
// checks out a clean tree, so the reference is committed here instead —
// otherwise `tsc --noEmit` fails on a fresh clone with missing Expo globals
// such as `__DEV__`.
