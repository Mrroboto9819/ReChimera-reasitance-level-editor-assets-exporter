import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { Bounds, OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { readFileBytes, type GltfFile } from "./api";
import { Modal } from "./Modal";

interface GltfCharacterModalProps {
  /** Open when non-null. */
  file: GltfFile | null;
  onClose: () => void;
}

/**
 * Loads + previews a GLTF (.gltf/.glb) character produced by the
 * InsomniaToolset's `extract_assets` command. These files already have
 * skeleton + animations baked in, so we get all of that for free via
 * three.js's GLTFLoader — no Rust skeleton/animation parser needed.
 *
 * Shows the model in an interactive Canvas with auto-frame, lists all
 * animation clips, and plays them through a `THREE.AnimationMixer`.
 */
export function GltfCharacterModal({ file, onClose }: GltfCharacterModalProps) {
  const open = file !== null;
  const [gltf, setGltf] = useState<GLTF | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeClipName, setActiveClipName] = useState<string | null>(null);
  const [showSkeleton, setShowSkeleton] = useState(false);

  // (Re)load whenever a new file is selected. Clear state on close so the
  // next open starts fresh + the previous Three.js objects can GC.
  useEffect(() => {
    if (!open || !file) {
      setGltf(null);
      setActiveClipName(null);
      setLoadError(null);
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

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={file ? file.name : "GLTF preview"}
      subtitle={file ? `${(file.size_bytes / 1024).toFixed(1)} KB · ${file.extension.toUpperCase()}` : undefined}
      size="lg"
      footer={
        <button type="button" className="btn" onClick={onClose}>
          Close
        </button>
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
                  showSkeleton={showSkeleton}
                />
              </Bounds>
              <OrbitControls
                makeDefault
                enableDamping
                dampingFactor={0.1}
                autoRotate={activeClipName == null}
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
                {gltf.animations.length === 0 ? (
                  <p className="dim small">No animation clips in this file.</p>
                ) : (
                  <div className="anim-list">
                    {gltf.animations.map((clip) => (
                      <button
                        key={clip.name}
                        type="button"
                        className={`anim-row ${activeClipName === clip.name ? "active" : ""}`}
                        onClick={() =>
                          setActiveClipName(
                            activeClipName === clip.name ? null : clip.name,
                          )
                        }
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
  showSkeleton,
}: {
  gltf: GLTF;
  activeClipName: string | null;
  showSkeleton: boolean;
}) {
  // Mixer lives across renders. Clone the scene so multiple modal opens
  // don't accumulate animation state on the same Object3D tree.
  const scene = useMemo(() => gltf.scene.clone(true), [gltf]);
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

  // Switch active clip whenever the user picks one.
  useEffect(() => {
    const mixer = mixerRef.current;
    if (!mixer) return;
    actionRef.current?.stop();
    actionRef.current = null;
    if (activeClipName == null) return;
    const clip = gltf.animations.find((c) => c.name === activeClipName);
    if (!clip) return;
    const action = mixer.clipAction(clip);
    action.reset().play();
    actionRef.current = action;
  }, [activeClipName, gltf.animations]);

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
