import { Channel } from "@tauri-apps/api/core";
import { Database, Download, RefreshCw, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  loadCachedTextures,
  readCachedAsset,
  readCachedManifest,
  reextractLevelCache,
  type AssetMeshes,
  type CacheEvent,
  type CacheManifest,
  type CacheManifestEntry,
  type Instance,
  type LevelMeshes,
  type TextureBlobMap,
} from "../api";
import { AssetPreview } from "../views/AssetPreview";
import { ExportOptionsModal } from "./ExportOptionsModal";
import type { ExportPicks } from "../views/GlbPreview";
import { Modal } from "./Modal";
import { Button } from "../ui";

interface CacheLibraryModalProps {
  open: boolean;
  onClose: () => void;
  folder: string | null;
  initialAssetTuid?: string | null;
  onRequestExtract?: () => void;
}

type LibraryFilter = "moby" | "tie";

interface MobyRow {
  entry: CacheManifestEntry;
  

  leaf: string;
  
  group: string;
}




function splitPath(entry: CacheManifestEntry): { group: string; leaf: string } {
  if (entry.name && entry.name.length > 0) {
    const parts = entry.name.split("/").filter(Boolean);
    if (parts.length === 0) {
      return { group: "(unnamed)", leaf: entry.name };
    }
    if (parts.length === 1) {
      return { group: "(top-level)", leaf: parts[0]! };
    }
    return {
      group: parts.slice(0, -1).join("/"),
      leaf: parts[parts.length - 1]!,
    };
  }
  return { group: "(unnamed)", leaf: `…${entry.tuid.slice(-6)}` };
}












export function CacheLibraryModal({
  open,
  onClose,
  folder,
  initialAssetTuid,
  onRequestExtract,
}: CacheLibraryModalProps) {
  const [manifest, setManifest] = useState<CacheManifest | null>(null);
  const [manifestError, setManifestError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<LibraryFilter>("moby");
  const [selectedTuid, setSelectedTuid] = useState<string | null>(null);
  const [selectedAsset, setSelectedAsset] = useState<AssetMeshes | null>(null);
  const [selectedTextures, setSelectedTextures] = useState<TextureBlobMap>(
    () => new Map(),
  );
  const [loadingAsset, setLoadingAsset] = useState(false);
  const [exporting, _setExporting] = useState(false);
  const [reextractStatus, setReextractStatus] = useState<string | null>(null);

  
  useEffect(() => {
    if (!open || !folder) {
      setManifest(null);
      setManifestError(null);
      setSelectedTuid(null);
      setSelectedAsset(null);
      return;
    }
    let cancelled = false;
    setManifest(null);
    setManifestError(null);
    readCachedManifest(folder)
      .then((m) => {
        if (cancelled) return;
        setManifest(m);
      })
      .catch((e) => {
        if (cancelled) return;
        setManifestError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [open, folder]);

  
  
  
  
  useEffect(() => {
    if (!folder || !selectedTuid || !manifest) {
      setSelectedAsset(null);
      setSelectedTextures(new Map());
      return;
    }
    const entry = manifest.entries.find(
      (e) => (e.kind === "moby" || e.kind === "tie") && e.tuid === selectedTuid,
    );
    if (!entry) {
      setSelectedAsset(null);
      setSelectedTextures(new Map());
      return;
    }
    let cancelled = false;
    setLoadingAsset(true);
    setSelectedTextures(new Map());
    readCachedAsset(folder, entry.file)
      .then(async (data) => {
        if (cancelled) return;
        const asset = data as AssetMeshes;
        setSelectedAsset(asset);
        
        
        
        
        const ids = new Set<number>();
        for (const m of asset.submeshes) {
          for (const id of [m.albedo_id, m.normal_id, m.emissive_id]) {
            if (typeof id === "number") ids.add(id);
          }
        }
        const blobs = await loadCachedTextures(folder, [...ids]);
        if (cancelled) return;
        setSelectedTextures(blobs);
        setLoadingAsset(false);
      })
      .catch(() => {
        if (cancelled) return;
        setSelectedAsset(null);
        setSelectedTextures(new Map());
        setLoadingAsset(false);
      });
    return () => {
      cancelled = true;
    };
  }, [folder, selectedTuid, manifest]);

  
  
  
  const grouped = useMemo(() => {
    if (!manifest) return [];
    const needle = search.trim().toLowerCase();
    const rows: MobyRow[] = [];
    for (const entry of manifest.entries) {
      if (entry.kind !== filter) continue;
      const { group, leaf } = splitPath(entry);
      if (
        needle &&
        !group.toLowerCase().includes(needle) &&
        !leaf.toLowerCase().includes(needle) &&
        !entry.tuid.toLowerCase().includes(needle)
      ) {
        continue;
      }
      rows.push({ entry, leaf, group });
    }
    rows.sort((a, b) => {
      const g = a.group.localeCompare(b.group);
      return g !== 0 ? g : a.leaf.localeCompare(b.leaf);
    });
    
    const buckets: { group: string; rows: MobyRow[] }[] = [];
    for (const row of rows) {
      const last = buckets[buckets.length - 1];
      if (last && last.group === row.group) {
        last.rows.push(row);
      } else {
        buckets.push({ group: row.group, rows: [row] });
      }
    }
    return buckets;
  }, [manifest, search, filter]);

  
  useEffect(() => {
    setSelectedTuid(null);
  }, [filter]);

  useEffect(() => {
    if (!open || !initialAssetTuid || !manifest) return;
    const entry = manifest.entries.find(
      (e) =>
        (e.kind === "moby" || e.kind === "tie") && e.tuid === initialAssetTuid,
    );
    if (entry) {
      setFilter(entry.kind as LibraryFilter);
      setSelectedTuid(initialAssetTuid);
    }
  }, [open, initialAssetTuid, manifest]);

  const totalShown = useMemo(
    () => grouped.reduce((sum, b) => sum + b.rows.length, 0),
    [grouped],
  );

  
  
  
  
  const previewInstance: Instance | null = selectedAsset
    ? {
        tuid: `${selectedAsset.asset_tuid}#cache`,
        asset_tuid: selectedAsset.asset_tuid,
        kind: filter,
        name: selectedAsset.name || selectedAsset.asset_tuid,
        position: [0, 0, 0],
        quaternion: [0, 0, 0, 1],
        scale: [1, 1, 1],
      }
    : null;

  
  
  
  
  const previewMeshes: LevelMeshes | null = selectedAsset
    ? {
        moby_assets: filter === "moby" ? [selectedAsset] : [],
        tie_assets: filter === "tie" ? [selectedAsset] : [],
        ufrag_meshes: [],
        textures: [...selectedTextures.keys()].map((id) => ({
          id,
          width: 0,
          height: 0,
        })),
      }
    : null;

  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [previewPicks, setPreviewPicks] = useState<ExportPicks>({ byAnimset: {} });

  useEffect(() => {
    setPreviewPicks({ byAnimset: {} });
  }, [selectedTuid]);
  const handleExport = () => {
    if (!selectedAsset || exporting || !folder) return;
    setExportStatus(null);
    setExportModalOpen(true);
  };

  
  
  
  const handleReextract = async () => {
    if (!folder || reextractStatus) return;
    setReextractStatus("Re-extracting…");
    setSelectedTuid(null);
    setSelectedAsset(null);
    setManifest(null);
    const channel = new Channel<CacheEvent>();
    let phase: "mobys" | "ties" | "textures" = "mobys";
    channel.onmessage = (event) => {
      switch (event.type) {
        case "phase":
          phase = event.phase;
          setReextractStatus(`Re-extracting ${phase} 0/${event.total}`);
          break;
        case "progress":
          setReextractStatus((s) =>
            s ? s.replace(/\d+\//, `${event.current}/`) : s,
          );
          break;
        case "done":
          setReextractStatus(null);
          readCachedManifest(folder)
            .then(setManifest)
            .catch((e) => setManifestError(String(e)));
          break;
        case "error":
          setReextractStatus(null);
          setManifestError(event.message);
          break;
      }
    };
    try {
      await reextractLevelCache(folder, channel);
    } catch (e) {
      setReextractStatus(null);
      setManifestError(String(e));
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={
        <span className="cache-library-title">
          <Database size={16} /> Cache Library
        </span>
      }
      subtitle={
        manifest
          ? `${manifest.entries.length} entries · ${manifest.folder}`
          : folder ?? "No level open"
      }
      size="xl"
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          <Button
            variant="primary"
            icon={Download}
            onClick={handleExport}
            disabled={!selectedAsset}
            loading={exporting}
          >
            {exporting ? "Exporting…" : "Export .glb"}
          </Button>
        </>
      }
    >
      <div className="cache-library-body">
        <div className="cache-library-list">
          <div className="cache-library-toolbar">
            <div className="cache-library-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={filter === "moby"}
                className={`cache-library-tab ${filter === "moby" ? "active" : ""}`}
                onClick={() => setFilter("moby")}
              >
                Mobys
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={filter === "tie"}
                className={`cache-library-tab ${filter === "tie" ? "active" : ""}`}
                onClick={() => setFilter("tie")}
              >
                Ties
              </button>
            </div>
            <button
              type="button"
              className="cache-library-reextract"
              onClick={handleReextract}
              disabled={!folder || reextractStatus !== null}
              title="Wipe and rebuild the cache from source .dat files"
            >
              <RefreshCw size={12} />
              Re-extract
            </button>
          </div>
          {reextractStatus && (
            <div className="dim small" style={{ padding: "4px 10px" }}>
              {reextractStatus}
            </div>
          )}
          <div className="cache-library-search">
            <Search size={13} />
            <input
              type="search"
              placeholder="Search by name or TUID"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              spellCheck={false}
            />
            <span className="dim small">{totalShown}</span>
          </div>
          {manifestError && (
            <div className="cache-library-extract-cta">
              <div className="cache-library-extract-title">No cache yet</div>
              <div className="cache-library-extract-hint small dim">
                {manifestError}
              </div>
              {onRequestExtract && (
                <Button
                  variant="primary"
                  icon={Download}
                  onClick={onRequestExtract}
                  disabled={!folder}
                >
                  Extract level to cache
                </Button>
              )}
            </div>
          )}
          {!manifest && !manifestError && (
            <div className="dim small" style={{ padding: 12 }}>
              Loading manifest…
            </div>
          )}
          {manifest &&
            initialAssetTuid &&
            !manifest.entries.some(
              (e) =>
                (e.kind === "moby" || e.kind === "tie") &&
                e.tuid === initialAssetTuid,
            ) && (
              <div className="cache-library-extract-cta">
                <div className="cache-library-extract-title">
                  Asset not in cache
                </div>
                <div className="cache-library-extract-hint small dim">
                  Extract the level to populate this asset.
                </div>
                {onRequestExtract && (
                  <Button
                    variant="primary"
                    icon={Download}
                    onClick={onRequestExtract}
                    disabled={!folder}
                  >
                    Extract level to cache
                  </Button>
                )}
              </div>
            )}
          {manifest && totalShown === 0 && (
            <div className="dim small" style={{ padding: 12 }}>
              No mobys match this search.
            </div>
          )}
          <ul className="cache-library-rows">
            {grouped.map((bucket) => (
              <li key={bucket.group} className="cache-library-bucket">
                <div className="cache-library-group">{bucket.group}</div>
                {bucket.rows.map((row) => {
                  const active = row.entry.tuid === selectedTuid;
                  return (
                    <button
                      key={row.entry.tuid}
                      type="button"
                      className={`cache-library-row ${active ? "active" : ""}`}
                      onClick={() => setSelectedTuid(row.entry.tuid)}
                    >
                      <span className="cache-library-leaf">{row.leaf}</span>
                      <span className="cache-library-tuid mono">
                        {row.entry.tuid.slice(-8)}
                      </span>
                    </button>
                  );
                })}
              </li>
            ))}
          </ul>
        </div>
        <div className="cache-library-preview">
          {!selectedAsset && !loadingAsset && (
            <div className="cache-library-empty dim">
              Select a moby on the left to preview it.
            </div>
          )}
          {loadingAsset && (
            <div className="cache-library-empty dim">Loading asset…</div>
          )}
          {selectedAsset && (
            <>
              <div className="cache-library-canvas">
                <AssetPreview
                  instance={previewInstance}
                  meshes={previewMeshes}
                  textureBlobs={selectedTextures.size > 0 ? selectedTextures : null}
                  cacheFolder={folder ?? undefined}
                  exportPicks={previewPicks}
                  onExportPicksChange={setPreviewPicks}
                />
              </div>
              <dl className="kv cache-library-meta">
                <dt>Name</dt>
                <dd className="mono small">
                  {selectedAsset.name || (
                    <span className="dim">unnamed</span>
                  )}
                </dd>
                <dt>Asset</dt>
                <dd className="mono small">{selectedAsset.asset_tuid}</dd>
                <dt>Submeshes</dt>
                <dd>{selectedAsset.submeshes.length}</dd>
                <dt>Skeleton</dt>
                <dd>
                  {selectedAsset.skeleton
                    ? `${selectedAsset.skeleton.bone_count} bones`
                    : "none"}
                </dd>
                <dt>Animset</dt>
                <dd className="mono small">
                  {selectedAsset.animset_hash ? (
                    selectedAsset.animset_hash
                  ) : (selectedAsset.embedded_animation_count ?? 0) > 0 ? (
                    <span>
                      embedded ({selectedAsset.embedded_animation_count} clips)
                    </span>
                  ) : (
                    <span className="dim">none</span>
                  )}
                </dd>
              </dl>
              <p className="dim small" style={{ marginTop: 8 }}>
                {selectedTextures.size > 0
                  ? `Loaded ${selectedTextures.size} textures from cache. `
                  : "No textures referenced. "}
                The .glb export copies the pre-baked file from
                <code> _rechimera_cache/mobys/</code> — geometry +
                skeleton + animations + textures all embedded.
              </p>
              {exportStatus && (
                <p
                  className="small"
                  style={{
                    marginTop: 4,
                    color: exportStatus.startsWith("Export failed")
                      ? "var(--accent-yellow)"
                      : "var(--text-2)",
                  }}
                >
                  {exportStatus}
                </p>
              )}
            </>
          )}
        </div>
      </div>
      {selectedAsset && folder && (
        <ExportOptionsModal
          open={exportModalOpen}
          folder={folder}
          assetTuidHex={selectedAsset.asset_tuid}
          assetName={selectedAsset.name}
          hasSkeleton={selectedAsset.skeleton != null}
          primaryAnimsetHash={selectedAsset.animset_hash ?? null}
          initialExtraPicks={previewPicks.byAnimset}
          onClose={() => setExportModalOpen(false)}
          onExported={(path, bytes) => {
            setExportStatus(`Exported ${bytes.toLocaleString()} bytes → ${path}`);
          }}
        />
      )}
    </Modal>
  );
}
