import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { Bounds, OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import {
  fetchAnimsetClip,
  type AnimsetSummary,
  type AssetMeshes,
  type DecodedClip,
  type LevelMeshes,
  type TextureBlobMap,
} from "./api";
import { Modal } from "./Modal";
import {
  buildAnimationClipFromDecoded,
  buildSkinnedAsset,
  type BuiltSkinnedAsset,
} from "./skinning";

interface RawCharacterModalProps {
  /** Asset_tuid of the moby/tie to preview. Modal opens when non-null. */
  assetTuid: string | null;
  /** Level meshes — provides the AssetMeshes lookup + the texture pool. */
  meshes: LevelMeshes | null;
  /** Texture PNG bytes keyed by id, fetched via the bulk binary IPC
   *  command after streaming. Null while in flight. */
  textureBlobs: TextureBlobMap | null;
  /** Level folder — needed to fetch animset clips. */
  levelFolder: string | null;
  /** All animsets in the level — drives the auto-match dropdown. */
  animsetClips: AnimsetSummary[];
  onClose: () => void;
}

/**
 * Per-character preview modal sourced directly from raw `.dat` data
 * (mesh + textures + skeleton + animations). Opened from the Asset
 * Library tree in the Hierarchy when the user clicks any moby —
 * placed or not. Equivalent to GltfCharacterModal but skips the
 * `.glb`/IT roundtrip and uses our parser output end-to-end.
 *
 * What you can do here:
 *   - Spin the character around (OrbitControls + auto-frame)
 *   - Pick from "Matching this character" or "All animations"
 *   - Export the rig + selected animation as `.glb` (Blender Action)
 */
export function RawCharacterModal({
  assetTuid,
  meshes,
  textureBlobs,
  levelFolder,
  animsetClips,
  onClose,
}: RawCharacterModalProps) {
  const open = assetTuid !== null;

  // Resolve the asset DTO from the level's meshes. Both moby and tie
  // streams populate `meshes.moby_assets`/`tie_assets`, so we check
  // both arrays.
  const asset = useMemo<AssetMeshes | null>(() => {
    if (!open || !meshes) return null;
    return (
      meshes.moby_assets.find((a) => a.asset_tuid === assetTuid) ??
      meshes.tie_assets.find((a) => a.asset_tuid === assetTuid) ??
      null
    );
  }, [open, meshes, assetTuid]);

  // Build the THREE.js rig once per asset change. Heavy step — the
  // dispose cleanup runs when the modal closes or asset swaps.
  const built = useMemo<BuiltSkinnedAsset | null>(() => {
    if (!asset) return null;
    return buildSkinnedAsset(asset);
  }, [asset]);
  useEffect(() => {
    return () => built?.dispose();
  }, [built]);

  // Decode level textures into THREE.Texture objects on demand. We
  // rebuild fresh per modal open (cheap — typically < 50 textures
  // referenced by a single character) so the modal owns its own
  // texture lifecycle and disposes them on close.
  const textureMap = useMemo(() => {
    if (!asset || !textureBlobs) return new Map<number, THREE.Texture>();
    const ids = new Set<number>();
    for (const sm of asset.submeshes) {
      if (sm.albedo_id != null) ids.add(sm.albedo_id);
      if (sm.normal_id != null) ids.add(sm.normal_id);
      if (sm.emissive_id != null) ids.add(sm.emissive_id);
    }
    const m = new Map<number, THREE.Texture>();
    for (const id of ids) {
      const blob = textureBlobs.get(id);
      if (!blob) continue;
      const url = URL.createObjectURL(blob);
      const img = new Image();
      const tex = new THREE.Texture(img);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.flipY = false;
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.generateMipmaps = false;
      img.onload = () => {
        tex.needsUpdate = true;
        URL.revokeObjectURL(url);
      };
      img.src = url;
      m.set(id, tex);
    }
    return m;
  }, [asset, textureBlobs]);
  // Dispose textures when the modal closes / asset swaps.
  useEffect(() => {
    return () => {
      for (const tex of textureMap.values()) tex.dispose();
    };
  }, [textureMap]);

  // Patch textures into materials every render so Late-arriving images
  // (Image.onload is async) attach without rebuilding the rig.
  if (built && asset) {
    for (let i = 0; i < built.materials.length; i++) {
      const mat = built.materials[i]! as THREE.MeshStandardMaterial;
      const sub = asset.submeshes[i];
      if (!sub) continue;
      const albedo =
        sub.albedo_id != null ? textureMap.get(sub.albedo_id) ?? null : null;
      const normal =
        sub.normal_id != null ? textureMap.get(sub.normal_id) ?? null : null;
      const emissive =
        sub.emissive_id != null ? textureMap.get(sub.emissive_id) ?? null : null;
      let touched = false;
      if (albedo && mat.map !== albedo) { mat.map = albedo; touched = true; }
      if (normal && mat.normalMap !== normal) { mat.normalMap = normal; touched = true; }
      if (emissive && mat.emissiveMap !== emissive) {
        mat.emissiveMap = emissive;
        mat.emissive = new THREE.Color(0xffffff);
        mat.emissiveIntensity = 0.7;
        touched = true;
      }
      if (touched) mat.needsUpdate = true;
    }
  }

  // Animation state + clip-fetch effect.
  const [activeClipName, setActiveClipName] = useState<string | null>(null);
  const [activeClip, setActiveClip] = useState<THREE.AnimationClip | null>(null);
  const [showSkeleton, setShowSkeleton] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  // Reset clip selection when the modal closes or asset changes.
  useEffect(() => {
    if (!open) {
      setActiveClipName(null);
      setActiveClip(null);
      setExportError(null);
    }
  }, [open]);

  // Auto-pick the moby's own animset when the modal first opens — the
  // most common "I want to see this character animated" case. The user
  // can then switch to any other clip via the list.
  useEffect(() => {
    if (!asset || !asset.animset_hash) return;
    if (activeClipName) return; // user already picked
    const own = animsetClips.find((c) => c.tuid_hex === asset.animset_hash);
    if (own) setActiveClipName(own.name);
  }, [asset, animsetClips, activeClipName]);

  // Resolve the active clip name → fetch + build THREE.AnimationClip.
  useEffect(() => {
    setActiveClip(null);
    if (!activeClipName || !levelFolder || !built) return;
    const summary = animsetClips.find((c) => c.name === activeClipName);
    if (!summary) return;
    let cancelled = false;
    fetchAnimsetClip(
      levelFolder,
      summary.tuid_hex,
      asset?.bind_pose_inverse_offset ?? 0,
      asset?.skeleton?.scale_shift ?? 0,
    )
      .then((decoded: DecodedClip) => {
        if (cancelled) return;
        // built.bones[i].name is `bone_${i}` so the standard helper works.
        const aclip = buildAnimationClipFromDecoded(decoded, built.bones.length);
        setActiveClip(aclip);
      })
      .catch(() => {
        if (cancelled) return;
        setActiveClip(null);
      });
    return () => {
      cancelled = true;
    };
  }, [activeClipName, levelFolder, built, animsetClips, asset]);

  // Filter animsets by name overlap with the asset's name (path-style)
  // so "matching this character" floats to the top.
  const characterStem = useMemo(() => {
    if (!asset || !asset.name) return "";
    const segs = asset.name.split(/[/\\]+/).filter((s) => s.length > 0);
    return segs[segs.length - 1]?.toLowerCase() ?? "";
  }, [asset]);

  const { matching, others } = useMemo(() => {
    if (!characterStem || animsetClips.length === 0) {
      return { matching: [], others: animsetClips };
    }
    const stemTokens = new Set(
      characterStem.split(/[_\-]+|\d+/).filter((t) => t.length >= 3),
    );
    type Scored = { clip: AnimsetSummary; score: number };
    const scored: Scored[] = animsetClips.map((clip) => {
      const name = clip.name.toLowerCase();
      if (name.includes(characterStem) || characterStem.includes(name)) {
        return { clip, score: 100 };
      }
      const nameTokens = name.split(/[_\-]+|\d+/).filter((t) => t.length >= 3);
      let shared = 0;
      for (const t of nameTokens) if (stemTokens.has(t)) shared++;
      return { clip, score: shared };
    });
    const m = scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((s) => s.clip);
    const matchingTuids = new Set(m.map((c) => c.tuid_hex));
    const o = animsetClips.filter((c) => !matchingTuids.has(c.tuid_hex));
    return { matching: m, others: o };
  }, [animsetClips, characterStem]);

  // Export the rig + active clip as .glb.
  const handleExport = useCallback(async () => {
    if (!built || !asset) return;
    setExportBusy(true);
    setExportError(null);
    try {
      const stem =
        characterStem.replace(/[<>:"/\\|?*]/g, "_") || "character";
      const path = await save({
        title: "Export character with animation as .glb",
        defaultPath: `${stem}.glb`,
        filters: [{ name: "Binary glTF", extensions: ["glb"] }],
      });
      if (!path || typeof path !== "string") {
        setExportBusy(false);
        return;
      }
      const animations: THREE.AnimationClip[] = [];
      if (activeClip) animations.push(activeClip);
      const exporter = new GLTFExporter();
      const bytes = await new Promise<ArrayBuffer>((resolve, reject) => {
        exporter.parse(
          built.root,
          (out) => {
            if (out instanceof ArrayBuffer) resolve(out);
            else reject(new Error("GLTFExporter returned JSON; expected binary"));
          },
          (err) => reject(err),
          {
            binary: true,
            includeCustomExtensions: false,
            embedImages: true,
            animations,
          },
        );
      });
      await invoke<void>("write_bytes", {
        path,
        bytes: Array.from(new Uint8Array(bytes)),
      });
    } catch (e) {
      setExportError(String(e));
    } finally {
      setExportBusy(false);
    }
  }, [built, asset, activeClip, characterStem]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={asset ? asset.name || `0x${asset.asset_tuid.slice(-12)}` : "Asset preview"}
      subtitle={asset ? asset.asset_tuid : undefined}
      size="xl"
      bodyClassName="modal-body-flex"
      footer={
        <>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleExport}
            disabled={!built || exportBusy}
          >
            {exportBusy ? "Exporting…" : "Export .glb"}
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <div className="character-preview-body">
        <div className="character-preview-canvas">
          {!asset && (
            <div className="asset-preview-empty">
              <span className="dim small">Asset not in the open level</span>
            </div>
          )}
          {asset && built && (
            <Canvas
              camera={{ position: [3, 2, 3], fov: 40, near: 0.01, far: 10000 }}
              dpr={[1, 1.5]}
            >
              <color attach="background" args={["#0b0c0e"]} />
              <ambientLight intensity={0.55} />
              <directionalLight position={[5, 10, 7.5]} intensity={1.1} />
              <directionalLight position={[-5, -2, -5]} intensity={0.35} />
              <Bounds fit clip observe margin={1.2}>
                <RawScene
                  built={built}
                  clip={activeClip}
                  showSkeleton={showSkeleton}
                />
              </Bounds>
              <OrbitControls
                makeDefault
                enableDamping
                dampingFactor={0.1}
                autoRotate={!activeClip}
                autoRotateSpeed={0.6}
              />
            </Canvas>
          )}
        </div>

        <div className="character-preview-meta">
          {asset && (
            <>
              <div className="inspector-section">
                <h4>View</h4>
                <label className="anim-row" style={{ cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={showSkeleton}
                    onChange={(e) => setShowSkeleton(e.target.checked)}
                    style={{ marginRight: 6 }}
                  />
                  <span className="anim-row-name">Show skeleton (bones)</span>
                </label>
              </div>

              <div className="inspector-section">
                <h4>Animations</h4>
                {animsetClips.length === 0 && (
                  <p className="dim small">No animsets loaded for this level.</p>
                )}
                {matching.length > 0 && (
                  <>
                    <p className="dim small" style={{ marginTop: 4, marginBottom: 4 }}>
                      Matching this character ({matching.length})
                    </p>
                    <div className="anim-list">
                      {matching.map((c) => (
                        <ClipRow
                          key={c.tuid_hex}
                          clip={c}
                          active={activeClipName === c.name}
                          onClick={() =>
                            setActiveClipName(
                              activeClipName === c.name ? null : c.name,
                            )
                          }
                        />
                      ))}
                    </div>
                  </>
                )}
                {others.length > 0 && (
                  <>
                    <p className="dim small" style={{ marginTop: 10, marginBottom: 4 }}>
                      {matching.length > 0
                        ? `All other animations (${others.length})`
                        : `All animations (${others.length})`}
                    </p>
                    <div className="anim-list">
                      {others.map((c) => (
                        <ClipRow
                          key={c.tuid_hex}
                          clip={c}
                          active={activeClipName === c.name}
                          onClick={() =>
                            setActiveClipName(
                              activeClipName === c.name ? null : c.name,
                            )
                          }
                        />
                      ))}
                    </div>
                  </>
                )}
                {exportError && (
                  <p className="error small" style={{ marginTop: 6 }}>
                    Export error: {exportError}
                  </p>
                )}
              </div>

              {(() => {
                // Aggregate stats across all submeshes once. b64 → byte
                // count uses (len*3)/4 (each base64 quad encodes 3 bytes).
                let totalVerts = 0;
                let totalTris = 0;
                let skinnedVerts = 0;
                const albedos = new Set<number>();
                const normals = new Set<number>();
                const emissives = new Set<number>();
                for (const sm of asset.submeshes) {
                  const posBytes = Math.floor((sm.positions_b64.length * 3) / 4);
                  const verts = Math.floor(posBytes / 12);
                  totalVerts += verts;
                  const idxBytes = Math.floor((sm.indices_b64.length * 3) / 4);
                  totalTris += Math.floor(idxBytes / 4 / 3); // u32 indices
                  if (sm.bone_indices_b64.length > 0) skinnedVerts += verts;
                  if (sm.albedo_id != null) albedos.add(sm.albedo_id);
                  if (sm.normal_id != null) normals.add(sm.normal_id);
                  if (sm.emissive_id != null) emissives.add(sm.emissive_id);
                }
                return (
                  <>
                    <div className="inspector-section">
                      <h4>Geometry</h4>
                      <dl className="kv">
                        <dt>Submeshes</dt>
                        <dd>{asset.submeshes.length}</dd>
                        <dt>Vertices</dt>
                        <dd>{totalVerts.toLocaleString()}</dd>
                        <dt>Triangles</dt>
                        <dd>{totalTris.toLocaleString()}</dd>
                        <dt>Skinned verts</dt>
                        <dd>
                          {skinnedVerts.toLocaleString()}
                          {totalVerts > 0 &&
                            ` (${Math.round((skinnedVerts / totalVerts) * 100)}%)`}
                        </dd>
                      </dl>
                    </div>

                    <div className="inspector-section">
                      <h4>Skeleton</h4>
                      <dl className="kv">
                        <dt>Bones</dt>
                        <dd>{asset.skeleton?.bone_count ?? 0}</dd>
                        <dt>Root bone</dt>
                        <dd>{asset.skeleton?.root_bone ?? "—"}</dd>
                        <dt>Scale shift</dt>
                        <dd>{asset.skeleton?.scale_shift ?? 0}</dd>
                        <dt>Bind pose offset</dt>
                        <dd>{asset.bind_pose_inverse_offset}</dd>
                      </dl>
                    </div>

                    <div className="inspector-section">
                      <h4>Materials</h4>
                      <dl className="kv">
                        <dt>Albedo maps</dt>
                        <dd>{albedos.size}</dd>
                        <dt>Normal maps</dt>
                        <dd>{normals.size}</dd>
                        <dt>Emissive maps</dt>
                        <dd>{emissives.size}</dd>
                      </dl>
                    </div>

                    <div className="inspector-section">
                      <h4>Identity</h4>
                      <dl className="kv">
                        <dt>Asset TUID</dt>
                        <dd className="mono small" style={{ wordBreak: "break-all" }}>
                          {asset.asset_tuid}
                        </dd>
                        <dt>Name</dt>
                        <dd className="mono small">{asset.name || "—"}</dd>
                        <dt>Animset</dt>
                        <dd className="mono small" style={{ wordBreak: "break-all" }}>
                          {asset.animset_hash ?? "—"}
                        </dd>
                      </dl>
                    </div>
                  </>
                );
              })()}
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

/** Inside-Canvas component — drives the AnimationMixer + adds optional
 *  SkeletonHelper. Lives here because `useFrame` is required and only
 *  works inside R3F's Canvas. */
function RawScene({
  built,
  clip,
  showSkeleton,
}: {
  built: BuiltSkinnedAsset;
  clip: THREE.AnimationClip | null;
  showSkeleton: boolean;
}) {
  const mixerRef = useRef<THREE.AnimationMixer | null>(null);

  // Mixer + clip lifecycle, atomic. Originally split across two effects
  // (mixer keyed on `[built]`, clip keyed on `[clip]`) — but when only
  // `built` changed, the new mixer never picked up the existing clip
  // because the clip effect didn't re-fire. Result: silent deformation
  // failure that looks like "the animation isn't playing."
  //
  // Combining them on `[built, clip]` rebuilds the mixer + action
  // together whenever either changes. The cleanup runs in the right
  // order (stopAllAction before uncacheRoot) so we don't leak runtime
  // caches when the modal swaps assets.
  useEffect(() => {
    if (!built) return;
    const mixer = new THREE.AnimationMixer(built.root);
    mixerRef.current = mixer;
    if (clip) {
      const action = mixer.clipAction(clip);
      action.reset().play();
    }
    return () => {
      mixer.stopAllAction();
      mixer.uncacheRoot(built.root);
      mixerRef.current = null;
    };
  }, [built, clip]);

  useFrame((_state, delta) => {
    mixerRef.current?.update(delta);
  });

  // Memoize SkeletonHelper so it doesn't get recreated every render.
  const skeletonHelper = useMemo(() => {
    if (!showSkeleton) return null;
    const helper = new THREE.SkeletonHelper(built.root);
    const mat = helper.material as THREE.LineBasicMaterial;
    mat.color = new THREE.Color("#33d5ff");
    mat.depthTest = false;
    mat.transparent = true;
    mat.opacity = 0.95;
    helper.renderOrder = 1000;
    return helper;
  }, [built, showSkeleton]);

  return (
    <>
      <primitive object={built.root} />
      {skeletonHelper && <primitive object={skeletonHelper} />}
    </>
  );
}

function ClipRow({
  clip,
  active,
  onClick,
}: {
  clip: AnimsetSummary;
  active: boolean;
  onClick: () => void;
}) {
  const dur = clip.frame_rate > 0 ? clip.num_frames / clip.frame_rate : 0;
  return (
    <button
      type="button"
      className={`anim-row ${active ? "active" : ""}`}
      onClick={onClick}
      title={`${clip.num_frames} frames @ ${clip.frame_rate.toFixed(0)}fps · ${clip.num_bones} bones${clip.looping ? " · looping" : ""}`}
    >
      <span className="anim-row-icon">{active ? "❚❚" : "▶"}</span>
      <span className="anim-row-name">{clip.name || "(unnamed)"}</span>
      <span className="anim-row-dur mono small">{dur.toFixed(2)}s</span>
    </button>
  );
}
