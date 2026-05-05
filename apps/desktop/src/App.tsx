import { useCallback, useRef, useState } from "react";
import {
  levelLayout,
  levelMeshes,
  openLevel,
  type AssetKind,
  type Instance,
  type LevelMeshes,
  type LevelSummary,
  type UFragBounds,
} from "./api";
import { Inspector } from "./Inspector";
import { Menu, MenuBar, MenuCheckItem, MenuItem, MenuSpacer } from "./MenuBar";
import { Viewport, type ViewSettings } from "./Viewport";

function folderName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

const DEFAULT_VIEW: ViewSettings = {
  showMobys: true,
  showTies: true,
  showUFrags: true,
  showUFragBounds: false,
  showGrid: true,
  showAxes: true,
  showStats: false,
};

export function App() {
  const [path, setPath] = useState("");
  const [summary, setSummary] = useState<LevelSummary | null>(null);
  const [instances, setInstances] = useState<Instance[]>([]);
  const [ufrags, setUFrags] = useState<UFragBounds[]>([]);
  const [meshes, setMeshes] = useState<LevelMeshes | null>(null);
  const [selected, setSelected] = useState<Instance | null>(null);
  const [activeKind, setActiveKind] = useState<AssetKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [meshStatus, setMeshStatus] = useState<string | null>(null);
  const [view, setView] = useState<ViewSettings>(DEFAULT_VIEW);
  const pathRef = useRef<HTMLInputElement>(null);

  const handleOpen = useCallback(async () => {
    const folder = path.trim();
    if (!folder) return;
    setError(null);
    setBusy(true);
    setSelected(null);
    setActiveKind(null);
    setMeshes(null);
    setMeshStatus(null);
    try {
      const sum = await openLevel(folder);
      setSummary(sum);
      const layout = await levelLayout(sum.folder);
      setInstances(layout.instances);
      setUFrags(layout.ufrags);

      // Mesh decoding can take a moment for a full level — kick it off after
      // the layout renders so the user sees instances immediately.
      setMeshStatus("Decoding meshes…");
      try {
        const m = await levelMeshes(sum.folder);
        setMeshes(m);
        setMeshStatus(null);
      } catch (e) {
        setMeshStatus(`Mesh decode failed: ${e}`);
      }
    } catch (e) {
      setError(String(e));
      setSummary(null);
      setInstances([]);
      setUFrags([]);
    } finally {
      setBusy(false);
    }
  }, [path]);

  const handleClose = useCallback(() => {
    setSummary(null);
    setInstances([]);
    setUFrags([]);
    setMeshes(null);
    setSelected(null);
    setActiveKind(null);
    setError(null);
    setMeshStatus(null);
  }, []);

  const toggle = useCallback(
    (key: keyof ViewSettings) =>
      setView((v) => ({ ...v, [key]: !v[key] })),
    [],
  );

  return (
    <div className="app">
      <MenuBar>
        <span className="brand">ReChimera</span>

        <Menu label="File">
          <MenuItem onSelect={() => pathRef.current?.focus()}>
            Open Level…
          </MenuItem>
          <MenuItem onSelect={handleClose} disabled={!summary}>
            Close Level
          </MenuItem>
        </Menu>

        <Menu label="View">
          <MenuCheckItem checked={view.showGrid} onToggle={() => toggle("showGrid")}>
            Grid
          </MenuCheckItem>
          <MenuCheckItem checked={view.showAxes} onToggle={() => toggle("showAxes")}>
            Axes
          </MenuCheckItem>
          <MenuCheckItem
            checked={view.showStats}
            onToggle={() => toggle("showStats")}
          >
            Stats Overlay
          </MenuCheckItem>
        </Menu>

        <Menu label="Render">
          <MenuCheckItem
            checked={view.showMobys}
            onToggle={() => toggle("showMobys")}
            disabled={!summary}
          >
            Mobys
          </MenuCheckItem>
          <MenuCheckItem
            checked={view.showTies}
            onToggle={() => toggle("showTies")}
            disabled={!summary}
          >
            Ties
          </MenuCheckItem>
          <MenuCheckItem
            checked={view.showUFrags}
            onToggle={() => toggle("showUFrags")}
            disabled={!summary}
          >
            UFrag Terrain
          </MenuCheckItem>
          <MenuCheckItem
            checked={view.showUFragBounds}
            onToggle={() => toggle("showUFragBounds")}
            disabled={!summary}
          >
            UFrag Bounds (debug)
          </MenuCheckItem>
        </Menu>

        <Menu label="About">
          <MenuItem
            onSelect={() => window.open("https://github.com/Mrroboto9819/ReLunacy", "_blank")}
          >
            GitHub
          </MenuItem>
        </Menu>

        <MenuSpacer />

        <input
          ref={pathRef}
          className="menubar-path"
          type="text"
          placeholder="Path to level folder containing assetlookup.dat"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleOpen()}
          disabled={busy}
          spellCheck={false}
        />
        <button
          className="btn btn-primary"
          onClick={handleOpen}
          disabled={busy || !path.trim()}
        >
          {busy ? "…" : "Open"}
        </button>
      </MenuBar>

      {summary && (
        <div className="status-strip">
          <strong>{folderName(summary.folder)}</strong>
          <span className="meta">
            IGHW v{summary.version_major}.{summary.version_minor} ·{" "}
            {summary.sections.length} sections ·{" "}
            {instances.length.toLocaleString()} instances ·{" "}
            {ufrags.length.toLocaleString()} UFrags
            {meshes && (
              <>
                {" · "}
                {meshes.moby_assets.length} mobys / {meshes.tie_assets.length} ties /{" "}
                {meshes.ufrag_meshes.length} terrain chunks decoded
              </>
            )}
            {meshStatus && <span className="dim"> · {meshStatus}</span>}
          </span>
        </div>
      )}

      {error && <div className="error-banner">{error}</div>}

      {summary ? (
        <main className="workspace">
          <Viewport
            instances={instances}
            ufrags={ufrags}
            meshes={meshes}
            selected={selected}
            onSelect={setSelected}
            view={view}
          />
          <Inspector
            summary={summary}
            selected={selected}
            activeKind={activeKind}
            onActiveKindChange={setActiveKind}
          />
        </main>
      ) : (
        !error && (
          <div className="workspace-empty">
            <div className="hint">
              <p>
                Use <span className="kbd">File ▸ Open Level…</span> or paste a level
                folder path above.
              </p>
              <p className="dim">
                The folder must contain <code>assetlookup.dat</code> (Resistance 2/3
                or R&amp;C Future).
              </p>
              <p className="small dim">
                e.g. <code>C:\Users\you\Documents\mods\resistance 2\axbridge_coop</code>
              </p>
            </div>
          </div>
        )
      )}
    </div>
  );
}
