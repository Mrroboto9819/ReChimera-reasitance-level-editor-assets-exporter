import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AnimsetSummary,
  AssetKind,
  AssetMeshes,
  GltfFile,
  Instance,
  LevelFile,
  SoundEntry,
  TexturePayload,
} from "./api";
import { getLevelTexturePng } from "./api";
import { clickMods, type useSelection } from "./selection";

type Selection = ReturnType<typeof useSelection>;

interface HierarchyProps {
  instances: Instance[];
  selection: Selection;
  /** GLTF library — files produced by InsomniaToolset's extract_assets.
   *  Already include skeleton + animations; preferred over the raw .dat
   *  path when present. */
  gltfLibrary?: GltfFile[] | null;
  gltfLibraryStatus?: string | null;
  onPreviewGltfFile?: (file: GltfFile) => void;
  /** All animsets in the open level. Drives the new "Animations"
   *  section — clicking a clip overrides what plays on the primary
   *  selection. */
  animsetClips?: AnimsetSummary[];
  /** Currently-overridden animset hash (when set, the
   *  SkinnedSelectionOverlay plays this clip on the selected character
   *  instead of the moby's own animset). */
  activeAnimsetHash?: string | null;
  /** Toggle handler — pass the hex hash to activate, or call again with
   *  the same hash to deactivate. */
  onSelectAnimset?: (animsetHashHex: string) => void;
  /** All moby assets the level's `assetlookup.dat` references — drives
   *  the path-grouped "Asset Library" tree. Each asset's `name` field
   *  (set by the moby decoder from section 0xD200) is path-style
   *  ("entities/character/weapon/sawgun"), so we can build a folder
   *  hierarchy by splitting on `/`. */
  mobyAssets?: AssetMeshes[];
  /** Same for tie assets — grouped under a sibling subtree. */
  tieAssets?: AssetMeshes[];
  /** Callback fired when a leaf in the Asset Library tree is clicked.
   *  The parent opens `RawCharacterModal` with this asset_tuid so the
   *  user can preview + animate + export ANY asset from the lookup —
   *  not just the ones placed in the world. */
  onPreviewRawAsset?: (assetTuid: string) => void;
  /** Sound bank entries from the level's `resident_sound.dat`. Empty
   *  when not yet loaded or the level has no resident sound bank. */
  sounds?: SoundEntry[];
  /** Name of the sound currently playing (paired with the parent's
   *  Audio element lifetime). Drives the play / pause icon on each
   *  sound row. Null = nothing playing. */
  playingSoundName?: string | null;
  /** Toggle playback of a sound by name. Same name twice = stop;
   *  different name = stop the previous and play the new one. */
  onPlaySound?: (name: string) => void;
  /** Decoded textures from the level's `highmips.dat` / `textures.dat`.
   *  Used for the "Textures" Hierarchy section — each entry has a
   *  PNG-encoded thumbnail. */
  textures?: TexturePayload[];
  /** Level folder path — needed for lazy binary-IPC texture fetches
   *  triggered from the inline preview. Null when no level open. */
  levelFolder?: string;
  /** File-level inventory of the level folder. Surfaces every notable
   *  file (audio, dialogue, lighting, vfx, cinematics, etc.) along
   *  with whether ReChimera currently has a parser for it. */
  levelFiles?: LevelFile[];
}

/** One node in the asset-library path tree. Either a folder (has
 *  children) or a leaf (has an `asset` reference). */
interface AssetTreeNode {
  /** Last path segment — the user-visible label. */
  label: string;
  /** Full path from root, used as a stable React key + for the
   *  collapse-state map. */
  path: string;
  /** Asset kind icon — "moby" or "tie" for leaves; folder nodes
   *  inherit from their first asset child. */
  kind: AssetKind;
  /** When set, this node is a leaf (a single asset). */
  asset?: AssetMeshes;
  /** Sub-folders + leaves. Sorted: folders first (alpha), then leaves
   *  (alpha). */
  children: AssetTreeNode[];
}

/** Build a folder tree from a flat list of assets whose `name` fields
 *  are slash-separated paths. Each path component becomes a folder
 *  node; the final segment is a leaf with the `asset` attached.
 *
 *  e.g. `entities/character/weapon/sawgun` →
 *    entities/ → character/ → weapon/ → sawgun (leaf)
 *
 *  Assets whose names DON'T have slashes go directly under the kind
 *  root with the name as the leaf label. Empty / missing names get a
 *  synthetic label from the asset_tuid.
 */
function buildAssetTree(
  rootLabel: string,
  rootKind: AssetKind,
  assets: AssetMeshes[],
): AssetTreeNode {
  const root: AssetTreeNode = {
    label: rootLabel,
    path: `__root_${rootKind}`,
    kind: rootKind,
    children: [],
  };
  for (const asset of assets) {
    // Fall back to a stable shortened tuid when the asset has no
    // path-style name (ties don't carry one; some mobys have empty
    // name sections too).
    const fullName = asset.name && asset.name.length > 0
      ? asset.name
      : asset.asset_tuid.slice(-12);
    const segments = fullName.split(/[/\\]+/).filter((s) => s.length > 0);
    if (segments.length === 0) {
      // Edge case: empty name. Use the tuid as the leaf label so the
      // user can still click it.
      root.children.push({
        label: asset.asset_tuid.slice(-12),
        path: `${root.path}/${asset.asset_tuid}`,
        kind: rootKind,
        asset,
        children: [],
      });
      continue;
    }
    let cursor = root;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]!;
      const isLeaf = i === segments.length - 1;
      const childPath = `${cursor.path}/${seg}`;
      if (isLeaf) {
        cursor.children.push({
          label: seg,
          path: childPath,
          kind: rootKind,
          asset,
          children: [],
        });
      } else {
        let folder = cursor.children.find(
          (c) => c.path === childPath && !c.asset,
        );
        if (!folder) {
          folder = {
            label: seg,
            path: childPath,
            kind: rootKind,
            children: [],
          };
          cursor.children.push(folder);
        }
        cursor = folder;
      }
    }
  }
  // Recursive sort: folders first (alpha), then leaves (alpha).
  const sortRecursive = (n: AssetTreeNode) => {
    n.children.sort((a, b) => {
      const aFolder = !a.asset;
      const bFolder = !b.asset;
      if (aFolder !== bFolder) return aFolder ? -1 : 1;
      return a.label.localeCompare(b.label);
    });
    for (const c of n.children) sortRecursive(c);
  };
  sortRecursive(root);
  return root;
}

interface Group {
  kind: AssetKind;
  label: string;
  instances: Instance[];
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const KIND_LABELS: Partial<Record<AssetKind, string>> = {
  moby: "Mobys",
  tie: "Ties",
};

const KIND_GLYPHS: Partial<Record<AssetKind, string>> = {
  moby: "M",
  tie: "T",
};

/**
 * Hierarchy/Outliner-style tree (Unity Hierarchy / Unreal World Outliner /
 * Godot Scene). Two-level tree: Kind → Instance.
 *
 * Click semantics:
 * - plain click: single select
 * - ctrl/cmd-click: toggle one
 * - shift-click: range from anchor (last single-clicked) to target
 */
export function Hierarchy({
  instances,
  selection,
  gltfLibrary,
  gltfLibraryStatus,
  onPreviewGltfFile,
  animsetClips,
  activeAnimsetHash,
  onSelectAnimset,
  mobyAssets,
  tieAssets,
  onPreviewRawAsset,
  sounds,
  playingSoundName,
  onPlaySound,
  textures,
  levelFolder,
  levelFiles,
}: HierarchyProps) {
  // Top-level instance groups (Mobys / Ties / …) default to collapsed.
  // We track which ones the user has *expanded* — empty set = all
  // collapsed on first open. With hundreds-to-thousands of entries
  // per kind on bayou, blowing the panel wide open by default
  // overwhelms the section list below.
  const [expandedKinds, setExpandedKinds] = useState<Set<AssetKind>>(new Set());
  // Per-entities-category collapse state (character/object/unique/…). Default
  // collapsed because these lists run into the hundreds of entries — opening
  // them all at once is overwhelming.
  const [gltfCategoryCollapsed, setGltfCategoryCollapsed] = useState<
    Record<string, boolean>
  >({});
  // Animations section starts collapsed — bayou has 39 clips, downtown
  // has more. Don't blow up the panel by default.
  const [animsetsCollapsed, setAnimsetsCollapsed] = useState(true);
  // Sounds section — same default-collapsed treatment. resident_sound.dat
  // typically contains hundreds of named SFX entries.
  const [soundsCollapsed, setSoundsCollapsed] = useState(true);
  // Textures + Files: similarly default-collapsed. Files in particular
  // is mostly a "what's left to port" list — interesting for triage,
  // not for every-session browsing.
  const [texturesCollapsed, setTexturesCollapsed] = useState(true);
  const [filesCollapsed, setFilesCollapsed] = useState(true);
  // Texture preview: when set, renders a small inline panel with the
  // PNG. Click again on the same row to dismiss. Plain inline preview
  // — no modal — keeps the click loop tight.
  //
  // Bytes are fetched lazily via Tauri 2's binary IPC
  // (`get_level_texture_png`) instead of using the eagerly-loaded
  // base64 in `t.png_b64`. This is the "spike" from the Three.js +
  // Tauri perf audit: zero-copy binary IPC bypasses JSON serialization
  // and base64 decode. We hold a Blob URL while the preview is open
  // and revoke it on dismiss / unmount / texture change.
  const [preview, setPreview] = useState<
    { id: number; blobUrl: string | null; loading: boolean; error: string | null } | null
  >(null);
  // Cleanup: revoke the blob URL when the preview is dismissed or the
  // component unmounts. Without this we'd leak object URLs every
  // texture click.
  useEffect(() => {
    return () => {
      if (preview?.blobUrl) URL.revokeObjectURL(preview.blobUrl);
    };
  }, [preview?.blobUrl]);
  // Asset library tree-folder collapse state, keyed by path so each
  // folder remembers its open/closed state across re-renders.
  const [assetLibCollapsed, setAssetLibCollapsed] = useState<
    Record<string, boolean>
  >({});
  const [filter, setFilter] = useState("");

  // Build the path-grouped tree once per asset list change. Memoized
  // because the recursive build + sort is non-trivial when there are
  // hundreds of mobys + ties.
  const assetTree = useMemo(() => {
    const mobys = mobyAssets ?? [];
    const ties = tieAssets ?? [];
    if (mobys.length === 0 && ties.length === 0) return null;
    const roots: AssetTreeNode[] = [];
    if (mobys.length > 0) roots.push(buildAssetTree("Mobys", "moby", mobys));
    if (ties.length > 0) roots.push(buildAssetTree("Ties", "tie", ties));
    return roots;
  }, [mobyAssets, tieAssets]);

  // Hierarchy auto-scroll: when the user picks an instance via the
  // viewport (double-click → primary changes), scroll the matching row
  // into view in this panel. Without this, picking something off-screen
  // selects it but the Hierarchy keeps showing whatever the user was
  // browsing — confusing because the "primary" highlight is invisible.
  //
  // Uses a `data-tuid` attribute on each instance row + a query inside
  // an effect rather than per-row refs because:
  //   1. Refs don't compose well with the variable-length, conditionally-
  //      collapsed sections this Hierarchy has
  //   2. The query runs once per primary change (not per render) so the
  //      cost is negligible
  //   3. If the row is in a collapsed group, scrolling its parent group
  //      header into view is the next-best thing — same data attribute.
  const treeRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const primary = selection.primary;
    if (!primary || !treeRef.current) return;
    // CSS escape the tuid — instance tuids contain `#` (synthetic
    // suffix) and `0x` so a raw selector would parse wrong.
    const safe = (window.CSS && window.CSS.escape ? window.CSS.escape(primary) : primary)
      .replace(/"/g, '\\"');
    const el = treeRef.current.querySelector<HTMLElement>(
      `[data-tuid="${safe}"]`,
    );
    if (el) {
      // `block: "nearest"` avoids jumpy scrolling when the row is
      // already partially visible; `behavior: "smooth"` is fine here
      // because the panel is short.
      el.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [selection.primary]);

  const groups: Group[] = useMemo(() => {
    const byKind = new Map<AssetKind, Instance[]>();
    for (const inst of instances) {
      let arr = byKind.get(inst.kind);
      if (!arr) {
        arr = [];
        byKind.set(inst.kind, arr);
      }
      arr.push(inst);
    }
    const out: Group[] = [];
    for (const [kind, list] of byKind) {
      out.push({
        kind,
        label: KIND_LABELS[kind] ?? kind,
        instances: list,
      });
    }
    out.sort((a, b) => a.label.localeCompare(b.label));
    return out;
  }, [instances]);

  const toggle = (kind: AssetKind) =>
    setExpandedKinds((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });

  const toggleGltfCategory = (cat: string) =>
    setGltfCategoryCollapsed((prev) => ({ ...prev, [cat]: !(prev[cat] ?? true) }));

  // Group GLTF library files by their `category` (first-level subfolder
  // under entities/ — character / object / unique / …). Sorted alpha.
  const gltfByCategory = useMemo(() => {
    if (!gltfLibrary) return null;
    const groups = new Map<string, GltfFile[]>();
    for (const f of gltfLibrary) {
      const key = f.category || "other";
      let arr = groups.get(key);
      if (!arr) {
        arr = [];
        groups.set(key, arr);
      }
      arr.push(f);
    }
    return Array.from(groups.entries())
      .map(([category, files]) => ({ category, files }))
      .sort((a, b) => a.category.localeCompare(b.category));
  }, [gltfLibrary]);

  const filterLower = filter.trim().toLowerCase();

  return (
    <div className="panel pane-hierarchy">
      <div className="panel-header">
        <span>Hierarchy</span>
        <span className="panel-actions">
          {selection.count > 0 && (
            <span className="badge badge-neutral">
              {selection.count.toLocaleString()} sel
            </span>
          )}
          <span className="tree-count">{instances.length.toLocaleString()}</span>
        </span>
      </div>
      <div className="hierarchy-search">
        <input
          type="text"
          placeholder="Filter…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          spellCheck={false}
        />
      </div>
      <div className="panel-body" ref={treeRef}>
        {groups.length === 0 ? (
          <div className="tree-empty">No instances loaded</div>
        ) : (
          <div className="hierarchy-tree">
            {groups.map((g) => {
              const isCollapsed = !expandedKinds.has(g.kind);
              const filtered = filterLower
                ? g.instances.filter((i) =>
                    i.name.toLowerCase().includes(filterLower),
                  )
                : g.instances;
              return (
                <div key={g.kind}>
                  <div className="tree-node" onClick={() => toggle(g.kind)}>
                    <span className="tree-toggle">{isCollapsed ? "▸" : "▾"}</span>
                    <span className={`tree-icon kind-${g.kind}`}>
                      {KIND_GLYPHS[g.kind] ?? "?"}
                    </span>
                    <span className="tree-label">{g.label}</span>
                    <span className="tree-count">
                      {filtered.length === g.instances.length
                        ? g.instances.length.toLocaleString()
                        : `${filtered.length}/${g.instances.length}`}
                    </span>
                  </div>
                  {!isCollapsed && (
                    <div className="tree-children">
                      {filtered.map((inst, idx) => (
                        <div
                          // Defensive: if upstream emits duplicate TUIDs we
                          // suffix with the array index so React keys stay
                          // unique. Real-world R2 levels hit this on a
                          // handful of instances per zone.
                          key={`${inst.tuid}-${idx}`}
                          // `data-tuid` lets the auto-scroll effect locate
                          // the row when the user picks an instance via
                          // the viewport, without needing per-row refs.
                          data-tuid={inst.tuid}
                          className={`tree-node ${
                            selection.isSelected(inst.tuid) ? "selected" : ""
                          } ${selection.primary === inst.tuid ? "primary" : ""}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            selection.select(inst, clickMods(e));
                          }}
                        >
                          <span className="tree-toggle" />
                          <span className={`tree-icon kind-${inst.kind}`}>
                            {KIND_GLYPHS[inst.kind] ?? "?"}
                          </span>
                          <span className="tree-label">
                            {inst.name || (
                              <span className="dim">unnamed</span>
                            )}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}

            {/* (Removed: Character Library section that scanned the
                `<level>/character/` folder. The Asset Library tree at
                the bottom of this Hierarchy is the canonical source
                now — it pulls every moby/tie from `assetlookup.dat`,
                so no filesystem dependency.) */}

            {/* Entities GLTF Library — files from InsomniaToolset's
                extract_assets, scanned across the whole `entities/` tree.
                Each first-level subfolder (character/object/unique/…) gets
                its own collapsible section, mirroring how Mobys/Ties are
                grouped above for placed instances. */}
            {gltfLibraryStatus && !gltfByCategory && (
              <div className="hierarchy-library">
                <div className="tree-node">
                  <span className="tree-toggle" />
                  <span className="tree-icon kind-gltf">G</span>
                  <span className="tree-label dim">{gltfLibraryStatus}</span>
                </div>
              </div>
            )}
            {gltfByCategory && gltfByCategory.length === 0 && !gltfLibraryStatus && (
              <div className="hierarchy-library">
                <div className="tree-node">
                  <span className="tree-toggle" />
                  <span className="tree-icon kind-gltf">G</span>
                  <span className="tree-label dim">No GLTF assets in entities/</span>
                </div>
              </div>
            )}
            {gltfByCategory &&
              gltfByCategory.map(({ category, files }) => {
                const isCollapsed = gltfCategoryCollapsed[category] ?? true;
                const filtered = filterLower
                  ? files.filter((f) =>
                      f.name.toLowerCase().includes(filterLower),
                    )
                  : files;
                const label = `entities/${category}`;
                return (
                  <div className="hierarchy-library" key={`gltf-${category}`}>
                    <div
                      className="tree-node"
                      onClick={() => toggleGltfCategory(category)}
                    >
                      <span className="tree-toggle">
                        {isCollapsed ? "▸" : "▾"}
                      </span>
                      <span className="tree-icon kind-gltf">G</span>
                      <span className="tree-label">{label}</span>
                      <span className="tree-count">
                        {filtered.length === files.length
                          ? files.length.toLocaleString()
                          : `${filtered.length}/${files.length}`}
                      </span>
                    </div>
                    {!isCollapsed && (
                      <div className="tree-children">
                        {filtered.length === 0 && (
                          <div className="tree-empty small">No matches</div>
                        )}
                        {filtered.map((f) => (
                          <div
                            key={f.path}
                            className="tree-node"
                            onClick={(e) => {
                              e.stopPropagation();
                              onPreviewGltfFile?.(f);
                            }}
                            title={f.path}
                          >
                            <span className="tree-toggle" />
                            <span className="tree-icon kind-gltf">G</span>
                            <span className="tree-label small">{f.name}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}

            {/* Animations — every clip in the level's `animsets.dat`,
                browseable. Click one to play it on the primary-selected
                character (overriding the moby's own animset). Click
                again to clear the override. */}
            {animsetClips && animsetClips.length > 0 && (
              <div className="hierarchy-library">
                <div
                  className="tree-node"
                  onClick={() => setAnimsetsCollapsed((v) => !v)}
                >
                  <span className="tree-toggle">
                    {animsetsCollapsed ? "▸" : "▾"}
                  </span>
                  <span className="tree-icon kind-gltf">A</span>
                  <span className="tree-label">Animations</span>
                  <span className="tree-count">
                    {animsetClips.length.toLocaleString()}
                  </span>
                </div>
                {!animsetsCollapsed && (
                  <div className="tree-children">
                    {(() => {
                      const filterLow = filter.trim().toLowerCase();
                      const filtered = filterLow
                        ? animsetClips.filter((c) =>
                            c.name.toLowerCase().includes(filterLow),
                          )
                        : animsetClips;
                      if (filtered.length === 0) {
                        return (
                          <div className="tree-empty small">No matches</div>
                        );
                      }
                      return filtered.map((c) => {
                        const isActive = activeAnimsetHash === c.tuid_hex;
                        const dur =
                          c.frame_rate > 0
                            ? c.num_frames / c.frame_rate
                            : 0;
                        return (
                          <div
                            key={c.tuid_hex}
                            className={`tree-node ${isActive ? "selected" : ""}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              onSelectAnimset?.(c.tuid_hex);
                            }}
                            title={`${c.num_frames} frames @ ${c.frame_rate.toFixed(0)}fps · ${c.num_bones} bones${c.looping ? " · looping" : ""}\n${c.tuid_hex}`}
                          >
                            <span className="tree-toggle">
                              {isActive ? "❚❚" : "▶"}
                            </span>
                            <span className="tree-icon kind-gltf">A</span>
                            <span className="tree-label small">
                              {c.name || "(unnamed)"}
                            </span>
                            <span className="tree-count mono small">
                              {dur.toFixed(2)}s
                            </span>
                          </div>
                        );
                      });
                    })()}
                  </div>
                )}
              </div>
            )}

            {/* Sounds — entries from `<level>/resident_sound.dat`.
                Click a row to play the WAV (decoded ADPCM → PCM by
                the backend on first click, then cached). Streaming
                dialogue (separate `streaming_*.dat` files) shows up
                with kind="stream" and is currently disabled. */}
            {sounds && sounds.length > 0 && (
              <div className="hierarchy-library">
                <div
                  className="tree-node"
                  onClick={() => setSoundsCollapsed((v) => !v)}
                >
                  <span className="tree-toggle">
                    {soundsCollapsed ? "▸" : "▾"}
                  </span>
                  <span className="tree-icon kind-gltf">♪</span>
                  <span className="tree-label">Sounds</span>
                  <span className="tree-count">
                    {sounds.length.toLocaleString()}
                  </span>
                </div>
                {!soundsCollapsed && (
                  <div className="tree-children">
                    {(() => {
                      const f = filterLower
                        ? sounds.filter((s) =>
                            s.name.toLowerCase().includes(filterLower),
                          )
                        : sounds;
                      if (f.length === 0) {
                        return (
                          <div className="tree-empty small">No matches</div>
                        );
                      }
                      return f.map((s, idx) => {
                        const isStream = s.kind === "stream";
                        const isRaw = s.kind === "raw";
                        const isMissing = s.kind === "stream-missing";
                        const isPlaying = playingSoundName === s.name;
                        const tag = isMissing
                          ? "no audio"
                          : isRaw
                            ? "raw"
                            : isStream
                              ? "stream"
                              : null;
                        return (
                          <div
                            // Names can repeat across stream + bank; the
                            // index disambiguates for React reconciliation.
                            key={`${s.name}-${idx}`}
                            className={`tree-node ${isPlaying ? "selected" : ""}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              if (isMissing) return;
                              onPlaySound?.(s.name);
                            }}
                            style={{
                              opacity: isMissing ? 0.45 : 1,
                              cursor: isMissing ? "not-allowed" : "pointer",
                            }}
                            title={
                              isMissing
                                ? `${s.name} — referenced by ${s.source} but its streaming sibling isn't in this folder (audio data not available here)`
                                : isRaw
                                  ? `${s.name} — raw-scanned from ${s.source} (orphan stream · click to ${isPlaying ? "stop" : "play"})`
                                  : isStream
                                    ? `${s.name} — streaming (XVAG/VAG/VPK · click to ${isPlaying ? "stop" : "play"})`
                                    : `${s.name} (click to ${isPlaying ? "stop" : "play"})`
                            }
                          >
                            <span className="tree-toggle">
                              {isMissing ? "—" : isPlaying ? "❚❚" : "▶"}
                            </span>
                            <span className="tree-icon kind-gltf">
                              {isRaw || isStream || isMissing ? "♫" : "♪"}
                            </span>
                            <span className="tree-label small">{s.name || "(unnamed)"}</span>
                            {tag && (
                              <span className="tree-count mono small dim">{tag}</span>
                            )}
                          </div>
                        );
                      });
                    })()}
                  </div>
                )}
              </div>
            )}

            {/* Textures — entries decoded from highmips.dat /
                textures.dat. Each carries a base64 PNG thumbnail;
                clicking a row toggles a small inline preview so the
                user can scan the level's texture set without leaving
                the panel. */}
            {textures && textures.length > 0 && (
              <div className="hierarchy-library">
                <div
                  className="tree-node"
                  onClick={() => setTexturesCollapsed((v) => !v)}
                >
                  <span className="tree-toggle">
                    {texturesCollapsed ? "▸" : "▾"}
                  </span>
                  <span className="tree-icon kind-gltf">▦</span>
                  <span className="tree-label">Textures</span>
                  <span className="tree-count">
                    {textures.length.toLocaleString()}
                  </span>
                </div>
                {!texturesCollapsed && (
                  <div className="tree-children">
                    {(() => {
                      const f = filterLower
                        ? textures.filter(
                            (t) =>
                              String(t.id).includes(filterLower) ||
                              `${t.width}x${t.height}`.includes(filterLower),
                          )
                        : textures;
                      if (f.length === 0) {
                        return (
                          <div className="tree-empty small">No matches</div>
                        );
                      }
                      return f.map((t) => {
                        const isPreviewing = preview?.id === t.id;
                        return (
                          <div key={t.id}>
                            <div
                              className={`tree-node ${isPreviewing ? "selected" : ""}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                if (isPreviewing) {
                                  if (preview?.blobUrl) {
                                    URL.revokeObjectURL(preview.blobUrl);
                                  }
                                  setPreview(null);
                                  return;
                                }
                                if (preview?.blobUrl) {
                                  URL.revokeObjectURL(preview.blobUrl);
                                }
                                if (!levelFolder) {
                                  // No folder = can't lazy-fetch. Should
                                  // never happen since textures are gated
                                  // on a loaded level, but be defensive.
                                  setPreview({
                                    id: t.id,
                                    blobUrl: null,
                                    loading: false,
                                    error: "No level folder",
                                  });
                                  return;
                                }
                                setPreview({
                                  id: t.id,
                                  blobUrl: null,
                                  loading: true,
                                  error: null,
                                });
                                const t0 = performance.now();
                                getLevelTexturePng(levelFolder, t.id)
                                  .then((blob) => {
                                    const dt = performance.now() - t0;
                                    const url = URL.createObjectURL(blob);
                                    console.log(
                                      `[texture-binary-ipc] id=${t.id} ${blob.size}B in ${dt.toFixed(1)}ms`,
                                    );
                                    setPreview((prev) => {
                                      // Bail if the user moved on while
                                      // we were fetching — avoid leaking
                                      // a URL into a stale preview slot.
                                      if (!prev || prev.id !== t.id) {
                                        URL.revokeObjectURL(url);
                                        return prev;
                                      }
                                      return {
                                        id: t.id,
                                        blobUrl: url,
                                        loading: false,
                                        error: null,
                                      };
                                    });
                                  })
                                  .catch((err) => {
                                    setPreview((prev) =>
                                      prev && prev.id === t.id
                                        ? {
                                            id: t.id,
                                            blobUrl: null,
                                            loading: false,
                                            error: String(err),
                                          }
                                        : prev,
                                    );
                                  });
                              }}
                              title={`Texture #${t.id} — ${t.width}×${t.height}`}
                            >
                              <span className="tree-toggle">
                                {isPreviewing ? "▾" : "▸"}
                              </span>
                              <span className="tree-icon kind-gltf">▦</span>
                              <span className="tree-label small">
                                #{t.id}
                              </span>
                              <span className="tree-count mono small dim">
                                {t.width}×{t.height}
                              </span>
                            </div>
                            {isPreviewing && (
                              <div
                                style={{
                                  padding: "6px 8px 8px 28px",
                                }}
                              >
                                {preview?.loading && (
                                  <div className="dim small">Loading…</div>
                                )}
                                {preview?.error && (
                                  <div className="dim small">
                                    Failed: {preview.error}
                                  </div>
                                )}
                                {preview?.blobUrl && (
                                  <img
                                    src={preview.blobUrl}
                                    alt={`Texture ${t.id}`}
                                    style={{
                                      maxWidth: "100%",
                                      maxHeight: 180,
                                      imageRendering: "pixelated",
                                      background: "#222",
                                      border: "1px solid #444",
                                    }}
                                  />
                                )}
                              </div>
                            )}
                          </div>
                        );
                      });
                    })()}
                  </div>
                )}
              </div>
            )}

            {/* Files — every notable file in the level folder,
                grouped by category and badged with whether ReChimera
                has a parser for it. Lets the user see the full
                inventory (audio streams, localization, lipsync,
                lighting, vfx, …) at a glance — including roadmap
                items not yet wired up. */}
            {levelFiles && levelFiles.length > 0 && (
              <div className="hierarchy-library">
                <div
                  className="tree-node"
                  onClick={() => setFilesCollapsed((v) => !v)}
                >
                  <span className="tree-toggle">
                    {filesCollapsed ? "▸" : "▾"}
                  </span>
                  <span className="tree-icon kind-gltf">F</span>
                  <span className="tree-label">Files</span>
                  <span className="tree-count">
                    {levelFiles.length.toLocaleString()}
                  </span>
                </div>
                {!filesCollapsed && (
                  <div className="tree-children">
                    {(() => {
                      const f = filterLower
                        ? levelFiles.filter(
                            (lf) =>
                              lf.name.toLowerCase().includes(filterLower) ||
                              lf.category.includes(filterLower),
                          )
                        : levelFiles;
                      if (f.length === 0) {
                        return (
                          <div className="tree-empty small">No matches</div>
                        );
                      }
                      // Preserve the backend's parsed-first ordering by
                      // walking once and bucketing into the order each
                      // category first appears. Map iteration order is
                      // insertion order in JS, so this is stable.
                      const byCategory = new Map<string, LevelFile[]>();
                      for (const lf of f) {
                        let arr = byCategory.get(lf.category);
                        if (!arr) {
                          arr = [];
                          byCategory.set(lf.category, arr);
                        }
                        arr.push(lf);
                      }
                      return Array.from(byCategory.entries()).map(
                        ([cat, files]) => (
                          <div key={`fcat-${cat}`}>
                            <div
                              className="tree-node"
                              style={{ opacity: 0.7 }}
                            >
                              <span className="tree-toggle" />
                              <span className="tree-icon kind-gltf">·</span>
                              <span className="tree-label small dim">
                                {cat}
                              </span>
                              <span className="tree-count mono small dim">
                                {files.length.toLocaleString()}
                              </span>
                            </div>
                            {files.map((lf) => (
                              <div
                                key={`${cat}-${lf.name}`}
                                className="tree-node"
                                style={{ paddingLeft: 16 }}
                                title={`${lf.name} — ${formatBytes(lf.size_bytes)} · ${lf.parsed ? "parsed" : "not yet parsed"}`}
                              >
                                <span className="tree-toggle" />
                                <span
                                  className="tree-icon kind-gltf"
                                  style={{
                                    opacity: lf.parsed ? 1 : 0.5,
                                  }}
                                >
                                  {lf.parsed ? "✓" : "·"}
                                </span>
                                <span
                                  className="tree-label small"
                                  style={{
                                    opacity: lf.parsed ? 1 : 0.65,
                                  }}
                                >
                                  {lf.name}
                                </span>
                                <span className="tree-count mono small dim">
                                  {formatBytes(lf.size_bytes)}
                                </span>
                              </div>
                            ))}
                          </div>
                        ),
                      );
                    })()}
                  </div>
                )}
              </div>
            )}

            {/* Asset Library — every moby + tie from the level's
                assetlookup.dat, organized by their path-style names
                (entities/character/weapon/sawgun, etc). Replaces the
                "scan the character/ folder on disk" approach: this
                shows the full inventory the level actually references,
                regardless of whether IT extracted it. */}
            {assetTree && assetTree.length > 0 && (
              <>
                {assetTree.map((root) => (
                  <AssetLibraryTree
                    key={root.path}
                    node={root}
                    depth={0}
                    collapsed={assetLibCollapsed}
                    setCollapsed={setAssetLibCollapsed}
                    filter={filterLower}
                    instances={instances}
                    selection={selection}
                    rootCollapsedDefault={true}
                    onPreviewRawAsset={onPreviewRawAsset}
                  />
                ))}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Recursive renderer for the Asset Library tree. Folders collapse
 *  independently via the `collapsed` map; leaves are clickable rows
 *  that select the first placed instance of that asset (so the camera
 *  + Inspector update). When the user typed a filter, only matching
 *  leaves render — folders auto-expand to show matches.
 */
function AssetLibraryTree({
  node,
  depth,
  collapsed,
  setCollapsed,
  filter,
  instances,
  selection,
  rootCollapsedDefault,
  onPreviewRawAsset,
}: {
  node: AssetTreeNode;
  depth: number;
  collapsed: Record<string, boolean>;
  setCollapsed: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  filter: string;
  instances: Instance[];
  selection: Selection;
  rootCollapsedDefault: boolean;
  onPreviewRawAsset?: (assetTuid: string) => void;
}) {
  // Default the root + first-level folders to collapsed (the inventory
  // is hundreds of entries deep on bayou; expanding all at once is
  // overwhelming). Inner folders default to expanded once their parent
  // is open.
  const isRoot = depth === 0;
  const defaultCollapsed = isRoot ? rootCollapsedDefault : false;
  const isCollapsed = collapsed[node.path] ?? defaultCollapsed;

  const toggle = () =>
    setCollapsed((prev) => ({
      ...prev,
      [node.path]: !(prev[node.path] ?? defaultCollapsed),
    }));

  // For leaves, find the first placed instance with this asset_tuid so
  // clicking actually selects something the camera can focus on. If
  // there's no placement (asset is in lookup but not placed in the
  // world), the click still highlights the row but selection no-ops.
  const firstPlaced = node.asset
    ? instances.find(
        (i) => i.kind === node.kind && i.asset_tuid === node.asset!.asset_tuid,
      )
    : null;

  // Filter logic: when the user typed a filter, leaves whose label
  // doesn't match are hidden. Folders are kept if any descendant leaf
  // matches (so the path to the match is visible).
  const matchesFilter = (n: AssetTreeNode): boolean => {
    if (!filter) return true;
    if (n.asset && n.label.toLowerCase().includes(filter)) return true;
    return n.children.some(matchesFilter);
  };
  if (!matchesFilter(node)) return null;

  // Force-expand folders when filtering so the user can see matches
  // without click-walking the tree.
  const renderChildrenExpanded = filter ? true : !isCollapsed;

  if (node.asset) {
    // Leaf row. Two interactions:
    //   - Plain click → open the raw-asset preview modal (mesh +
    //     textures + animations). Works regardless of whether the
    //     asset is placed in the world.
    //   - Ctrl/cmd-click on a PLACED asset → select its first placement
    //     in the world (for camera focus + scene gizmo).
    const isSelected = firstPlaced && selection.isSelected(firstPlaced.tuid);
    const isPrimary =
      firstPlaced && selection.primary === firstPlaced.tuid;
    return (
      <div
        className={`tree-node ${isSelected ? "selected" : ""} ${isPrimary ? "primary" : ""}`}
        style={{ paddingLeft: `${depth * 12}px` }}
        onClick={(e) => {
          e.stopPropagation();
          const mods = clickMods(e);
          if (mods.ctrl && firstPlaced) {
            selection.select(firstPlaced, mods);
          } else if (node.asset && onPreviewRawAsset) {
            onPreviewRawAsset(node.asset.asset_tuid);
          } else if (firstPlaced) {
            selection.select(firstPlaced, mods);
          }
        }}
        title={
          firstPlaced
            ? `${node.asset.asset_tuid}\nClick: open preview · Ctrl-click: select world placement`
            : `${node.asset.asset_tuid}\nClick: open preview (asset is not placed in this level)`
        }
      >
        <span className="tree-toggle" />
        <span className={`tree-icon kind-${node.kind}`}>
          {KIND_GLYPHS[node.kind] ?? "?"}
        </span>
        <span className="tree-label small">{node.label}</span>
        {!firstPlaced && (
          <span className="tree-count mono small dim" title="Asset is in lookup but not placed in the world">
            ∅
          </span>
        )}
      </div>
    );
  }

  // Folder row.
  const leafCount = (function count(n: AssetTreeNode): number {
    if (n.asset) return 1;
    return n.children.reduce((acc, c) => acc + count(c), 0);
  })(node);

  return (
    <div className="hierarchy-library">
      <div
        className="tree-node"
        style={{ paddingLeft: isRoot ? 0 : `${depth * 12}px` }}
        onClick={toggle}
      >
        <span className="tree-toggle">
          {renderChildrenExpanded ? "▾" : "▸"}
        </span>
        <span className={`tree-icon kind-${node.kind}`}>
          {isRoot ? KIND_GLYPHS[node.kind] : "▦"}
        </span>
        <span className="tree-label">{node.label}</span>
        <span className="tree-count">{leafCount.toLocaleString()}</span>
      </div>
      {renderChildrenExpanded && (
        <div className="tree-children">
          {node.children.map((c) => (
            <AssetLibraryTree
              key={c.path}
              node={c}
              depth={depth + 1}
              collapsed={collapsed}
              setCollapsed={setCollapsed}
              filter={filter}
              instances={instances}
              selection={selection}
              rootCollapsedDefault={rootCollapsedDefault}
              onPreviewRawAsset={onPreviewRawAsset}
            />
          ))}
        </div>
      )}
    </div>
  );
}
