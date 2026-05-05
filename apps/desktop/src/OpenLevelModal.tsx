import { useCallback, useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Modal } from "./Modal";

interface OpenLevelModalProps {
  open: boolean;
  busy: boolean;
  onClose: () => void;
  /**
   * Called when the user confirms a path. Parent is responsible for
   * actually triggering the level load and showing the loading-progress
   * modal afterward.
   */
  onOpen: (folderPath: string) => void;
}

/**
 * "Open Level" picker modal. Replaces the cramped path-input strip that
 * used to live in the title bar's menu bar.
 *
 * Workflow:
 *   1. User clicks Browse… → OS native file picker opens, filtered to
 *      assetlookup.dat (the marker file that identifies an Insomniac
 *      level folder). User picks the file.
 *   2. We extract the parent directory as the level folder path.
 *   3. User can also paste a folder path directly into the field.
 *   4. Click Open → parent triggers the actual level load.
 */
export function OpenLevelModal({
  open,
  busy,
  onClose,
  onOpen,
}: OpenLevelModalProps) {
  const [path, setPath] = useState("");
  const [warning, setWarning] = useState<string | null>(null);

  // Reset on open/close so the field doesn't carry stale paths between
  // sessions. The user typically picks a different level each time.
  useEffect(() => {
    if (open) setWarning(null);
  }, [open]);

  const handleBrowse = useCallback(async () => {
    setWarning(null);
    try {
      const picked = await openDialog({
        directory: false,
        multiple: false,
        title: "Pick assetlookup.dat (or any .dat in the level folder)",
        filters: [
          {
            name: "Insomniac asset lookup",
            extensions: ["dat"],
          },
          {
            name: "All files",
            extensions: ["*"],
          },
        ],
      });
      if (typeof picked !== "string") return;

      // Extract the parent folder — works for both `/` and `\` separators.
      const lastSep = Math.max(picked.lastIndexOf("/"), picked.lastIndexOf("\\"));
      const folder = lastSep > 0 ? picked.slice(0, lastSep) : picked;
      const filename = lastSep >= 0 ? picked.slice(lastSep + 1) : picked;

      setPath(folder);

      // Helpful nudge if they picked the wrong file. Not a hard error —
      // a level folder might be referred to by some other .dat marker in
      // the future, and the underlying parser will reject if it can't
      // find assetlookup.dat anyway.
      if (filename.toLowerCase() !== "assetlookup.dat") {
        setWarning(
          `You picked “${filename}” — the parser will look for assetlookup.dat in this folder.`,
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

  const handleConfirm = useCallback(() => {
    const trimmed = path.trim();
    if (!trimmed) return;
    onOpen(trimmed);
  }, [path, onOpen]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Open level"
      subtitle="Pick the level folder containing assetlookup.dat"
      size="lg"
      footer={
        <>
          <button
            type="button"
            className="btn"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleConfirm}
            disabled={busy || !path.trim()}
          >
            {busy ? "Loading…" : "Open"}
          </button>
        </>
      }
    >
      <div className="open-level">
        <div className="psarc-row">
          <label className="psarc-label">Folder</label>
          <input
            type="text"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleConfirm();
            }}
            placeholder="Pick a file or folder, or paste a path"
            spellCheck={false}
            disabled={busy}
            autoFocus
          />
        </div>
        <div className="open-level-actions">
          <button
            type="button"
            className="btn"
            onClick={handleBrowse}
            disabled={busy}
            title="Pick assetlookup.dat — we'll use the parent folder"
          >
            Browse for <code>assetlookup.dat</code>…
          </button>
          <button
            type="button"
            className="btn"
            onClick={handleBrowseFolder}
            disabled={busy}
            title="Pick a folder directly"
          >
            Browse folder…
          </button>
        </div>

        {warning && <div className="open-level-warning">{warning}</div>}

        <div className="open-level-hint dim small">
          Supports any folder containing <code>assetlookup.dat</code> —
          Resistance 2/3, Ratchet &amp; Clank Future, and other Insomniac PS3
          titles using the new-engine asset format.
        </div>
      </div>
    </Modal>
  );
}
