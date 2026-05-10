# 04 — Updater & platforms

Source: `apps/desktop/src/useUpdater.ts`,
`apps/desktop/src/components/UpdateChecker.tsx`,
`apps/desktop/src-tauri/tauri.conf.json` (`plugins.updater`).

## Why split behaviour by platform

We ship builds for Windows, Linux, and macOS. Only Windows is currently
**tested end-to-end** with the Tauri auto-updater. Builds for Linux and
macOS produce valid binaries but the auto-update flow there is unverified.

Rather than serve a half-tested experience to those users (silent
failures, half-applied patches), the in-app update button **redirects
to GitHub Releases** on those platforms. The user downloads the new
`.dmg` / `.AppImage` / `.deb` and installs manually.

## Detection

`@tauri-apps/plugin-os::platform()` returns one of:

```
"windows" | "macos" | "linux" | "android" | "ios" | "freebsd" | "dragonfly" | "netbsd" | "openbsd" | "solaris"
```

We treat anything other than `"windows"` as manual:

```ts
function isAutoUpdateSupported(os: string): boolean {
    return os === "windows";
}
```

## Phase shape

```ts
type UpdatePhase =
  | { kind: "idle" }
  | { kind: "available"; update: Update; manual: boolean }   // ← new manual flag
  | { kind: "downloading"; progress: number; total: number | null }
  | { kind: "ready" }
  | { kind: "error"; message: string };
```

The `manual` flag flows up to the App's update button which switches
copy and behaviour:

| Platform | Button text | onClick |
|---|---|---|
| Windows | `↑ Update available` | `update.downloadAndInstall()` → `relaunch()` |
| macOS / Linux | `↗ Get latest on GitHub` | `openUrl("https://github.com/Mrroboto9819/ReChimera/releases/latest")` |

## Tauri config

`tauri.conf.json`:

```json
"plugins": {
  "updater": {
    "active": true,
    "endpoints": [
      "https://github.com/Mrroboto9819/ReChimera/releases/latest/download/latest.json"
    ],
    "pubkey": "..."
  }
}
```

The `latest.json` file at that endpoint advertises the latest release
version + per-platform binary URLs + signatures. The Tauri updater
plugin's `check()` parses it, compares to `app.version` from the Cargo
package, and returns an `Update` object if newer.

`check()` works on every platform — it just downloads JSON and compares
strings. The download/install step is what's platform-gated, and we
opt out of that on non-Windows.

## Plumbing through the UI

```tsx
{updater.phase.kind === "available" && (
    <button
        className="btn btn-update"
        onClick={() => void updater.install()}
        title={updater.phase.manual
            ? `v${updater.phase.update.version} available — opens GitHub Releases`
            : `Update available — v${updater.phase.update.version}`}
    >
        {updater.phase.manual ? "↗ Get latest on GitHub" : "↑ Update available"}
    </button>
)}
```

`install()` internally checks `manual`:

```ts
const install = useCallback(async () => {
    setPhase((prev) => {
        if (prev.kind !== "available") return prev;
        if (prev.manual) {
            void openUrl(RELEASES_URL).catch(...);
            return prev;                              // stay "available" so the button keeps showing
        }
        // ...else: downloadAndInstall + relaunch path
    });
}, []);
```

So the button state machine on macOS/Linux is essentially: "available
forever, click to bounce to GitHub." On Windows it's the conventional
auto-install path.

## Future work

- Add Linux + macOS to the testing matrix; once verified end-to-end,
  remove the `manual` branch on the supported targets.
- Sign + notarize the macOS build so Gatekeeper doesn't block on first
  run.
- Sign the Windows build (currently unsigned — SmartScreen warns on
  first run).
