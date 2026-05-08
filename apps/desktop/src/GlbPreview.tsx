import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { Bounds, OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { Menu, X } from "lucide-react";
import {
  decodeAnimsetClip,
  listAnimsets,
  readCachedBytes,
  type AnimsetSummary,
} from "./api";
import { Select, type SelectOption } from "./Select";
import { buildAnimationClip } from "./animClipBuilder";

interface GlbPreviewProps {
  folder: string;
  assetTuidHex: string;
  kind: "moby" | "tie";
  exportPicks?: ExportPicks;
  onExportPicksChange?: (picks: ExportPicks) => void;
}

export interface ExportPicks {
  byAnimset: Record<string, number[]>;
}

interface LoadedGlb {
  scene: THREE.Group;
  animations: THREE.AnimationClip[];
  dispose: () => void;
}

export function GlbPreview({
  folder,
  assetTuidHex,
  kind,
  exportPicks,
  onExportPicksChange,
}: GlbPreviewProps) {
  const [loaded, setLoaded] = useState<LoadedGlb | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [extraClips, setExtraClips] = useState<Map<string, THREE.AnimationClip>>(
    new Map(),
  );
  const [activeClipKey, setActiveClipKey] = useState<string>("");

  const [menuOpen, setMenuOpen] = useState(false);
  const [animsets, setAnimsets] = useState<AnimsetSummary[] | null>(null);
  const [animsetsError, setAnimsetsError] = useState<string | null>(null);
  const [loadingClipKey, setLoadingClipKey] = useState<string | null>(null);
  const [clipLoadError, setClipLoadError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const localPicks = exportPicks ?? { byAnimset: {} };
  const setLocalPicks = (next: ExportPicks) => {
    onExportPicksChange?.(next);
  };

  useEffect(() => {
    let cancelled = false;
    setLoaded(null);
    setError(null);
    setExtraClips(new Map());
    setActiveClipKey("");
    setAnimsets(null);
    setAnimsetsError(null);
    setMenuOpen(false);
    setClipLoadError(null);
    setExpanded({});

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
              setActiveClipKey(`builtin:${gltf.animations[0]!.name}`);
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

  const ensureAnimsets = useCallback(async () => {
    if (animsets || animsetsError) return;
    try {
      const list = await listAnimsets(folder);
      setAnimsets(list);
    } catch (e) {
      setAnimsetsError(`${e}`);
    }
  }, [animsets, animsetsError, folder]);

  useEffect(() => {
    if (menuOpen) ensureAnimsets();
  }, [menuOpen, ensureAnimsets]);

  const ensureClipLoaded = async (
    animsetHash: string,
    clipIndex: number,
    clipName: string,
  ): Promise<{ key: string; clip: THREE.AnimationClip } | null> => {
    const key = `${animsetHash}:${clipIndex}`;
    const existing = extraClips.get(key);
    if (existing) return { key, clip: existing };
    setLoadingClipKey(key);
    setClipLoadError(null);
    try {
      const dto = await decodeAnimsetClip(folder, assetTuidHex, animsetHash, clipIndex);
      const clip = buildAnimationClip(dto);
      if (!clip.name) clip.name = clipName;
      setExtraClips((prev) => {
        const next = new Map(prev);
        next.set(key, clip);
        return next;
      });
      return { key, clip };
    } catch (e) {
      setClipLoadError(`Clip load failed: ${e}`);
      return null;
    } finally {
      setLoadingClipKey(null);
    }
  };

  const playClip = async (
    animsetHash: string,
    clipIndex: number,
    clipName: string,
  ) => {
    const loaded = await ensureClipLoaded(animsetHash, clipIndex, clipName);
    if (loaded) setActiveClipKey(`extra:${loaded.key}`);
  };

  const setExportPick = (animsetHash: string, clipIndex: number, on: boolean) => {
    const cur = new Set(localPicks.byAnimset[animsetHash] ?? []);
    if (on) cur.add(clipIndex);
    else cur.delete(clipIndex);
    const next: ExportPicks = {
      byAnimset: { ...localPicks.byAnimset },
    };
    if (cur.size === 0) delete next.byAnimset[animsetHash];
    else next.byAnimset[animsetHash] = [...cur].sort((a, b) => a - b);
    setLocalPicks(next);
  };

  const togglePick = async (
    animsetHash: string,
    clipIndex: number,
    clipName: string,
  ) => {
    const isPicked = (localPicks.byAnimset[animsetHash] ?? []).includes(clipIndex);
    if (isPicked) {
      setExportPick(animsetHash, clipIndex, false);
      const key = `${animsetHash}:${clipIndex}`;
      setExtraClips((prev) => {
        if (!prev.has(key)) return prev;
        const next = new Map(prev);
        next.delete(key);
        return next;
      });
      if (activeClipKey === `extra:${key}`) setActiveClipKey("");
    } else {
      const loaded = await ensureClipLoaded(animsetHash, clipIndex, clipName);
      if (loaded) {
        setExportPick(animsetHash, clipIndex, true);
      }
    }
  };

  const setAllForAnimset = (animsetHash: string, count: number, on: boolean) => {
    const next: ExportPicks = { byAnimset: { ...localPicks.byAnimset } };
    if (on && count > 0) {
      next.byAnimset[animsetHash] = Array.from({ length: count }, (_, i) => i);
    } else {
      delete next.byAnimset[animsetHash];
      setExtraClips((prev) => {
        const m = new Map(prev);
        for (const k of Array.from(m.keys())) {
          if (k.startsWith(`${animsetHash}:`)) m.delete(k);
        }
        return m;
      });
      if (activeClipKey.startsWith(`extra:${animsetHash}:`)) setActiveClipKey("");
    }
    setLocalPicks(next);
  };

  const setAllForAllAnimsets = (on: boolean) => {
    if (!animsets) return;
    if (on) {
      const next: ExportPicks = { byAnimset: { ...localPicks.byAnimset } };
      for (const a of animsets) {
        if (a.clips.length === 0) continue;
        next.byAnimset[a.hash] = Array.from({ length: a.clips.length }, (_, i) => i);
      }
      setLocalPicks(next);
    } else {
      setLocalPicks({ byAnimset: {} });
      setExtraClips(new Map());
      if (activeClipKey.startsWith("extra:")) setActiveClipKey("");
    }
  };

  const totalPicks = useMemo(
    () =>
      Object.values(localPicks.byAnimset).reduce(
        (acc, arr) => acc + arr.length,
        0,
      ),
    [localPicks],
  );

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

  const clipOptions: SelectOption[] = [
    { value: "", label: "— rest pose —" },
    ...loaded.animations.map<SelectOption>((c) => ({
      value: `builtin:${c.name}`,
      label: c.name,
      hint: `${c.duration.toFixed(2)}s · default`,
    })),
    ...Array.from(extraClips.entries()).map<SelectOption>(([key, c]) => ({
      value: `extra:${key}`,
      label: c.name,
      hint: `${c.duration.toFixed(2)}s · added`,
    })),
  ];

  const activeClip: THREE.AnimationClip | null = (() => {
    if (!activeClipKey) return null;
    if (activeClipKey.startsWith("builtin:")) {
      const name = activeClipKey.slice("builtin:".length);
      return loaded.animations.find((c) => c.name === name) ?? null;
    }
    if (activeClipKey.startsWith("extra:")) {
      return extraClips.get(activeClipKey.slice("extra:".length)) ?? null;
    }
    return null;
  })();

  return (
    <div className="glb-preview-stack">
      <div className="glb-preview-controls">
        <label className="dim small">Animation</label>
        <Select
          value={activeClipKey}
          onChange={setActiveClipKey}
          ariaLabel="Animation"
          className="glb-preview-select"
          options={clipOptions}
        />
        <button
          type="button"
          className={`glb-preview-burger${menuOpen ? " is-open" : ""}`}
          onClick={() => setMenuOpen((v) => !v)}
          aria-label={menuOpen ? "Close animation list" : "Open animation list"}
          title={
            totalPicks > 0
              ? `${totalPicks} clip${totalPicks === 1 ? "" : "s"} marked for export`
              : "All level animations"
          }
        >
          {menuOpen ? <X size={16} /> : <Menu size={16} />}
          {totalPicks > 0 && !menuOpen && (
            <span className="glb-preview-burger-badge">{totalPicks}</span>
          )}
        </button>
      </div>

      <div className="glb-preview-canvas-wrap">
        <Canvas
          camera={{ position: [3, 2, 3], fov: 40, near: 0.01, far: 10000 }}
          dpr={[1, 1.5]}
        >
          <color attach="background" args={["#0b0c0e"]} />
          <ambientLight intensity={0.55} />
          <directionalLight position={[5, 10, 7.5]} intensity={1.1} />
          <directionalLight position={[-5, -2, -5]} intensity={0.35} />

          <Bounds fit clip observe margin={1.2}>
            <GlbScene scene={loaded.scene} clip={activeClip} />
          </Bounds>

          <OrbitControls
            makeDefault
            enableDamping
            dampingFactor={0.1}
          />
        </Canvas>

        {menuOpen && (
          <aside className="glb-preview-menu">
            <header className="glb-preview-menu-header">
              <strong>Animations</strong>
              <span className="dim small">
                {totalPicks} marked for export
              </span>
            </header>
            <p className="dim small glb-preview-menu-hint">
              Play any animation on this skeleton, or check the box to bake it
              into the export GLB as an Action.
            </p>
            {clipLoadError && (
              <p className="warn-text small">{clipLoadError}</p>
            )}
            {animsetsError && (
              <p className="warn-text small">
                Failed to list animsets: {animsetsError}
              </p>
            )}
            {!animsets && !animsetsError && (
              <p className="dim small">Loading animsets…</p>
            )}
            {animsets && (
              <>
                {(() => {
                  const totalAvailable = animsets.reduce(
                    (acc, a) => acc + a.clips.length,
                    0,
                  );
                  const allChecked =
                    totalAvailable > 0 && totalPicks === totalAvailable;
                  const someChecked = totalPicks > 0 && !allChecked;
                  const allExpanded =
                    animsets.length > 0 &&
                    animsets.every((a) => expanded[a.hash]);
                  return (
                    <div className="glb-preview-menu-allrow">
                      <TriStateCheckbox
                        checked={allChecked}
                        indeterminate={someChecked}
                        onToggle={(next) => setAllForAllAnimsets(next)}
                        ariaLabel="Select all animations"
                      />
                      <span className="small glb-preview-menu-allrow-label">
                        <strong>All animsets</strong>
                        <span className="dim">
                          {" "}· {totalPicks} / {totalAvailable}
                        </span>
                      </span>
                      <button
                        type="button"
                        className="btn small"
                        onClick={() => {
                          if (allExpanded) {
                            setExpanded({});
                          } else {
                            const next: Record<string, boolean> = {};
                            for (const a of animsets) next[a.hash] = true;
                            setExpanded(next);
                          }
                        }}
                      >
                        {allExpanded ? "Collapse all" : "Expand all"}
                      </button>
                    </div>
                  );
                })()}
                <ul className="glb-preview-menu-list">
                {animsets.map((a) => {
                  const picked = localPicks.byAnimset[a.hash] ?? [];
                  const allInPicked =
                    a.clips.length > 0 && picked.length === a.clips.length;
                  const partial =
                    picked.length > 0 && picked.length < a.clips.length;
                  const isOpen = !!expanded[a.hash];
                  return (
                  <li key={a.hash} className="glb-preview-menu-animset">
                    <div className="glb-preview-menu-animset-header mono small">
                      <button
                        type="button"
                        className="glb-preview-menu-chevron"
                        onClick={() =>
                          setExpanded((p) => ({ ...p, [a.hash]: !isOpen }))
                        }
                        aria-label={isOpen ? "Collapse" : "Expand"}
                        aria-expanded={isOpen}
                      >
                        {isOpen ? "▾" : "▸"}
                      </button>
                      <TriStateCheckbox
                        checked={allInPicked}
                        indeterminate={partial}
                        onToggle={(next) =>
                          setAllForAnimset(a.hash, a.clips.length, next)
                        }
                        ariaLabel={`Select all in ${a.hash}`}
                      />
                      <span className="glb-preview-menu-animset-label">
                        {a.hash}
                        <span className="dim">
                          {" "}· {picked.length} / {a.clips.length}
                        </span>
                      </span>
                    </div>
                    {isOpen && (
                    <ul className="glb-preview-menu-clips">
                      {a.clips.length === 0 && (
                        <li className="dim small">no clips</li>
                      )}
                      {a.clips.map((c, i) => {
                        const key = `${a.hash}:${i}`;
                        const checked =
                          (localPicks.byAnimset[a.hash] ?? []).includes(i);
                        const isPlaying = activeClipKey === `extra:${key}`;
                        const loading = loadingClipKey === key;
                        return (
                          <li
                            key={i}
                            className={`glb-preview-menu-clip${isPlaying ? " is-playing" : ""}`}
                          >
                            <button
                              type="button"
                              className="glb-preview-menu-clip-play-btn"
                              onClick={() => playClip(a.hash, i, c.name)}
                              disabled={loading}
                              aria-label={`Play ${c.name}`}
                              title="Play in preview"
                            >
                              ▶
                            </button>
                            <label className="glb-preview-menu-clip-check">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => togglePick(a.hash, i, c.name)}
                              />
                            </label>
                            <span className="glb-preview-menu-clip-info">
                              <span className="mono small">{c.name}</span>
                              <span className="dim small">
                                {c.num_frames}f · {c.frame_rate.toFixed(0)}fps
                                {loading ? " · loading…" : ""}
                              </span>
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                    )}
                  </li>
                  );
                })}
                </ul>
              </>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}

function TriStateCheckbox({
  checked,
  indeterminate,
  onToggle,
  ariaLabel,
}: {
  checked: boolean;
  indeterminate: boolean;
  onToggle: (next: boolean) => void;
  ariaLabel?: string;
}) {
  const ref = useRef<HTMLInputElement | null>(null);
  useLayoutEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      aria-label={ariaLabel}
      checked={checked}
      onChange={() => onToggle(!checked)}
    />
  );
}

function GlbScene({
  scene,
  clip,
}: {
  scene: THREE.Group;
  clip: THREE.AnimationClip | null;
}) {
  const mixer = useMemo(() => new THREE.AnimationMixer(scene), [scene]);
  const actionRef = useRef<THREE.AnimationAction | null>(null);

  useEffect(() => {
    if (actionRef.current) {
      actionRef.current.stop();
      actionRef.current = null;
    }
    mixer.stopAllAction();
    if (!clip) return;
    const action = mixer.clipAction(clip);
    action.reset();
    action.setLoop(THREE.LoopRepeat, Infinity);
    action.play();
    actionRef.current = action;
  }, [mixer, clip]);

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
