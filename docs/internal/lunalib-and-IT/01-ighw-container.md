# 01 — IGHW container format

IGHW (`'WHGI'` magic on disk, BE: `0x49474857`) is Insomniac's universal
binary container. Every `.dat` file in a level — `mobys.dat`, `ties.dat`,
`zones.dat`, `assetlookup.dat`, etc. — is one or more IGHW blocks. Reader
lives in `crates/lunalib/src/igfile.rs`.

## Byte layout

```
+0x00  uint32   magic         'WHGI' BE  (auto-flips to LE if it's 'IGHW')
+0x04  uint16   versionMajor
+0x06  uint16   versionMinor
+0x08  uint32   sectionCount
+0x0C  uint32   headerLength       (v1.1 only)
+0x10  uint32   fileLength         (v1.1 only)
+0x14  uint32   reserved           (v1.1 only)
+0x18  uint64   DEADDEAD           (v1.1 only — must NOT equal 0xDEADDEAD)
+0x10/0x20  begin section table:
       SectionHeader[sectionCount]
+...  data region pointed at by each section's `offset`
```

`(versionMajor, versionMinor)` selects header layout:
- `(0, 2)` — RFOM-era, sections start at +0x10
- `(1, 1)` — TOD/V2/R3-era, sections start at +0x20

We do not support other versions.

## Section table

Each entry is 16 bytes:

```rust
pub struct SectionHeader {
    pub id: u32,       // class id, e.g. 0xD100 = MobyV2
    pub offset: u32,   // byte offset into the data region
    pub count: u32,    // element count (high bit 0x10000000 masked off)
    pub length: u32,   // per-element size (Array) or buffer size (Buffer)
}
```

A section is **either**:
- an array of `count` elements each `length` bytes (most common — bones, primitives, animations), **or**
- a single buffer of `length` bytes (vertex / index buffers, shader tables).

## Endian-flip

PS3 files are big-endian. Our reader auto-detects:

```rust
match magic {
    MAGIC_BIG => {}                          // 'WHGI' = BE
    MAGIC_LITTLE => sh.endian = Endian::Little,  // 'IGHW' = pre-swapped
    other => return Err(BadMagic(other)),
}
```

After this, every `read_u16` / `read_u32` / `read_f32` on the underlying
`StreamHelper` decodes from the correct endian transparently.

## How chapters that follow use it

```rust
let mut ig = IgFile::open(reader)?;

// Get the first section by id (most parsers want this):
let section = ig.require_section(SECT_MOBY_HEADER)?;
ig.stream.seek_to(u64::from(section.offset))?;
let num_bones = ig.stream.read_u16()?;

// Iterate every section with a given id (used for animsets — multiple
// 0xF000 sections mean multiple animation clips):
for s in ig.sections.iter().filter(|s| s.id == SECT_ANIMATION) {
    let count = s.count.max(1);
    let stride = u64::from(s.length);
    for i in 0..count {
        let off = u64::from(s.offset) + (i as u64) * stride;
        // parse one Animation header at `off`
    }
}
```

## The class-id catalogue

A non-exhaustive list of section ids you'll see in lunalib:

| ID | Class | Defined in |
|---|---|---|
| `0xD100` | MobyV2 (animated character/object header) | `moby.rs` |
| `0xD200` | Moby name string | `moby.rs` |
| `0xD300` | Skeleton header | `skeleton.rs` |
| `0xDD00` | PrimitiveV2 (per-submesh struct) | `moby.rs` |
| `0xE100` | Index buffer | `moby.rs` |
| `0xE200` | Vertex buffer | `moby.rs` |
| `0xF000` | Animation header (one per clip) | `animation.rs` |
| `0x5600` | Shader resource lookup | `shader.rs` |
| `0x3000`, `0x3200`, `0x3300`, `0x3400` | Tie geometry | `tie.rs` |

The full registry is mirrored from InsomniaToolset's
`common/include/insomnia/classes/`.
