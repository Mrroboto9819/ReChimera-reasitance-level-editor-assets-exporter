import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { Bounds, OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { readCachedBytes } from "./api";
import { Select, type SelectOption } from "./Select";

interface GlbPreviewProps {
  folder: string;
  assetTuidHex: string;
  kind: "moby" | "tie";
}

interface LoadedGlb {
  scene: THREE.Group;
  animations: THREE.AnimationClip[];
  dispose: () => void;
}

export function GlbPreview({ folder, assetTuidHex, kind }: GlbPreviewProps) {
  const [loaded, setLoaded] = useState<LoadedGlb | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedClip, setSelectedClip] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    setLoaded(null);
    setError(null);
    setSelectedClip("");

    const file = `${kind === "moby" ? "mobys" : "ties"}/${assetTuidHex}.glb`;

    (async () => {
      try {
        const bytes = await readCachedBytes(folder, file);
        if (cancelled) return;
        const loader = new GLTFLoader();
        loader.parse(
          bytes,
          "",
          (gltf) => {
            if (cancelled) return;
            setLoaded({
              scene: gltf.scene,
              animations: gltf.animations,
              dispose: () => {
                gltf.scene.traverse((obj) => {
                  if ((obj as THREE.Mesh).isMesh) {
                    const mesh = obj as THREE.Mesh;
                    mesh.geometry?.dispose();
                    const mat = mesh.material;
                    if (Array.isArray(mat)) {
                      for (const m of mat) m.dispose();
                    } else if (mat) {
                      mat.dispose();
                    }
                  }
                });
              },
            });
            if (gltf.animations.length > 0) {
              setSelectedClip(gltf.animations[0]!.name);
            }
          },
          (err) => {
            if (!cancelled) {
              setError(`parse failed: ${err.message ?? err}`);
            }
          },
        );
      } catch (e) {
        if (!cancelled) {
          setError(`load failed: ${e}`);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [folder, assetTuidHex, kind]);

  useEffect(() => {
    return () => {
      loaded?.dispose();
    };
  }, [loaded]);

  if (error) {
    return (
      <div className="asset-preview-empty">
        <span className="dim small">GLB load error: {error}</span>
      </div>
    );
  }
  if (!loaded) {
    return (
      <div className="asset-preview-empty">
        <span className="dim small">Loading GLB…</span>
      </div>
    );
  }

  return (
    <div className="glb-preview-stack">
      {loaded.animations.length > 0 && (
        <div className="glb-preview-controls">
          <label className="dim small">Animation</label>
          <Select
            value={selectedClip}
            onChange={setSelectedClip}
            ariaLabel="Animation"
            className="glb-preview-select"
            options={[
              { value: "", label: "— rest pose —" },
              ...loaded.animations.map<SelectOption>((clip) => ({
                value: clip.name,
                label: clip.name,
                hint: `${clip.duration.toFixed(2)}s`,
              })),
            ]}
          />
        </div>
      )}
      <Canvas
        camera={{ position: [3, 2, 3], fov: 40, near: 0.01, far: 10000 }}
        dpr={[1, 1.5]}
      >
        <color attach="background" args={["#0b0c0e"]} />
        <ambientLight intensity={0.55} />
        <directionalLight position={[5, 10, 7.5]} intensity={1.1} />
        <directionalLight position={[-5, -2, -5]} intensity={0.35} />

        <Bounds fit clip observe margin={1.2}>
          <GlbScene
            scene={loaded.scene}
            animations={loaded.animations}
            clipName={selectedClip}
          />
        </Bounds>

        <OrbitControls
          makeDefault
          enableDamping
          dampingFactor={0.1}
        />
      </Canvas>
    </div>
  );
}

function GlbScene({
  scene,
  animations,
  clipName,
}: {
  scene: THREE.Group;
  animations: THREE.AnimationClip[];
  clipName: string;
}) {
  const mixerRef = useRef<THREE.AnimationMixer | null>(null);
  const actionRef = useRef<THREE.AnimationAction | null>(null);

  const mixer = useMemo(() => {
    const m = new THREE.AnimationMixer(scene);
    mixerRef.current = m;
    return m;
  }, [scene]);

  useEffect(() => {
    if (actionRef.current) {
      actionRef.current.stop();
      actionRef.current = null;
    }
    mixer.stopAllAction();
    if (!clipName) return;
    const clip = animations.find((c) => c.name === clipName);
    if (!clip) return;
    const action = mixer.clipAction(clip);
    action.reset();
    action.setLoop(THREE.LoopRepeat, Infinity);
    action.play();
    actionRef.current = action;
  }, [mixer, animations, clipName]);

  useFrame((_, delta) => {
    mixer.update(delta);
  });

  useEffect(() => {
    return () => {
      mixer.stopAllAction();
      mixer.uncacheRoot(scene);
    };
  }, [mixer, scene]);

  return <primitive object={scene} />;
}
