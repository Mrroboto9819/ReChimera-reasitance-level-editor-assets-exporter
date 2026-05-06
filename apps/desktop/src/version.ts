import pkg from "../package.json";

// Build-time global injected by Vite's `define` (see vite.config.ts).
// In production builds esbuild replaces every occurrence of
// `__APP_VERSION__` with the JSON-stringified version literal, so the
// reference becomes a constant string. In local dev the substitution
// is occasionally flaky on the first start (config-reload race), so
// we use a `typeof` guard below to fall back to package.json without
// crashing on a `ReferenceError`.
declare const __APP_VERSION__: string;

// Runtime fallback. `pkg.version` reads from
// `apps/desktop/package.json`, which Vite + tsc can both import
// natively because `resolveJsonModule: true` is set in tsconfig.
const RUNTIME_PACKAGE_VERSION = (pkg as { version: string }).version;

/** App version string. Order of resolution:
 *  1. Vite-injected `__APP_VERSION__` constant (production).
 *  2. `package.json` import (local dev fallback).
 *
 *  `typeof __APP_VERSION__ !== "undefined"` short-circuits before the
 *  identifier is dereferenced, so this never throws even when the
 *  build-time replacement didn't run. The release.yml workflow
 *  cross-checks all version sources before cutting a release. */
export const APP_VERSION: string =
  typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : RUNTIME_PACKAGE_VERSION;

/** Repository URL — drives the Help menu links + AboutModal footer. */
export const APP_REPO_URL = "https://github.com/Mrroboto9819/ReChimera";

/** Direct link to the issue tracker — Help menu uses this for bug
 *  reports and feature requests. */
export const APP_ISSUES_URL = `${APP_REPO_URL}/issues`;

/** Open an external URL in the user's default browser via Tauri's
 *  opener plugin. `window.open()` and `<a target="_blank">` don't
 *  behave well inside WebView2 / WKWebView — they either open
 *  in-place or get caught by the webview's popup blocker. Routing
 *  through the opener plugin shells out to the OS handler
 *  (Chrome / Safari / whatever the user has set as default) so
 *  links land where the user expects.
 *
 *  Bind to `<a>` clicks via:
 *    onClick={(e) => { e.preventDefault(); void openExternal(href); }}
 *
 *  Or call directly from menu handlers / button onClicks. */
export async function openExternal(url: string): Promise<void> {
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(url);
}
