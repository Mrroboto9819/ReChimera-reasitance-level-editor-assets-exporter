import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { Bounds, OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { DDSLoader } from "three/examples/jsm/loaders/DDSLoader.js";
import { clone as skeletonAwareClone } from "three/examples/jsm/utils/SkeletonUtils.js";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import {
  fetchAnimsetClip,
  findGlbTextures,
  listAnimsetClips,
  readFileBytes,
  type AnimsetSummary,
  type DecodedClip,
  type GltfFile,
} from "./api";
import { Modal } from "./Modal";

interface GltfCharacterModalProps {
  /** Open when non-null. */
  file: GltfFile | null;
  onClose: () => void;
  /** Path to the currently-open level. When non-null, the modal can
   *  fetch raw `.dat` animsets from `<level>/animsets.dat` and apply
   *  them to the loaded `.glb`'s rig — Option B (skip IT bundled clips,
   *  use the raw parser directly). */
  levelFolder?: string | null;
}

type AnimSource = "file" | "level";

/**
 * Loads + previews a GLTF (.gltf/.glb) character produced by the
 * InsomniaToolset's `extract_assets` command. These files already have
 * skeleton + animations baked in, so we get all of that for free via
 * three.js's GLTFLoader — no Rust skeleton/animation parser needed.
 *
 * Shows the model in an interactive Canvas with auto-frame, lists all
 * animation clips, and plays them through a `THREE.AnimationMixer`.
 */
export function GltfCharacterModal({
  file,
  onClose,
  levelFolder,
}: GltfCharacterModalProps) {
  const open = file !== null;
  const [gltf, setGltf] = useState<GLTF | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeClipName, setActiveClipName] = useState<string | null>(null);
  const [showSkeleton, setShowSkeleton] = useState(false);
  // Animation source: "file" = clips bundled in the .glb (IT default),
  // "level" = clips fetched from `<level>/animsets.dat` via raw parser.
  const [animSource, setAnimSource] = useState<AnimSource>("file");
  // Cached list of level animsets (clip-header metadata only). Loaded
  // lazily when the user switches the source dropdown to "level".
  const [levelAnimsets, setLevelAnimsets] = useState<AnimsetSummary[] | null>(null);
  const [levelAnimsetsError, setLevelAnimsetsError] = useState<string | null>(null);
  // The decoded raw clip currently applied to the loaded scene's rig.
  // Stored as a THREE.AnimationClip (post-bone-name remap) so the
  // GltfScene can play it via the same AnimationMixer.
  const [appliedRawClip, setAppliedRawClip] = useState<THREE.AnimationClip | null>(null);
  const [appliedRawClipName, setAppliedRawClipName] = useState<string | null>(null);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  // The "all other animations" section is hidden by default — only
  // animations matching this character's name are surfaced. Toggle
  // shows the rest behind a "Show all" expander.
  const [showAllAnimsets, setShowAllAnimsets] = useState(false);

  // (Re)load whenever a new file is selected. Clear state on close so the
  // next open starts fresh + the previous Three.js objects can GC.
  useEffect(() => {
    if (!open || !file) {
      setGltf(null);
      setActiveClipName(null);
      setLoadError(null);
      setAppliedRawClip(null);
      setAppliedRawClipName(null);
      setExportError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setGltf(null);
    (async () => {
      try {
        const bytes = await readFileBytes(file.path);
        const buf = new Uint8Array(bytes).buffer;
        const loader = new GLTFLoader();
        // baseUrl is "" because we're handing it the parsed bytes
        // directly. External resources (.bin, textures) won't resolve;
        // works fine for self-contained .glb. For .gltf with externals,
        // would need to resolve sibling files — TODO when we have one.
        loader.parse(
          buf,
          "",
          (loaded) => {
            if (cancelled) return;
            setGltf(loaded);
            // Auto-play the first animation if there is one.
            if (loaded.animations.length > 0) {
              setActiveClipName(loaded.animations[0]!.name);
            }
            setLoading(false);
          },
          (err) => {
            if (cancelled) return;
            setLoadError(`Parse failed: ${err}`);
            setLoading(false);
          },
        );
      } catch (e) {
        if (cancelled) return;
        setLoadError(`Read failed: ${e}`);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, file]);

  // Load level animset list as soon as a level is open and the modal
  // mounts a file. Don't gate on the source dropdown — we want the
  // "matching animations for this character" filter ready before the
  // user even thinks to look for it. The list is small (39 entries on
  // bayou) so the prefetch is cheap.
  useEffect(() => {
    if (!open || !levelFolder) return;
    if (levelAnimsets !== null) return; // cached for modal lifetime
    let cancelled = false;
    setLevelAnimsetsError(null);
    listAnimsetClips(levelFolder)
      .then((list) => {
        if (cancelled) return;
        setLevelAnimsets(list);
      })
      .catch((e) => {
        if (cancelled) return;
        setLevelAnimsetsError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [open, levelFolder, levelAnimsets]);

  // Reset the cached animset list when the modal closes so the next
  // open re-fetches (level may have changed).
  useEffect(() => {
    if (!open) setLevelAnimsets(null);
  }, [open]);

  // Auto-flip the source to "level" when the .glb has zero bundled
  // clips but a level is open. Saves the user one dropdown change in
  // the common case (IT-extracted character with separate animations).
  useEffect(() => {
    if (!gltf || !levelFolder) return;
    if (gltf.animations.length === 0 && animSource === "file") {
      setAnimSource("level");
    }
  }, [gltf, levelFolder, animSource]);

  // Track texture-load status so the inspector can show "Textures: 12/14
  // loaded" while DDS files stream in.
  const [textureStatus, setTextureStatus] = useState<{
    requested: number;
    loaded: number;
  } | null>(null);

  // Walk the loaded scene's materials and pull sibling DDS textures
  // from `<level>/textures/...`. IT writes those externally instead of
  // embedding in the .glb — without this, every material renders grey.
  //
  // Strategy:
  //   1. Collect unique material names from the scene
  //   2. Ask backend `find_glb_textures` for matching `_c.dds`/`_n.dds`/
  //      `_e.dds` paths
  //   3. Read each DDS via `read_file_bytes` and parse with DDSLoader
  //   4. Patch into `material.map` / `normalMap` / `emissiveMap`
  useEffect(() => {
    if (!gltf || !levelFolder) {
      setTextureStatus(null);
      return;
    }
    let cancelled = false;
    const loader = new DDSLoader();
    const blobsToRevoke: string[] = [];
    const texturesToDispose: THREE.Texture[] = [];

    (async () => {
      // 1. Inventory materials.
      const matsByName = new Map<string, THREE.MeshStandardMaterial[]>();
      gltf.scene.traverse((obj) => {
        if (!(obj as THREE.Mesh).isMesh) return;
        const mesh = obj as THREE.Mesh;
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const m of mats) {
          if (!(m instanceof THREE.MeshStandardMaterial)) continue;
          if (!m.name) continue;
          let arr = matsByName.get(m.name);
          if (!arr) {
            arr = [];
            matsByName.set(m.name, arr);
          }
          arr.push(m);
        }
      });
      const names = Array.from(matsByName.keys());
      if (names.length === 0) return;
      setTextureStatus({ requested: names.length, loaded: 0 });

      // 2. Resolve sibling DDS paths.
      let resolved: Awaited<ReturnType<typeof findGlbTextures>>;
      try {
        resolved = await findGlbTextures(levelFolder, names);
      } catch (e) {
        if (!cancelled) {
          // eslint-disable-next-line no-console
          console.warn("findGlbTextures failed:", e);
        }
        return;
      }
      if (cancelled) return;
      // Diagnostics: log how many materials resolved to a DDS file.
      // If `withFiles=0`, IT exported textures to a path the backend
      // can't find (different level / global folder) — unrelated to
      // our DDS loader.
      const withFiles = resolved.filter(
        (r) => r.albedo_path || r.normal_path || r.emissive_path,
      ).length;
      // eslint-disable-next-line no-console
      console.log("[findGlbTextures]", {
        materials: names.length,
        withFiles,
        firstResolved: resolved.slice(0, 3).map((r) => ({
          name: r.material_name,
          albedo: r.albedo_path?.split(/[\\/]/).pop(),
          normal: r.normal_path?.split(/[\\/]/).pop(),
          emissive: r.emissive_path?.split(/[\\/]/).pop(),
        })),
      });

      // 3. + 4. For each resolved entry, read DDS bytes and assign.
      let loaded = 0;
      for (const r of resolved) {
        if (cancelled) return;
        const targets = matsByName.get(r.material_name) ?? [];
        if (targets.length === 0) continue;

        const channels: Array<["albedo_path" | "normal_path" | "emissive_path", string | null]> = [
          ["albedo_path", r.albedo_path],
          ["normal_path", r.normal_path],
          ["emissive_path", r.emissive_path],
        ];

        for (const [channel, path] of channels) {
          if (!path) continue;
          try {
            const bytes = await readFileBytes(path);
            if (cancelled) return;
            // DDSLoader's `parse()` takes an ArrayBuffer and returns a
            // CompressedTexture-like result with mipmaps + format set.
            // Wrapping it in a THREE.Texture isn't right — DDSLoader
            // hands back its own typed result we feed to a Texture's
            // image+mipmaps slots.
            const ddsBuf = new Uint8Array(bytes).buffer;
            const parsed = loader.parse(ddsBuf, true);
            // DDSLoader returns a `format` typed as `CompressedPixelFormat
            // | PixelFormat` (DDS can hold raw RGBA too), but every
            // texture IT exports is BC1/BC3 compressed. Cast — TS only
            // gates against the union, runtime is fine for either.
            const fmt = parsed.format as THREE.CompressedPixelFormat;
            const tex = new THREE.CompressedTexture(
              parsed.mipmaps as ImageData[],
              parsed.width,
              parsed.height,
              fmt,
            );
            tex.mipmaps = parsed.mipmaps as ImageData[];
            tex.format = fmt;
            tex.minFilter = THREE.LinearMipmapLinearFilter;
            tex.magFilter = THREE.LinearFilter;
            tex.wrapS = THREE.RepeatWrapping;
            tex.wrapT = THREE.RepeatWrapping;
            tex.flipY = false;
            tex.colorSpace =
              channel === "albedo_path"
                ? THREE.SRGBColorSpace
                : THREE.NoColorSpace;
            tex.needsUpdate = true;
            texturesToDispose.push(tex);

            for (const m of targets) {
              if (channel === "albedo_path") m.map = tex;
              else if (channel === "normal_path") m.normalMap = tex;
              else if (channel === "emissive_path") {
                m.emissiveMap = tex;
                m.emissive = new THREE.Color(0xffffff);
                m.emissiveIntensity = 0.7;
              }
              m.needsUpdate = true;
            }
          } catch (e) {
            // eslint-disable-next-line no-console
            console.warn(`DDS load failed for ${path}:`, e);
          }
        }
        loaded++;
        setTextureStatus({ requested: names.length, loaded });
      }
    })();

    return () => {
      cancelled = true;
      for (const url of blobsToRevoke) URL.revokeObjectURL(url);
      // Don't dispose textures here — they belong to the loaded scene
      // and are referenced by materials. They get freed when the scene
      // is replaced (next file open) via three.js's automatic cleanup.
    };
  }, [gltf, levelFolder]);

  // Derive a search stem from the .glb filename — strip extension and
  // common IT suffixes. `coop_medic.entity.glb` → `coop_medic`.
  const characterStem = useMemo(() => {
    if (!file) return "";
    let stem = file.name.toLowerCase();
    stem = stem.replace(/\.(gltf|glb)$/i, "");
    stem = stem.replace(/\.entity$/i, "");
    return stem;
  }, [file]);

  // Filter level animsets by name relation to the character. Two
  // heuristics, in priority order:
  //   1. Exact substring match between clip name and stem (or vice versa)
  //   2. Token overlap — split on `_` / `-` / digits, count shared tokens
  // Returns matching clips first, with score for sorting.
  const { matchingAnimsets, otherAnimsets } = useMemo(() => {
    if (!levelAnimsets || !characterStem) {
      return { matchingAnimsets: [], otherAnimsets: levelAnimsets ?? [] };
    }
    const stemTokens = new Set(
      characterStem.split(/[_\-]+|\d+/).filter((t) => t.length >= 3),
    );
    type Scored = { clip: AnimsetSummary; score: number };
    const scored: Scored[] = levelAnimsets.map((clip) => {
      const name = clip.name.toLowerCase();
      // Direct substring wins big.
      if (name.includes(characterStem) || characterStem.includes(name)) {
        return { clip, score: 100 };
      }
      // Token overlap.
      const nameTokens = name.split(/[_\-]+|\d+/).filter((t) => t.length >= 3);
      let shared = 0;
      for (const t of nameTokens) if (stemTokens.has(t)) shared++;
      return { clip, score: shared };
    });
    const matching = scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((s) => s.clip);
    const matchingTuids = new Set(matching.map((c) => c.tuid_hex));
    const others = levelAnimsets.filter((c) => !matchingTuids.has(c.tuid_hex));
    return { matchingAnimsets: matching, otherAnimsets: others };
  }, [levelAnimsets, characterStem]);

  // Find the loaded scene's first SkinnedMesh + its bones — needed for
  // remapping `bone_${i}` track names to whatever names the GLB uses.
  const sceneBones = useMemo<THREE.Bone[]>(() => {
    if (!gltf) return [];
    let found: THREE.Bone[] = [];
    gltf.scene.traverse((obj) => {
      if (found.length > 0) return;
      if (obj instanceof THREE.SkinnedMesh && obj.skeleton.bones.length > 0) {
        found = obj.skeleton.bones;
      }
    });
    return found;
  }, [gltf]);

  // User clicked a level animset → fetch decoded clip, remap bone names,
  // apply to the loaded scene's rig. The remap assumes IT writes bones
  // in the same index order as Insomniac's raw `.dat` skeleton table
  // (both ultimately read mobys.dat's bone array). If counts differ we
  // truncate to the smaller size — usually the GLB's skeleton has fewer
  // bones than face-only viseme clips, so missing tracks just no-op.
  const applyLevelClip = useCallback(
    async (clip: AnimsetSummary) => {
      if (!levelFolder) return;
      if (sceneBones.length === 0) return;
      try {
        // The GLB's bind-pose translations are already in the file's
        // unit (likely yards from IT's export). Pass position/scale = 1
        // so the raw clip's translation values stay in those same
        // units. Animation rotations are unitless (quaternions) so
        // unaffected.
        //
        // TODO: figure out the exact unit convention IT writes — until
        // then, raw clips that include bone TRANSLATIONS may look off
        // in the preview. Bone ROTATIONS (which dominate idle/walk
        // anims) work fine.
        const decoded: DecodedClip = await fetchAnimsetClip(
          levelFolder,
          clip.tuid_hex,
          0, // bind_pose_inverse_offset — passing 0 means positionScale=1
          0, // scale_shift — same
        );
        const aclip = buildClipForGlbBones(decoded, sceneBones);
        // Diagnostics: log clip + scene-bone state when applying. If
        // tracks=0 the bone-name remap failed; if tracks > 0 but mesh
        // doesn't deform, the issue is in the mixer/clone path.
        // eslint-disable-next-line no-console
        console.log("[applyLevelClip]", {
          clipName: clip.name,
          decodedBones: decoded.bones.length,
          sceneBones: sceneBones.length,
          firstFiveSceneBoneNames: sceneBones.slice(0, 5).map((b) => b.name),
          builtTracks: aclip.tracks.length,
          firstThreeTrackNames: aclip.tracks.slice(0, 3).map((t) => t.name),
          duration: aclip.duration,
        });
        setAppliedRawClip(aclip);
        setAppliedRawClipName(clip.name);
        // Clear file-source clip selection so only one plays at a time.
        setActiveClipName(null);
      } catch (e) {
        setLevelAnimsetsError(`Apply failed: ${e}`);
      }
    },
    [levelFolder, sceneBones],
  );

  // Export the loaded scene + the currently-applied clip(s) as a .glb
  // for Blender. Clips that came with the file (gltf.animations) AND
  // any raw clip we applied get shipped together so Blender's Action
  // editor sees both.
  const handleExport = useCallback(async () => {
    if (!gltf) return;
    setExportBusy(true);
    setExportError(null);
    try {
      const defaultName = file
        ? file.name.replace(/\.(gltf|glb)$/i, "") + ".glb"
        : "character.glb";
      const path = await save({
        title: "Export character with animations as .glb",
        defaultPath: defaultName,
        filters: [{ name: "Binary glTF", extensions: ["glb"] }],
      });
      if (!path || typeof path !== "string") {
        setExportBusy(false);
        return;
      }

      // Combine bundled clips + applied raw clip. Bundled first so the
      // user sees those at the top of Blender's Action list.
      const animations: THREE.AnimationClip[] = [...gltf.animations];
      if (appliedRawClip) animations.push(appliedRawClip);

      const exporter = new GLTFExporter();
      const bytes = await new Promise<ArrayBuffer>((resolve, reject) => {
        exporter.parse(
          gltf.scene,
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
  }, [gltf, file, appliedRawClip]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={file ? file.name : "GLTF preview"}
      subtitle={file ? `${(file.size_bytes / 1024).toFixed(1)} KB · ${file.extension.toUpperCase()}` : undefined}
      size="xl"
      bodyClassName="modal-body-flex"
      footer={
        <>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleExport}
            disabled={!gltf || exportBusy}
            title="Export the character + currently selected animations as .glb (one Action per clip when imported into Blender)"
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
          {loading && (
            <div className="asset-preview-empty">
              <span className="dim small">Loading…</span>
            </div>
          )}
          {loadError && (
            <div className="asset-preview-empty">
              <span className="error small">{loadError}</span>
            </div>
          )}
          {!loading && !loadError && gltf && (
            <Canvas
              camera={{ position: [3, 2, 3], fov: 40, near: 0.01, far: 10000 }}
              dpr={[1, 1.5]}
            >
              <color attach="background" args={["#0b0c0e"]} />
              <ambientLight intensity={0.55} />
              <directionalLight position={[5, 10, 7.5]} intensity={1.1} />
              <directionalLight position={[-5, -2, -5]} intensity={0.35} />
              <Bounds fit clip observe margin={1.2}>
                <GltfScene
                  gltf={gltf}
                  activeClipName={activeClipName}
                  rawClip={appliedRawClip}
                  showSkeleton={showSkeleton}
                />
              </Bounds>
              <OrbitControls
                makeDefault
                enableDamping
                dampingFactor={0.1}
                autoRotate={activeClipName == null && appliedRawClip == null}
                autoRotateSpeed={0.6}
              />
            </Canvas>
          )}
        </div>

        <div className="character-preview-meta">
          {gltf && (
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
                {/* Source toggle — IT-bundled (whatever shipped in the
                    .glb file) vs raw `.dat` from the open level.
                    Plain inline form, NOT inside `.anim-row` (that
                    class is a button-style grid for clip rows; using
                    it here made the select look broken). */}
                <div className="anim-source-row">
                  <label htmlFor="anim-source-select">Source</label>
                  <select
                    id="anim-source-select"
                    value={animSource}
                    onChange={(e) => setAnimSource(e.target.value as AnimSource)}
                  >
                    <option value="file">Bundled in this file</option>
                    <option value="level" disabled={!levelFolder}>
                      Level animsets{!levelFolder ? " (no level open)" : ""}
                    </option>
                  </select>
                </div>

                {animSource === "file" && (
                  <>
                    {gltf.animations.length === 0 ? (
                      <p className="dim small">
                        No animation clips in this file. InsomniaToolset
                        usually splits character mesh and animations into
                        separate `.glb`s — switch the source to "Level
                        animsets" to load clips from the open level's
                        `animsets.dat`.
                      </p>
                    ) : (
                      <div className="anim-list">
                        {gltf.animations.map((clip) => (
                          <button
                            key={clip.name}
                            type="button"
                            className={`anim-row ${activeClipName === clip.name ? "active" : ""}`}
                            onClick={() => {
                              setActiveClipName(
                                activeClipName === clip.name ? null : clip.name,
                              );
                              setAppliedRawClip(null);
                              setAppliedRawClipName(null);
                            }}
                            title={`${clip.duration.toFixed(2)}s`}
                          >
                            <span className="anim-row-icon">
                              {activeClipName === clip.name ? "❚❚" : "▶"}
                            </span>
                            <span className="anim-row-name">{clip.name}</span>
                            <span className="anim-row-dur mono small">
                              {clip.duration.toFixed(2)}s
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </>
                )}

                {animSource === "level" && (
                  <>
                    {levelAnimsetsError && (
                      <p className="error small">{levelAnimsetsError}</p>
                    )}
                    {levelAnimsets === null && !levelAnimsetsError && (
                      <p className="dim small">Loading level animsets…</p>
                    )}
                    {levelAnimsets && levelAnimsets.length === 0 && (
                      <p className="dim small">
                        No animsets found in the level's `animsets.dat`.
                      </p>
                    )}
                    {/* Matches first — driven by name overlap with the
                        .glb filename stem (e.g. `coop_medic` matches
                        clips like `coop_medic_idle`). */}
                    {matchingAnimsets.length > 0 && (
                      <>
                        <p className="dim small" style={{ marginTop: 4, marginBottom: 4 }}>
                          Matching this character ({matchingAnimsets.length})
                        </p>
                        <div className="anim-list">
                          {matchingAnimsets.map((c) => (
                            <AnimsetRow
                              key={c.tuid_hex}
                              clip={c}
                              active={appliedRawClipName === c.name}
                              onClick={() => applyLevelClip(c)}
                            />
                          ))}
                        </div>
                      </>
                    )}
                    {/* When matches are empty (no name overlap with
                        the glb filename), default to expanded so the
                        user has SOMETHING to click. Otherwise hide
                        the global list behind a "Show all" toggle. */}
                    {otherAnimsets.length > 0 && matchingAnimsets.length === 0 && !showAllAnimsets && (
                      <p className="dim small" style={{ marginTop: 10 }}>
                        No animations match this character. Click below
                        to browse the full level animset list.
                      </p>
                    )}
                    {otherAnimsets.length > 0 && (
                      <button
                        type="button"
                        className="btn btn-ghost"
                        style={{ marginTop: 10, width: "100%" }}
                        onClick={() => setShowAllAnimsets((v) => !v)}
                      >
                        {showAllAnimsets
                          ? `Hide other animations (${otherAnimsets.length})`
                          : `Show all other animations (${otherAnimsets.length})`}
                      </button>
                    )}
                    {otherAnimsets.length > 0 && showAllAnimsets && (
                      <>
                        <p className="dim small" style={{ marginTop: 10, marginBottom: 4 }}>
                          {matchingAnimsets.length > 0
                            ? `All other animations (${otherAnimsets.length})`
                            : `All animations (${otherAnimsets.length})`}
                        </p>
                        <div className="anim-list">
                          {otherAnimsets.map((c) => (
                            <AnimsetRow
                              key={c.tuid_hex}
                              clip={c}
                              active={appliedRawClipName === c.name}
                              onClick={() => applyLevelClip(c)}
                            />
                          ))}
                        </div>
                      </>
                    )}
                    {sceneBones.length === 0 && levelAnimsets && (
                      <p className="dim small" style={{ marginTop: 6 }}>
                        ⚠ This file has no skinned mesh — clips will load
                        but won't visibly animate the geometry.
                      </p>
                    )}
                  </>
                )}

                {exportError && (
                  <p className="error small" style={{ marginTop: 6 }}>
                    Export error: {exportError}
                  </p>
                )}
              </div>

              <div className="inspector-section">
                <h4>Stats</h4>
                <dl className="kv">
                  <dt>Animations</dt>
                  <dd>{gltf.animations.length}</dd>
                  <dt>Scenes</dt>
                  <dd>{gltf.scenes.length}</dd>
                  <dt>Cameras</dt>
                  <dd>{gltf.cameras?.length ?? 0}</dd>
                  {textureStatus && (
                    <>
                      <dt>Textures</dt>
                      <dd>
                        {textureStatus.loaded} / {textureStatus.requested} resolved
                      </dd>
                    </>
                  )}
                </dl>
              </div>

              <div className="inspector-section">
                <h4>File</h4>
                {file && (
                  <p className="mono small dim" style={{ wordBreak: "break-all" }}>
                    {file.path}
                  </p>
                )}
                <p className="dim small" style={{ marginTop: 6 }}>
                  Already a glTF — re-export from Blender if you need a
                  different format. The file on disk is unchanged.
                </p>
              </div>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

/**
 * Renders the loaded GLTF scene + drives the AnimationMixer if a clip
 * is active. Lives inside the Canvas (needs `useFrame`).
 *
 * When `showSkeleton` is true, walks the scene for the first SkinnedMesh
 * and adds a `THREE.SkeletonHelper` for it — the bones render as cyan
 * line segments overlaid on the model.
 */
function GltfScene({
  gltf,
  activeClipName,
  rawClip,
  showSkeleton,
}: {
  gltf: GLTF;
  activeClipName: string | null;
  /** Raw `.dat`-derived clip already remapped to this GLB's bone names.
   *  When non-null, plays it (overrides `activeClipName`). */
  rawClip: THREE.AnimationClip | null;
  showSkeleton: boolean;
}) {
  // Mixer lives across renders. We need a clone that ALSO remaps skeleton
  // bones — `THREE.Object3D.clone(true)` is deep but a known three.js
  // footgun for skinned meshes: it copies the SkinnedMesh node but leaves
  // `skeleton.bones[]` pointing at the ORIGINAL bone tree. The mixer then
  // animates the cloned scene's name-matching nodes (which DO get cloned)
  // while the SkinnedMesh keeps reading the un-touched originals — net
  // effect: model stays in bind pose even though the mixer is "playing".
  //
  // `SkeletonUtils.clone()` does the skeleton-aware version: clones nodes,
  // then walks all SkinnedMeshes and rebinds them to the cloned bone
  // hierarchy. Result: animation actually deforms the visible mesh.
  const scene = useMemo(() => skeletonAwareClone(gltf.scene), [gltf]);
  const mixerRef = useRef<THREE.AnimationMixer | null>(null);
  const actionRef = useRef<THREE.AnimationAction | null>(null);

  // Find the first SkinnedMesh's root bone for SkeletonHelper. Built
  // lazily because most scenes have at most one rig and the scan is cheap.
  const skeletonRoot = useMemo(() => {
    let found: THREE.Object3D | null = null;
    scene.traverse((obj) => {
      if (found) return;
      if (obj instanceof THREE.SkinnedMesh && obj.skeleton.bones.length > 0) {
        const root = obj.skeleton.bones[0]!;
        // SkeletonHelper wants the COMMON ancestor of the bones; walk up
        // until we hit something that is not a bone parent or the scene.
        let node: THREE.Object3D = root;
        while (node.parent && node.parent !== scene) {
          node = node.parent;
        }
        found = node;
      }
    });
    return found;
  }, [scene]);

  useEffect(() => {
    mixerRef.current = new THREE.AnimationMixer(scene);
    return () => {
      mixerRef.current?.stopAllAction();
      mixerRef.current?.uncacheRoot(scene);
      mixerRef.current = null;
    };
  }, [scene]);

  // Switch active clip whenever the user picks one. Raw clip wins over
  // the file-bundled clip — the UI ensures only one is set at a time
  // but if both ever are, the raw clip plays.
  useEffect(() => {
    const mixer = mixerRef.current;
    if (!mixer) return;
    actionRef.current?.stop();
    actionRef.current = null;

    let clip: THREE.AnimationClip | null = null;
    if (rawClip) {
      clip = rawClip;
    } else if (activeClipName) {
      clip = gltf.animations.find((c) => c.name === activeClipName) ?? null;
    }
    if (!clip) return;
    const action = mixer.clipAction(clip);
    action.reset().play();
    actionRef.current = action;
  }, [activeClipName, gltf.animations, rawClip]);

  // Drive the mixer. delta is in seconds.
  useFrame((_state, delta) => {
    mixerRef.current?.update(delta);
  });

  return (
    <>
      <primitive object={scene} />
      {showSkeleton && skeletonRoot && (
        <primitive object={new THREE.SkeletonHelper(skeletonRoot)} />
      )}
    </>
  );
}

/**
 * Convert a raw-`.dat` `DecodedClip` into a `THREE.AnimationClip` whose
 * tracks target the bones in the loaded GLB by NAME.
 *
 * The decoder produces tracks named `bone_${i}` (index-based, see
 * skinning.ts). The GLB's bones have whatever names IT wrote — could be
 * "Bone", "spine_03", or just empty strings depending on the export.
 * We assume **same index ordering** between IT's GLB skeleton and the
 * raw `.dat` skeleton (both ultimately read from `mobys.dat`'s bone
 * table), and remap by index → bone[i].name.
 *
 * If the count differs (face-only viseme clips can drive bones beyond
 * the head sub-skeleton), tracks beyond `bones.length - 1` are dropped.
 */
function buildClipForGlbBones(
  decoded: DecodedClip,
  bones: THREE.Bone[],
): THREE.AnimationClip {
  const fps = decoded.frame_rate > 0 ? decoded.frame_rate : 30;
  const dt = 1 / fps;
  const tracks: THREE.KeyframeTrack[] = [];

  const animatedTimes: number[] = [];
  for (let i = 0; i < decoded.num_frames; i++) animatedTimes.push(i * dt);
  const staticTimes: number[] = [0];

  const bonesToUse = Math.min(decoded.bones.length, bones.length);
  for (let b = 0; b < bonesToUse; b++) {
    const decodedBone = decoded.bones[b];
    const targetName = bones[b]?.name;
    if (!decodedBone || !targetName) continue;

    if (decodedBone.rotations.length > 0) {
      const t = decodedBone.rotation_animated ? animatedTimes : staticTimes;
      tracks.push(
        new THREE.QuaternionKeyframeTrack(
          `${targetName}.quaternion`,
          t,
          decodedBone.rotations,
        ),
      );
    }
    if (decodedBone.translations.length > 0) {
      const t = decodedBone.translation_animated ? animatedTimes : staticTimes;
      tracks.push(
        new THREE.VectorKeyframeTrack(
          `${targetName}.position`,
          t,
          decodedBone.translations,
        ),
      );
    }
    if (decodedBone.scales.length > 0) {
      const t = decodedBone.scale_animated ? animatedTimes : staticTimes;
      tracks.push(
        new THREE.VectorKeyframeTrack(
          `${targetName}.scale`,
          t,
          decodedBone.scales,
        ),
      );
    }
  }

  const duration = decoded.num_frames > 0 ? (decoded.num_frames - 1) * dt : 0;
  return new THREE.AnimationClip(decoded.name || "clip", duration, tracks);
}

/** Single row in the animset list — extracted because it's reused in
 *  both the "matching" and "all other" sublists. */
function AnimsetRow({
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
