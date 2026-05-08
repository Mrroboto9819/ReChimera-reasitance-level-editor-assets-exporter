import { useCallback, useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { File, Folder, X } from "lucide-react";
import { Modal } from "./Modal";
import { Button } from "./ui";
import { useFileDrop } from "./useFileDrop";

interface OpenLevelModalProps {
  open: boolean;
  busy: boolean;
  onClose: () => void;
  onOpen: (folderPath: string) => void;
}

/// Accepts a folder drop OR a path ending in `assetlookup.dat`. The
/// caller derives the parent folder from the latter.
function acceptLevelDrop(p: string): boolean {
  if (p.endsWith("assetlookup.dat")) return true;
  // Folders don't have an extension — exclude obvious files. The Tauri
  // drag-drop event delivers absolute paths only, so a path with no
  // extension is almost certainly a directory the user dropped.
  return !/\.[a-z0-9]{1,6}$/i.test(p);
}

function parentDir(p: string): string {
  const sep = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return sep > 0 ? p.slice(0, sep) : p;
}

const RECENT_KEY = "rechimera.recentLevels";
const RECENT_MAX = 6;

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
    /* localStorage may be unavailable in some webview modes */
  }
  return next;
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
}: OpenLevelModalProps) {
  const [path, setPath] = useState("");
  const [warning, setWarning] = useState<string | null>(null);
  const [recent, setRecent] = useState<string[]>([]);

  useEffect(() => {
    if (open) {
      setWarning(null);
      setRecent(loadRecent());
    }
  }, [open]);

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

  const handleDrop = useCallback(
    (paths: string[]) => {
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
    },
    [],
  );

  const dropPhase = useFileDrop({
    enabled: open && !busy,
    accept: acceptLevelDrop,
    onDrop: handleDrop,
  });

  const removeRecent = useCallback((folder: string) => {
    const next = loadRecent().filter((p) => p !== folder);
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
    setRecent(next);
  }, []);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Open level"
      subtitle="Pick a folder containing assetlookup.dat"
      size="lg"
      footer={
        <>
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
      }
    >
      <div className={`open-level ${dropPhase === "over" ? "drop-over" : ""}`}>
        <div className="open-level-droptarget">
          <div className="open-level-droptarget-text">
            {dropPhase === "over"
              ? "Drop to open this level"
              : "Drag a folder or assetlookup.dat here"}
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

        <div className="open-level-hint small dim">
          Supports any folder containing <code>assetlookup.dat</code> —
          Resistance 2/3, Ratchet &amp; Clank Future, and other Insomniac PS3
          titles.
        </div>
      </div>
    </Modal>
  );
}
