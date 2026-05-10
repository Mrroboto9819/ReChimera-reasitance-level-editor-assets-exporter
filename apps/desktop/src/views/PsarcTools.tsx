import { useCallback, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  psarcExtractStream,
  psarcList,
  type PsarcListDto,
} from "../api";

interface ExtractStatus {
  total: number;
  current: number;
  lastFile: string;
}














export function PsarcTools() {
  const [inputPath, setInputPath] = useState("");
  const [outputPath, setOutputPath] = useState("");
  const [info, setInfo] = useState<PsarcListDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [progress, setProgress] = useState<ExtractStatus | null>(null);
  // Mirror of progress.total — used inside the streaming callback so we
  // don't capture a stale value from the React render closure.
  const totalRef = useRef(0);

  const handleBrowseInput = useCallback(async () => {
    try {
      const picked = await openDialog({
        directory: false,
        multiple: false,
        title: "Pick a .psarc archive",
        filters: [
          { name: "PlayStation Archive", extensions: ["psarc", "PSARC"] },
          { name: "All files", extensions: ["*"] },
        ],
      });
      if (typeof picked === "string") setInputPath(picked);
    } catch (e) {
      setError(`File picker failed: ${e}`);
    }
  }, []);

  const handleBrowseOutput = useCallback(async () => {
    try {
      const picked = await openDialog({
        directory: true,
        multiple: false,
        title: "Pick an output folder",
      });
      if (typeof picked === "string") setOutputPath(picked);
    } catch (e) {
      setError(`Folder picker failed: ${e}`);
    }
  }, []);

  const handleList = useCallback(async () => {
    if (!inputPath.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const list = await psarcList(inputPath.trim());
      setInfo(list);
    } catch (e) {
      setError(String(e));
      setInfo(null);
    } finally {
      setBusy(false);
    }
  }, [inputPath]);

  const handleExtract = useCallback(async () => {
    if (!inputPath.trim() || !outputPath.trim()) return;
    setBusy(true);
    setError(null);
    totalRef.current = 0;
    setProgress({ total: 0, current: 0, lastFile: "" });
    try {
      await psarcExtractStream(inputPath.trim(), outputPath.trim(), (e) => {
        switch (e.type) {
          case "total":
            totalRef.current = e.total;
            setProgress({ total: e.total, current: 0, lastFile: "" });
            break;
          case "file":
            setProgress({
              total: totalRef.current,
              current: e.index,
              lastFile: e.name,
            });
            break;
          case "done":
            setProgress((p) =>
              p ? { ...p, current: p.total, lastFile: "Done." } : p,
            );
            break;
          case "error":
            setError(e.message);
            break;
        }
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [inputPath, outputPath]);

  const filteredEntries = info?.entries.filter((e) =>
    filter ? e.name.toLowerCase().includes(filter.toLowerCase()) : true,
  );

  const pct =
    progress && progress.total > 0
      ? Math.min(100, (progress.current / progress.total) * 100)
      : 0;

  return (
    <div className="psarc-tools">
      <div className="psarc-controls">
        <div className="psarc-row">
          <label className="psarc-label">Input archive</label>
          <input
            type="text"
            value={inputPath}
            onChange={(e) => setInputPath(e.target.value)}
            placeholder="Click Browse… or paste a path to a .psarc"
            spellCheck={false}
            disabled={busy}
          />
          <button
            className="btn"
            onClick={handleBrowseInput}
            disabled={busy}
            title="Pick a .psarc file via the OS dialog"
          >
            Browse…
          </button>
          <button
            className="btn"
            onClick={handleList}
            disabled={busy || !inputPath.trim()}
          >
            List
          </button>
        </div>
        <div className="psarc-row">
          <label className="psarc-label">Output folder</label>
          <input
            type="text"
            value={outputPath}
            onChange={(e) => setOutputPath(e.target.value)}
            placeholder="Click Browse… or paste a destination folder"
            spellCheck={false}
            disabled={busy}
          />
          <button
            className="btn"
            onClick={handleBrowseOutput}
            disabled={busy}
            title="Pick an output folder via the OS dialog"
          >
            Browse…
          </button>
          <button
            className="btn btn-primary"
            onClick={handleExtract}
            disabled={busy || !inputPath.trim() || !outputPath.trim()}
          >
            {busy && progress ? "Extracting…" : "Extract all"}
          </button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {info && (
        <div className="psarc-info">
          <div className="psarc-meta">
            <span>
              <span className="dim">v</span>
              {info.major}.{info.minor}
            </span>
            <span>
              <span className="dim">comp</span> {info.compression}
            </span>
            <span>
              <span className="dim">block</span>{" "}
              {info.block_size.toLocaleString()}B
            </span>
            <span>
              <strong>{info.entry_count.toLocaleString()}</strong> files
            </span>
          </div>

          {progress && progress.total > 0 && (
            <div className="psarc-progress">
              <div className="load-progress-bar">
                <div
                  className="load-progress-fill"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <div className="psarc-progress-meta">
                <span className="mono small">
                  {progress.current.toLocaleString()} /{" "}
                  {progress.total.toLocaleString()}
                </span>
                <span
                  className="mono small dim"
                  style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    maxWidth: "60%",
                  }}
                >
                  {progress.lastFile}
                </span>
              </div>
            </div>
          )}

          <div className="psarc-search">
            <input
              type="text"
              placeholder="Filter files…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              spellCheck={false}
            />
          </div>

          <div className="psarc-table-wrap">
            <table className="psarc-table">
              <thead>
                <tr>
                  <th>Path</th>
                  <th style={{ width: 90, textAlign: "right" }}>Size</th>
                </tr>
              </thead>
              <tbody>
                {(filteredEntries ?? []).slice(0, 1000).map((e, i) => (
                  <tr key={`${e.name}-${i}`}>
                    <td className="mono small">{e.name || <em>unnamed</em>}</td>
                    <td className="mono small" style={{ textAlign: "right" }}>
                      {e.uncompressed_size.toLocaleString()}
                    </td>
                  </tr>
                ))}
                {(filteredEntries?.length ?? 0) > 1000 && (
                  <tr>
                    <td colSpan={2} className="dim small" style={{ padding: 6 }}>
                      showing first 1000 of{" "}
                      {(filteredEntries?.length ?? 0).toLocaleString()}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {!info && !error && (
        <div className="tree-empty">
          Enter a path to a <code>.psarc</code> file and click{" "}
          <strong>List</strong> to inspect it.
          <p className="dim small" style={{ marginTop: 6 }}>
            Supports ZLIB-compressed PSAR v1.3 / v1.4 archives (most PS3-era
            games). LZMA and OODLE are recognized but not yet decoded.
          </p>
        </div>
      )}
    </div>
  );
}
