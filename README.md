# ReChimera

A Rust + Tauri reimplementation of the ReLunacy / LibLunacy parser, scoped at
**loading Resistance 2 and 3 levels** via their `assetlookup.dat`.

License: **GPL-3.0-or-later** (inherited from ReLunacy and InsomniaToolset).

## Layout

```
ReChimera/
├── Cargo.toml                  # virtual workspace
├── crates/
│   └── lunalib/                # parser library
│       ├── src/
│       │   ├── lib.rs
│       │   ├── error.rs
│       │   ├── stream.rs       # big-endian PS3 reader
│       │   ├── igfile.rs       # IGHW container parser
│       │   └── assetlookup.rs  # AssetPointer table reader
│       ├── examples/dump_assetlookup.rs
│       └── tests/synthetic_assetlookup.rs
└── apps/
    └── desktop/                # Tauri 2 + Vite + React + TS app
        ├── package.json        # bun-managed
        ├── vite.config.ts
        ├── index.html
        ├── src/
        │   ├── main.tsx
        │   ├── App.tsx
        │   ├── api.ts          # typed wrappers around invoke()
        │   └── styles.css
        └── src-tauri/
            ├── Cargo.toml
            ├── build.rs
            ├── tauri.conf.json
            ├── capabilities/default.json
            ├── icons/icon.ico
            └── src/main.rs     # open_level / list_assets commands
```

## Step 1 (this commit) — parser foundation

Ports the load-bearing pieces of [LibLunacy](../LibLunacy/):

- `StreamHelper` — endian-aware reader (PS3 = big-endian; switches to
  little if the magic comes back swapped).
- `IgFile` — IGHW container header + section table parser. Supports v0.2
  and v1.1, masks the `0x10000000` flag bit on `count` (matching
  [LibLunacy/IGFile.cs:58](../LibLunacy/IGFile.cs#L58)).
- `AssetLookup` — high-level wrapper that returns `AssetPointer` arrays
  for shaders / high-mip textures / ties / mobys / zones.

### Build & run

```powershell
cd ReChimera
cargo test                      # unit + integration tests (no real data needed)
cargo run -p lunalib --example dump_assetlookup -- "<path>\assetlookup.dat"
```

The example prints the IGHW version, the full section table, and per-kind
asset counts. That output is the first sanity check that section IDs match
between R&C Future (where they were derived) and Resistance 2/3.

### Section-ID caveat

The IDs in [`assetlookup.rs`](crates/lunalib/src/assetlookup.rs) are the ones
[LibLunacy/AssetLoader.cs](../LibLunacy/AssetLoader.cs) uses for the
"new engine" path — confirmed against R&C Future. Resistance 2/3 are the
same engine generation, but if `dump_assetlookup` shows a Resistance dump
with all kinds reading "not present," the IDs differ and we cross-reference
[InsomniaToolset/common/include/insomnia/classes/](../InsomniaToolset/common/include/insomnia/classes/)
to find the correct values.

## Step 2 (this commit) — Tauri shell

A Tauri 2 desktop app at [`apps/desktop/`](apps/desktop) wraps the parser
behind two commands and ships a React UI for browsing the asset table.

**Tauri commands** ([apps/desktop/src-tauri/src/main.rs](apps/desktop/src-tauri/src/main.rs)):

| Command | Returns |
| --- | --- |
| `open_level(folder)` | IGHW version, full section table, per-kind counts |
| `list_assets(folder, kind)` | `[{tuid, offset, length}]` for one asset kind |

**UI** ([apps/desktop/src/App.tsx](apps/desktop/src/App.tsx)):

- Path input → opens any folder containing `assetlookup.dat`.
- Per-kind chips (shader / highmip / tie / moby / zone) showing counts; absent
  kinds are dimmed.
- Sortable, scrollable asset table with hex-formatted TUID/offset/length.

### Run

Prerequisites: Rust toolchain, [bun](https://bun.sh), and (on Windows) WebView2
(pre-installed on Windows 11).

```powershell
cd ReChimera/apps/desktop
bun install                 # one-time
bun run tauri:dev           # launches the app with Vite hot-reload
```

The first `tauri:dev` recompiles the entire Tauri stack (~1–2 min); subsequent
launches are seconds. Frontend changes hot-reload without restarting Rust.

For a release build (no bundling, just an exe):

```powershell
bun run build               # builds the React bundle into dist/
cargo run -p rechimera-desktop --release
```

## Step 3+ — per-asset decoders

Port from [LibLunacy/Moby.cs](../LibLunacy/Moby.cs),
[Tie.cs](../LibLunacy/Tie.cs), [Texture.cs](../LibLunacy/Texture.cs),
[Shader.cs](../LibLunacy/Shader.cs), [Zone.cs](../LibLunacy/Zone.cs).
Cross-reference InsomniaToolset's C++ headers for layout differences across
the engine generation.
