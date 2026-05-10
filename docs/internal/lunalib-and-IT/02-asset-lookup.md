# 02 — Asset lookup & level open

Every level folder has an `assetlookup.dat` — a top-level IGHW that
indexes every other `.dat` in the folder by *class kind* and *asset hash*.
Reader: `crates/lunalib/src/assetlookup.rs`.

> ⚠️ **Two layouts exist, both supported.** This chapter covers the
> **V2 / R3 / FFA layout** built around `assetlookup.dat`. Earlier
> R&C Future titles (notably **Tools of Destruction**) use the older
> **TOD layout** with a single `main.dat` instead — assets are
> embedded inside `main.dat` by class ID rather than indexed via a
> sibling pointer table.
>
> Detection lives in `crates/lunalib/src/level_layout.rs::detect_layout`
> (`Tod` if `main.dat` is present, `V2` if `assetlookup.dat` is
> present). The `*_old.rs` modules
> (`moby_old`, `tie_old`, `shader_old`, `texture_old`) implement the
> TOD readers as ports of ReLunacy's `LoadMobysOld` /
> `LoadTiesOld` / `LoadShadersOld` / `LoadTexturesOld`. They emit the
> exact same `MobyAsset` / `TieAsset` / `Texture` / `ShaderInfo`
> types as the V2 readers, so the cache, GLB writer, and modal
> preview don't branch. Status of remaining TOD pieces (zones,
> skeleton + animation, bone palette / skinning) lives in the
> `project_tod_format_layout` memory note — they're skipped pending
> real-data investigation, since ReLunacy's reference doesn't fully
> implement them either.
>
> IT has `Version::TOD` in the enum but no module uses it. **Never
> replace the V2 path when adding TOD support** — the two paths
> coexist via the dispatch in `cache.rs::run_extract`.

**IT reference**: per-kind class IDs and pointer-table layouts mirror
`common/include/insomnia/classes/resource.hpp` — `ResourceShaders`
(0x1d100), `ResourceMobys` (0x1d600), `ResourceTies` (0x1d300),
`ResourceAnimsets` (0x1d700), etc. We re-implement the table walks per
kind in Rust rather than depending on Spike's reflective struct loader.

## Asset kinds we read

```rust
pub enum AssetKind {
    Shaders,
    Highmips,
    Mobys,
    Ties,
    Zones,
    Animset,
    Texture,
    // …
}
```

Each kind has a section in `assetlookup.dat` storing pairs of
`(hash, offset, length)` into the corresponding sibling `.dat`:

```rust
pub struct AssetPointer {
    pub tuid: u64,    // asset hash, e.g. 0x5ED37B1C9C403839 for the Hybrid
    pub offset: u32,  // byte offset into <kind>.dat
    pub length: u32,  // size of the IGHW block at that offset
}
```

## Reading the table

```rust
let file = std::fs::File::open(&path)?;
let mut lookup = AssetLookup::open(BufReader::new(file))?;

// All mobys in the level:
let moby_ptrs: Vec<AssetPointer> = lookup.pointers(AssetKind::Mobys)?;

// To parse a specific moby: seek into mobys.dat by ptr.offset, read
// ptr.length bytes, open as IGHW, parse with parse_moby().
```

`AnimsetIndex::build` (in `cache.rs`) builds a `HashMap<u64, (offset, len)>`
keyed by animset hash so per-asset animset lookups are O(1).

## The Tauri side: `open_level`

```ts
export const openLevel = (folder: string) => invoke<LevelSummary>("open_level", { folder });
```

The Rust `open_level` command:
1. Validates the folder contains `assetlookup.dat`.
2. Opens it once, counts how many of each kind exist.
3. Returns a `LevelSummary` with `{ folder, mobys, ties, terrain, textures, … }` for the toolbar.

It does **not** read any geometry yet. Geometry comes via `extract_level_to_cache`
(see [`app/02-cache.md`](../app/02-cache.md)). Opening a level is cheap;
building the cache is expensive but happens once.

## Edge cases

- **Missing siblings**: a level folder might have `assetlookup.dat` but no
  `mobys.dat` (incomplete extract). `pointers()` returns the table; the
  per-asset reader hits the I/O error. Callers handle this by skipping
  that asset rather than aborting the level open.
- **Animsets shared across mobys**: many mobys reference the same
  `animset_hash`. The per-asset GLB cache key is the moby hash, but the
  animset decode is only done once per animset thanks to the `AnimsetIndex`
  hash map.
