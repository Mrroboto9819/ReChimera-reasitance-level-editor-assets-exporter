import { useMemo, useState } from "react";
import type { AssetKind, AssetMeshes, GltfFile, Instance } from "./api";
import { clickMods, type useSelection } from "./selection";

type Selection = ReturnType<typeof useSelection>;

interface HierarchyProps {
  instances: Instance[];
  selection: Selection;
  /** Optional library — characters / weapons / enemies from
   *  `<level>/character/`. Shown in a separate "Library" section.
   *  null when the level has no character folder. */
  library?: { assets: AssetMeshes[] } | null;
  libraryStatus?: string | null;
  /** Triggered when the user clicks a library asset — parent opens the
   *  CharacterPreviewModal. */
  onPreviewLibraryAsset?: (assetTuid: string) => void;
  /** GLTF library — files produced by InsomniaToolset's extract_assets.
   *  Already include skeleton + animations; preferred over the raw .dat
   *  path when present. */
  gltfLibrary?: GltfFile[] | null;
  gltfLibraryStatus?: string | null;
  onPreviewGltfFile?: (file: GltfFile) => void;
}

interface Group {
  kind: AssetKind;
  label: string;
  instances: Instance[];
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
  library,
  libraryStatus,
  onPreviewLibraryAsset,
  gltfLibrary,
  gltfLibraryStatus,
  onPreviewGltfFile,
}: HierarchyProps) {
  const [collapsed, setCollapsed] = useState<Set<AssetKind>>(new Set());
  const [libraryCollapsed, setLibraryCollapsed] = useState(false);
  // Per-entities-category collapse state (character/object/unique/…). Default
  // collapsed because these lists run into the hundreds of entries — opening
  // them all at once is overwhelming.
  const [gltfCategoryCollapsed, setGltfCategoryCollapsed] = useState<
    Record<string, boolean>
  >({});
  const [filter, setFilter] = useState("");

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
    setCollapsed((prev) => {
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
      <div className="panel-body">
        {groups.length === 0 ? (
          <div className="tree-empty">No instances loaded</div>
        ) : (
          <div className="hierarchy-tree">
            {groups.map((g) => {
              const isCollapsed = collapsed.has(g.kind);
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

            {/* Library section — characters / weapons / enemies that exist
                in the level's `character/` folder but aren't placed in the
                world. Click an entry to preview + export it. */}
            {(library || libraryStatus) && (
              <div className="hierarchy-library">
                <div
                  className="tree-node"
                  onClick={() => setLibraryCollapsed((v) => !v)}
                >
                  <span className="tree-toggle">
                    {libraryCollapsed ? "▸" : "▾"}
                  </span>
                  <span className="tree-icon kind-library">L</span>
                  <span className="tree-label">Character Library</span>
                  <span className="tree-count">
                    {library
                      ? library.assets.length.toLocaleString()
                      : "…"}
                  </span>
                </div>
                {!libraryCollapsed && (
                  <div className="tree-children">
                    {libraryStatus && (
                      <div className="tree-empty small">{libraryStatus}</div>
                    )}
                    {library &&
                      library.assets.length === 0 &&
                      !libraryStatus && (
                        <div className="tree-empty small">
                          No assets in <code>character/</code>
                        </div>
                      )}
                    {library &&
                      library.assets
                        .filter((a) =>
                          filterLower
                            ? a.asset_tuid
                                .toLowerCase()
                                .includes(filterLower)
                            : true,
                        )
                        .map((a) => (
                          <div
                            key={a.asset_tuid}
                            className="tree-node"
                            onClick={(e) => {
                              e.stopPropagation();
                              onPreviewLibraryAsset?.(a.asset_tuid);
                            }}
                          >
                            <span className="tree-toggle" />
                            <span className="tree-icon kind-library">L</span>
                            <span
                              className="tree-label mono small"
                              title={a.asset_tuid}
                            >
                              {a.asset_tuid.slice(-10)}
                            </span>
                          </div>
                        ))}
                  </div>
                )}
              </div>
            )}

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
          </div>
        )}
      </div>
    </div>
  );
}
