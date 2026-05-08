import { useCallback, useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { ArrowLeft, File, Folder, Package, Lock, X } from "lucide-react";
import { Modal } from "./Modal";
import { Button } from "./ui";
import { useFileDrop } from "./useFileDrop";

interface OpenLevelModalProps {
  open: boolean;
  busy: boolean;
  onClose: () => void;
  onOpen: (folderPath: string) => void;
  onPickPsarc?: () => void;
}

type GameId = "r1" | "r2" | "r3" | "rc_tod" | "rc_ffa";
type Step = "game" | "source" | "folder";

interface GameSpec {
  id: GameId;
  label: string;
  short: string;
  supported: boolean;
  logoSrc: string;
  byline: string;
}

const GAMES: GameSpec[] = [
  {
    id: "r1",
    label: "Resistance: Fall of Man",
    short: "RFOM",
    supported: false,
    logoSrc: "/RFOM.webp",
    byline: "PS3 launch title — V1 SCREAM, IGHW v0.2/v1.1",
  },
  {
    id: "r2",
    label: "Resistance 2",
    short: "R2",
    supported: true,
    logoSrc: "/Resistance_2.webp",
    byline: "Tested ✓ — IGHW v1.1, V2 SCREAM banks",
  },
  {
    id: "r3",
    label: "Resistance 3",
    short: "R3",
    supported: true,
    logoSrc: "/Resistance_3.png",
    byline: "Tested ✓ — IGHW v1.1, V2 SCREAM banks",
  },
  {
    id: "rc_tod",
    label: "Ratchet & Clank Future: Tools of Destruction",
    short: "R&C ToD",
    supported: true,
    logoSrc: "/R&C_FTD.webp",
    byline: "Same engine family — IGHW v1.1",
  },
  {
    id: "rc_ffa",
    label: "Ratchet & Clank: Full Frontal Assault",
    short: "R&C FFA",
    supported: true,
    logoSrc: "/R&C_FA.png",
    byline: "Same engine family — IGHW v1.1",
  },
];

function acceptLevelDrop(p: string): boolean {
  if (p.endsWith("assetlookup.dat")) return true;
  return !/\.[a-z0-9]{1,6}$/i.test(p);
}

function parentDir(p: string): string {
  const sep = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return sep > 0 ? p.slice(0, sep) : p;
}

const RECENT_KEY = "rechimera.recentLevels";
const RECENT_MAX = 6;
const SELECTED_GAME_KEY = "rechimera.selectedGame";

function loadRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s) => typeof s === "string") : [];
  } catch {
    return [];
  }
}

function pushRecent(folder: string): string[] {
  const current = loadRecent().filter((p) => p !== folder);
  const next = [folder, ...current].slice(0, RECENT_MAX);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* noop */
  }
  return next;
}

function loadGame(): GameId | null {
  try {
    const raw = localStorage.getItem(SELECTED_GAME_KEY);
    const found = GAMES.find((g) => g.id === raw && g.supported);
    return found?.id ?? null;
  } catch {
    return null;
  }
}

function saveGame(id: GameId) {
  try {
    localStorage.setItem(SELECTED_GAME_KEY, id);
  } catch {
    /* noop */
  }
}

function lastTwoSegments(path: string): string {
  const norm = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = norm.split("/");
  return parts.slice(-2).join(" / ") || norm;
}

export function OpenLevelModal({
  open,
  busy,
  onClose,
  onOpen,
  onPickPsarc,
}: OpenLevelModalProps) {
  const [step, setStep] = useState<Step>("game");
  const [game, setGame] = useState<GameId | null>(null);
  const [path, setPath] = useState("");
  const [warning, setWarning] = useState<string | null>(null);
  const [recent, setRecent] = useState<string[]>([]);

  useEffect(() => {
    if (open) {
      setWarning(null);
      setRecent(loadRecent());
      const persisted = loadGame();
      if (persisted) {
        setGame(persisted);
        setStep("source");
      } else {
        setGame(null);
        setStep("game");
      }
    }
  }, [open]);

  const pickGame = useCallback((id: GameId) => {
    setGame(id);
    saveGame(id);
    setStep("source");
  }, []);

  const handleBrowseFile = useCallback(async () => {
    setWarning(null);
    try {
      const picked = await openDialog({
        directory: false,
        multiple: false,
        title: "Pick assetlookup.dat",
        filters: [
          { name: "Insomniac asset lookup", extensions: ["dat"] },
          { name: "All files", extensions: ["*"] },
        ],
      });
      if (typeof picked !== "string") return;
      const lastSep = Math.max(picked.lastIndexOf("/"), picked.lastIndexOf("\\"));
      const folder = lastSep > 0 ? picked.slice(0, lastSep) : picked;
      const filename = lastSep >= 0 ? picked.slice(lastSep + 1) : picked;
      setPath(folder);
      if (filename.toLowerCase() !== "assetlookup.dat") {
        setWarning(
          `You picked "${filename}" — the parser will look for assetlookup.dat in this folder.`,
        );
      }
    } catch (e) {
      setWarning(`File picker failed: ${e}`);
    }
  }, []);

  const handleBrowseFolder = useCallback(async () => {
    setWarning(null);
    try {
      const picked = await openDialog({
        directory: true,
        multiple: false,
        title: "Pick a level folder",
      });
      if (typeof picked === "string") setPath(picked);
    } catch (e) {
      setWarning(`Folder picker failed: ${e}`);
    }
  }, []);

  const confirm = useCallback(
    (folder: string) => {
      const trimmed = folder.trim();
      if (!trimmed) return;
      pushRecent(trimmed);
      onOpen(trimmed);
    },
    [onOpen],
  );

  const handleConfirm = useCallback(() => confirm(path), [confirm, path]);

  const handleDrop = useCallback((paths: string[]) => {
    if (paths.length === 0) {
      setWarning("Drop a folder or an `assetlookup.dat` file.");
      return;
    }
    const first = paths[0]!;
    const folder = first.toLowerCase().endsWith("assetlookup.dat")
      ? parentDir(first)
      : first;
    setWarning(null);
    setPath(folder);
  }, []);

  const dropPhase = useFileDrop({
    enabled: open && !busy && step === "folder",
    accept: acceptLevelDrop,
    onDrop: handleDrop,
  });

  const removeRecent = useCallback((folder: string) => {
    const next = loadRecent().filter((p) => p !== folder);
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    } catch {
      /* noop */
    }
    setRecent(next);
  }, []);

  const selectedGameSpec = game ? GAMES.find((g) => g.id === game) : null;

  const stepIndex = step === "game" ? 1 : step === "source" ? 2 : 3;
  const subtitle =
    step === "game" ? (
      <span className="dim small">Step 1 / 3 · pick the game these files come from</span>
    ) : step === "source" ? (
      <span className="dim small">
        Step 2 / 3 ·{" "}
        <strong>{selectedGameSpec?.short}</strong> · choose where the data is
      </span>
    ) : (
      <span className="dim small">
        Step 3 / 3 · <strong>{selectedGameSpec?.short}</strong> · point to the level folder
      </span>
    );

  const handlePickPsarc = useCallback(() => {
    onClose();
    onPickPsarc?.();
  }, [onClose, onPickPsarc]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={
        step === "game"
          ? "Pick a game"
          : step === "source"
            ? "Choose source"
            : "Open level"
      }
      subtitle={subtitle}
      size="lg"
      footer={
        step === "folder" ? (
          <>
            <Button onClick={() => setStep("source")} disabled={busy}>
              <ArrowLeft size={12} strokeWidth={2} /> Back
            </Button>
            <Button onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={handleConfirm}
              disabled={!path.trim()}
              loading={busy}
            >
              {busy ? "Loading…" : "Open"}
            </Button>
          </>
        ) : step === "source" ? (
          <>
            <Button onClick={() => setStep("game")}>
              <ArrowLeft size={12} strokeWidth={2} /> Back
            </Button>
            <Button onClick={onClose}>Cancel</Button>
          </>
        ) : (
          <Button onClick={onClose}>Cancel</Button>
        )
      }
    >
      <ol className="wizard-stepbar" aria-hidden>
        <li className={`wizard-step${stepIndex >= 1 ? " is-active" : ""}${stepIndex > 1 ? " is-done" : ""}`}>
          <span className="wizard-step-num">1</span>
          <span className="wizard-step-label">Game</span>
        </li>
        <li className={`wizard-step${stepIndex >= 2 ? " is-active" : ""}${stepIndex > 2 ? " is-done" : ""}`}>
          <span className="wizard-step-num">2</span>
          <span className="wizard-step-label">Source</span>
        </li>
        <li className={`wizard-step${stepIndex >= 3 ? " is-active" : ""}`}>
          <span className="wizard-step-num">3</span>
          <span className="wizard-step-label">Open</span>
        </li>
      </ol>

      {step === "game" && (
        <div className="game-grid">
          {GAMES.map((g) => (
            <button
              key={g.id}
              type="button"
              className={`game-tile${g.supported ? "" : " is-disabled"}`}
              onClick={() => g.supported && pickGame(g.id)}
              disabled={!g.supported}
              title={
                g.supported
                  ? `Open ${g.label}`
                  : `${g.short} — parser support is not implemented yet`
              }
            >
              <div className="game-tile-art">
                <img
                  src={g.logoSrc}
                  alt={g.label}
                  draggable={false}
                  onError={(e) => {
                    (e.currentTarget as HTMLImageElement).style.opacity = "0";
                  }}
                />
                {!g.supported && (
                  <div className="game-tile-lockoverlay">
                    <Lock size={20} strokeWidth={2} />
                    <span className="small">Not yet supported</span>
                  </div>
                )}
              </div>
              <div className="game-tile-meta">
                <div className="game-tile-name">{g.label}</div>
                <div className="game-tile-byline dim small">{g.byline}</div>
              </div>
            </button>
          ))}
        </div>
      )}

      {step === "source" && (
        <div className="source-step">
          {selectedGameSpec && (
            <div className="open-level-game-row">
              <span className="game-card-tag mono">{selectedGameSpec.short}</span>
              <span className="small dim">{selectedGameSpec.label}</span>
              <button
                type="button"
                className="btn"
                onClick={() => setStep("game")}
                title="Pick a different game"
              >
                <ArrowLeft size={12} strokeWidth={2} /> Change
              </button>
            </div>
          )}
          <div className="source-info">
            <strong className="small">📦 Before you start</strong>
            <p className="small dim">
              A level needs <em>every</em> <code>.psarc</code> that ships with
              it extracted into <strong>the same folder</strong>. The parser
              expects <code>assetlookup.dat</code>, <code>mobys.dat</code>,
              <code> ties.dat</code>, <code>shaders.dat</code>,
              <code> textures.dat</code>, <code>highmips.dat</code>,
              <code> animsets.dat</code>, <code>zones.dat</code>, plus the
              level's <code>resident_*.dat</code> / <code>streaming_*.dat</code>
              audio companions, all side-by-side. Missing siblings show up as
              "no audio" badges or empty meshes.
            </p>
          </div>
          <div className="source-grid">
            <button
              type="button"
              className="source-card"
              onClick={() => setStep("folder")}
            >
              <div className="source-card-icon">
                <Folder size={36} strokeWidth={1.4} />
              </div>
              <div className="source-card-title">Open a level folder</div>
              <div className="source-card-sub small dim">
                Already-extracted files. Pick the folder that contains
                <code> assetlookup.dat</code> and its sibling
                <code> .dat</code> files.
              </div>
            </button>
            <button
              type="button"
              className="source-card"
              onClick={handlePickPsarc}
              disabled={!onPickPsarc}
              title={onPickPsarc ? "Extract a .psarc archive" : "PSARC extraction not wired"}
            >
              <div className="source-card-icon">
                <Package size={36} strokeWidth={1.4} />
              </div>
              <div className="source-card-title">Extract a PSARC</div>
              <div className="source-card-sub small dim">
                Unpack a raw <code>.psarc</code>. Repeat for every
                <code> .psarc</code> belonging to this map and point them all
                at the <strong>same destination folder</strong> — then come
                back here and pick "Open a level folder".
              </div>
            </button>
          </div>
        </div>
      )}

      {step === "folder" && (
        <div className={`open-level ${dropPhase === "over" ? "drop-over" : ""}`}>
          {selectedGameSpec && (
            <div className="open-level-game-row">
              <span className="game-card-tag mono">{selectedGameSpec.short}</span>
              <span className="small dim">{selectedGameSpec.label}</span>
              <button
                type="button"
                className="btn"
                onClick={() => setStep("source")}
                title="Back to source choice"
              >
                <ArrowLeft size={12} strokeWidth={2} /> Change
              </button>
            </div>
          )}
          <div className="open-level-droptarget">
            <div className="open-level-droptarget-text">
              {dropPhase === "over"
                ? "Drop to open this level"
                : "Drag a folder or assetlookup.dat here"}
            </div>
            <div className="open-level-droptarget-sub small dim">
              All of the level's <code>.psarc</code> archives must already be
              extracted into this same folder.
            </div>
          </div>
          <div className="open-level-pickers">
            <button
              type="button"
              className="open-level-card"
              onClick={handleBrowseFolder}
              disabled={busy}
            >
              <div className="open-level-card-icon" aria-hidden>
                <Folder size={28} strokeWidth={1.5} />
              </div>
              <div className="open-level-card-text">
                <div className="open-level-card-title">Pick a folder</div>
                <div className="open-level-card-sub small dim">
                  Select the directory directly
                </div>
              </div>
            </button>
            <button
              type="button"
              className="open-level-card"
              onClick={handleBrowseFile}
              disabled={busy}
            >
              <div className="open-level-card-icon" aria-hidden>
                <File size={28} strokeWidth={1.5} />
              </div>
              <div className="open-level-card-text">
                <div className="open-level-card-title">
                  Pick <code>assetlookup.dat</code>
                </div>
                <div className="open-level-card-sub small dim">
                  We'll use the parent folder
                </div>
              </div>
            </button>
          </div>

          <label className="open-level-field">
            <span className="open-level-field-label small dim">
              Or paste a path
            </span>
            <input
              type="text"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleConfirm();
              }}
              placeholder="C:\\path\\to\\level"
              spellCheck={false}
              disabled={busy}
            />
          </label>

          {warning && <div className="open-level-warning">{warning}</div>}

          {recent.length > 0 && (
            <div className="open-level-recent">
              <div className="open-level-section-title small dim">Recent</div>
              <ul className="open-level-recent-list">
                {recent.map((folder) => (
                  <li key={folder} className="open-level-recent-item">
                    <button
                      type="button"
                      className="open-level-recent-btn"
                      onClick={() => confirm(folder)}
                      disabled={busy}
                      title={folder}
                    >
                      <span className="open-level-recent-name">
                        {lastTwoSegments(folder)}
                      </span>
                      <span className="open-level-recent-path mono small dim">
                        {folder}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="open-level-recent-remove"
                      onClick={() => removeRecent(folder)}
                      title="Remove from recent"
                      aria-label="Remove"
                    >
                      <X size={14} strokeWidth={2} />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
