import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { Bounds, OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import { save } from "@tauri-apps/plugin-dialog";
import {
  exportCachedMobyGlb,
  fetchAnimsetClip,
  loadCachedTextures,
  readCachedAsset,
  readCachedManifest,
  type AnimsetSummary,
  type AssetMeshes,
  type DecodedClip,
  type LevelMeshes,
  type TextureBlobMap,
} from "./api";
import { Modal } from "./Modal";
import { Button, Checkbox } from "./ui";
import {
  applyBindStrategy,
  buildAnimationClipFromDecoded,
  buildSkinnedAsset,
  type BindStrategy,
  type BuiltSkinnedAsset,
} from "./skinning";




const EMISSIVE_TINT_WHITE = new THREE.Color(0xffffff);

interface RawCharacterModalProps {
  
  assetTuid: string | null;
  
  meshes: LevelMeshes | null;
  

  textureBlobs: TextureBlobMap | null;
  
  levelFolder: string | null;
  
  animsetClips: AnimsetSummary[];
  onClose: () => void;
}













export function RawCharacterModal({
  assetTuid,
  meshes,
  textureBlobs,
  levelFolder,
  animsetClips,
  onClose,
}: RawCharacterModalProps) {
  const open = assetTuid !== null;

  
  
  
  const inMapAsset = useMemo<AssetMeshes | null>(() => {
    if (!open || !meshes) return null;
    return (
      meshes.moby_assets.find((a) => a.asset_tuid === assetTuid) ??
      meshes.tie_assets.find((a) => a.asset_tuid === assetTuid) ??
      null
    );
  }, [open, meshes, assetTuid]);

  const [cachedAsset, setCachedAsset] = useState<AssetMeshes | null>(null);
  const [cacheFetchError, setCacheFetchError] = useState<string | null>(null);
  useEffect(() => {
    if (!open || !assetTuid || !levelFolder || inMapAsset) {
      setCachedAsset(null);
      setCacheFetchError(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const manifest = await readCachedManifest(levelFolder);
        const wantedKinds = ["moby", "tie"] as const;
        const entry = manifest.entries.find(
          (e) =>
            e.tuid === assetTuid &&
            (wantedKinds as readonly string[]).includes(e.kind),
        );
        if (!entry) {
          if (!cancelled) {
            setCachedAsset(null);
            setCacheFetchError(
              "Asset not found in cache. Re-extract the level to populate it.",
            );
          }
          return;
        }
        const data = (await readCachedAsset(
          levelFolder,
          entry.file,
        )) as AssetMeshes;
        if (!cancelled) {
          setCachedAsset(data);
          setCacheFetchError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setCachedAsset(null);
          setCacheFetchError(`Cache read failed: ${err}`);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, assetTuid, levelFolder, inMapAsset]);

  const asset = inMapAsset ?? cachedAsset;

  const [cachedTextures, setCachedTextures] = useState<TextureBlobMap | null>(
    null,
  );
  useEffect(() => {
    if (!cachedAsset || !levelFolder) {
      setCachedTextures(null);
      return;
    }
    const ids = new Set<number>();
    for (const sm of cachedAsset.submeshes) {
      if (sm.albedo_id != null) ids.add(sm.albedo_id);
      if (sm.normal_id != null) ids.add(sm.normal_id);
      if (sm.emissive_id != null) ids.add(sm.emissive_id);
    }
    if (ids.size === 0) {
      setCachedTextures(new Map());
      return;
    }
    let cancelled = false;
    void loadCachedTextures(levelFolder, [...ids]).then((map) => {
      if (!cancelled) setCachedTextures(map);
    });
    return () => {
      cancelled = true;
    };
  }, [cachedAsset, levelFolder]);

  const effectiveTextureBlobs = cachedTextures ?? textureBlobs;

  
  
  
  const [bindStrategy, setBindStrategy] = useState<BindStrategy>("it");

  
  
  
  const built = useMemo<BuiltSkinnedAsset | null>(() => {
    if (!asset) return null;
    return buildSkinnedAsset(asset, bindStrategy);
    
    
    
  }, [asset]);
  useEffect(() => {
    if (built && asset) applyBindStrategy(built, asset, bindStrategy);
  }, [bindStrategy, built, asset]);
  useEffect(() => {
    if (!asset) return;
    
    
    
    console.log("[RawCharacterModal]", {
      asset_tuid: asset.asset_tuid,
      name: asset.name,
      from_cache: cachedAsset != null && inMapAsset == null,
      submeshes: asset.submeshes.length,
      skeleton_bone_count: asset.skeleton?.bone_count ?? 0,
      has_tms0_col: Array.isArray(asset.skeleton?.tms0_col),
      has_tms1_col: Array.isArray(asset.skeleton?.tms1_col),
      built_bones: built?.bones.length ?? 0,
      built_skinned_meshes: built?.skinnedMeshes.length ?? 0,
      built_root_children: built?.root.children.length ?? 0,
    });
    if (cacheFetchError) {
      console.warn("[RawCharacterModal] cache fetch error:", cacheFetchError);
    }
  }, [asset, built]);
  useEffect(() => {
    return () => built?.dispose();
  }, [built]);

  
  
  
  
  const textureMap = useMemo(() => {
    if (!asset || !effectiveTextureBlobs)
      return new Map<number, THREE.Texture>();
    const ids = new Set<number>();
    for (const sm of asset.submeshes) {
      if (sm.albedo_id != null) ids.add(sm.albedo_id);
      if (sm.normal_id != null) ids.add(sm.normal_id);
      if (sm.emissive_id != null) ids.add(sm.emissive_id);
    }
    const m = new Map<number, THREE.Texture>();
    for (const id of ids) {
      const blob = effectiveTextureBlobs.get(id);
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
  }, [asset, effectiveTextureBlobs]);
  
  useEffect(() => {
    return () => {
      for (const tex of textureMap.values()) tex.dispose();
    };
  }, [textureMap]);

  
  
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
        mat.emissive = EMISSIVE_TINT_WHITE;
        mat.emissiveIntensity = 0.7;
        touched = true;
      }
      if (touched) mat.needsUpdate = true;
    }
  }

  
  const [activeClipName, setActiveClipName] = useState<string | null>(null);
  const [activeClip, setActiveClip] = useState<THREE.AnimationClip | null>(null);
  const [showSkeleton, setShowSkeleton] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  
  useEffect(() => {
    if (!open) {
      setActiveClipName(null);
      setActiveClip(null);
      setExportError(null);
    }
  }, [open]);

  
  
  
  useEffect(() => {
    if (!asset || !asset.animset_hash) return;
    if (activeClipName) return; 
    const own = animsetClips.find((c) => c.tuid_hex === asset.animset_hash);
    if (own) setActiveClipName(own.name);
  }, [asset, animsetClips, activeClipName]);

  
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

  // Export the rig + animations + textures as .glb. Uses the
  // pre-baked cached GLB written by lunalib's GLB pipeline (correct
  // bind-pose, skin, animations, embedded PNGs) — NOT Three.js's
  // GLTFExporter, which inherits the bind-pose math bugs we've been
  // chasing on the FE side.
  const handleExport = useCallback(async () => {
    if (!asset || !levelFolder) return;
    setExportBusy(true);
    setExportError(null);
    try {
      const stem =
        characterStem.replace(/[<>:"/\\|?*]/g, "_") || "character";
      const path = await save({
        title: "Export .glb",
        defaultPath: `${stem}.glb`,
        filters: [{ name: "Binary glTF", extensions: ["glb"] }],
      });
      if (!path || typeof path !== "string") {
        setExportBusy(false);
        return;
      }
      await exportCachedMobyGlb(levelFolder, asset.asset_tuid, path);
    } catch (e) {
      setExportError(String(e));
    } finally {
      setExportBusy(false);
    }
  }, [asset, levelFolder, characterStem]);

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
          <Button
            variant="primary"
            onClick={handleExport}
            disabled={!built}
            loading={exportBusy}
          >
            {exportBusy ? "Exporting…" : "Export .glb"}
          </Button>
          <Button onClick={onClose}>Close</Button>
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
                <Checkbox
                  className="anim-row"
                  checked={showSkeleton}
                  onCheckedChange={setShowSkeleton}
                  label={
                    <span className="anim-row-name">
                      Show skeleton (bones)
                    </span>
                  }
                />
                <div className="bind-strategy-selector">
                  <span className="bind-strategy-label small dim">
                    Bind strategy
                  </span>
                  <div className="bind-strategy-options">
                    {(["it", "direct", "relunacy"] as const).map((s) => (
                      <button
                        key={s}
                        type="button"
                        className={`bind-strategy-btn ${bindStrategy === s ? "active" : ""}`}
                        onClick={() => setBindStrategy(s)}
                        title={
                          s === "it"
                            ? "IT-derived: tms1[parent] * tms0[child]"
                            : s === "direct"
                              ? "tms0 IS the local bind directly"
                              : "ReLunacy: tms1 is local, tms0 is inverse"
                        }
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
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
                  totalTris += Math.floor(idxBytes / 4 / 3); 
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
