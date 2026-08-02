// Metro treats a CSS import as a side effect on web and a no-op on native;
// TypeScript needs the module declared so `import '@/global.css'` typechecks.
//
// This lives here rather than in expo-env.d.ts because that file is generated
// by Expo and git-ignored, so anything added to it would be lost in CI.
declare module '*.css';
declare module '*.png';
declare module '*.jpg';
declare module '*.svg';
