import { useState } from "react";
import type { AssetMeshes, Instance, LevelMeshes, TexturePayload } from "./api";
import { AssetPreview } from "./AssetPreview";
import { Modal } from "./Modal";

interface CharacterPreviewModalProps {
  
  charTuid: string | null;
  
  library: { assets: AssetMeshes[]; textures: TexturePayload[] } | null;
  onClose: () => void;
  

  onExport: (asset: AssetMeshes) => void;
}










export function CharacterPreviewModal({
  charTuid,
  library,
  onClose,
  onExport,
}: CharacterPreviewModalProps) {
  const [exporting, setExporting] = useState(false);
  const open = charTuid !== null;

  const asset = open && library
    ? library.assets.find((a) => a.asset_tuid === charTuid) ?? null
    : null;

  
  
  
  const syntheticInstance: Instance | null = asset
    ? {
        tuid: `${asset.asset_tuid}#library`,
        asset_tuid: asset.asset_tuid,
        kind: "moby",
        name: shortName(asset.asset_tuid),
        position: [0, 0, 0],
        quaternion: [0, 0, 0, 1],
        scale: [1, 1, 1],
      }
    : null;

  
  const previewMeshes: LevelMeshes | null = library
    ? {
        moby_assets: library.assets,
        tie_assets: [],
        ufrag_meshes: [],
        textures: library.textures,
      }
    : null;

  const handleExport = async () => {
    if (!asset || exporting) return;
    setExporting(true);
    try {
      await onExport(asset);
    } finally {
      setExporting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={asset ? `Library asset · ${shortName(asset.asset_tuid)}` : "Character preview"}
      subtitle={asset ? asset.asset_tuid : undefined}
      size="lg"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
          <button
            type="button"
            className="btn btn-primary export-btn"
            onClick={handleExport}
            disabled={!asset || exporting}
          >
            <span className="export-btn-icon" aria-hidden>
              ⬇
            </span>
            <span className="export-btn-label">
              {exporting ? "Exporting…" : "Export .glb"}
            </span>
          </button>
        </>
      }
    >
      <div className="character-preview-body">
        <div className="character-preview-canvas">
          <AssetPreview
            instance={syntheticInstance}
            meshes={previewMeshes}
            textureBlobs={null}
          />
        </div>
        <div className="character-preview-meta">
          <dl className="kv">
            <dt>Asset</dt>
            <dd className="mono small">{asset?.asset_tuid ?? "—"}</dd>
            <dt>Submeshes</dt>
            <dd>{asset ? asset.submeshes.length : 0}</dd>
            <dt>Textures referenced</dt>
            <dd>
              {asset
                ? new Set(
                    asset.submeshes
                      .map((s) => s.albedo_id)
                      .filter((id): id is number => id != null),
                  ).size
                : 0}
            </dd>
          </dl>
          <p className="dim small">
            Drag in the canvas to orbit. Export saves geometry + embedded
            textures as a binary glTF (.glb). Skeleton + animations are not
            yet supported — coming in a follow-up session.
          </p>
        </div>
      </div>
    </Modal>
  );
}

function shortName(assetTuid: string): string {
  
  
  
  return `0x…${assetTuid.slice(-6)}`;
}
