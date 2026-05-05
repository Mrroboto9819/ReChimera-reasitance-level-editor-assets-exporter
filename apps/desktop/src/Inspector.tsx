import { useEffect, useState } from "react";
import {
  listAssets,
  type AssetKind,
  type AssetPointer,
  type Instance,
  type LevelSummary,
} from "./api";

function hex(n: number, width = 8): string {
  return "0x" + n.toString(16).toUpperCase().padStart(width, "0");
}

interface InspectorProps {
  summary: LevelSummary;
  selected: Instance | null;
  activeKind: AssetKind | null;
  onActiveKindChange: (kind: AssetKind | null) => void;
}

export function Inspector({
  summary,
  selected,
  activeKind,
  onActiveKindChange,
}: InspectorProps) {
  const [assets, setAssets] = useState<AssetPointer[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!activeKind) {
      setAssets([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    listAssets(summary.folder, activeKind)
      .then((list) => {
        if (!cancelled) setAssets(list);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [summary.folder, activeKind]);

  return (
    <aside className="inspector">
      <div className="inspector-section">
        <h3>Inspector</h3>
        {selected ? (
          <dl className="kv">
            <dt>Name</dt>
            <dd>{selected.name || <span className="dim">—</span>}</dd>
            <dt>Kind</dt>
            <dd>{selected.kind}</dd>
            <dt>Instance</dt>
            <dd className="mono small">{selected.tuid.split("#")[0]}</dd>
            <dt>Asset</dt>
            <dd className="mono small">{selected.asset_tuid}</dd>
            <dt>Position</dt>
            <dd className="mono">
              [{selected.position.map((v) => v.toFixed(2)).join(", ")}]
            </dd>
            <dt>Quaternion</dt>
            <dd className="mono small">
              [{selected.quaternion.map((v) => v.toFixed(3)).join(", ")}]
            </dd>
            <dt>Scale</dt>
            <dd className="mono">
              [{selected.scale.map((v) => v.toFixed(3)).join(", ")}]
            </dd>
            <dt>Source</dt>
            <dd className={selected.real ? "" : "dim"}>
              {selected.real ? "gameplay.dat / zones.dat" : "debug spiral"}
            </dd>
          </dl>
        ) : (
          <p className="dim small">
            Click an instance in the viewport to inspect it.
          </p>
        )}
      </div>

      <div className="inspector-section">
        <h3>Asset table</h3>
        <div className="kind-row">
          {summary.asset_counts.map((c) => (
            <button
              key={c.kind}
              className={[
                "kind",
                activeKind === c.kind ? "active" : "",
                c.present ? "" : "absent",
              ]
                .join(" ")
                .trim()}
              onClick={() =>
                onActiveKindChange(activeKind === c.kind ? null : (c.kind as AssetKind))
              }
              disabled={!c.present}
              title={`section ${hex(c.section_id, 6)}`}
            >
              <span className="kind-name">{c.kind}</span>
              <span className="kind-count">{c.count.toLocaleString()}</span>
            </button>
          ))}
        </div>

        {error && <div className="error small">{error}</div>}

        {activeKind && !error && (
          <div className="asset-scroll inspector-scroll">
            {loading ? (
              <p className="dim small">Loading…</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>TUID</th>
                    <th>Offset</th>
                    <th>Length</th>
                  </tr>
                </thead>
                <tbody>
                  {assets.map((a, i) => (
                    <tr key={`${a.tuid}-${i}`}>
                      <td className="mono">{a.tuid}</td>
                      <td className="mono">{hex(a.offset)}</td>
                      <td className="mono">{hex(a.length, 1)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
