/** Injected at build time by scripts/build-info.cjs (see electron.vite.config.ts). */
declare const __APP_VERSION__: string;
declare const __GIT_COMMIT__: string;
declare const __BUILD_DATE__: string;

export const BUILD = {
  version: __APP_VERSION__,
  commit: __GIT_COMMIT__,
  builtAt: __BUILD_DATE__,
} as const;
