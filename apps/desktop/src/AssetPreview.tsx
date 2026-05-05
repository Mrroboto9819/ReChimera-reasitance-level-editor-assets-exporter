import { useEffect, useMemo } from "react";
import { Canvas } from "@react-three/fiber";
import { Bounds, OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import type { AssetMeshes, Instance, LevelMeshes } from "./api";

interface AssetPreviewProps {
  instance: Instance | null;
  meshes: LevelMeshes | null;
}

interface BuiltSubmesh {
  geom: THREE.BufferGeometry;
  material: THREE.MeshStandardMaterial;
}

/**
 * Mini interactive 3D viewer of the selected asset. Lives inside the
 * Inspector header so the user gets a visual identifier of what's
 * currently selected — useful when names are cryptic (e.g. "moby1907").
 *
 * Auto-frames the camera with drei's `<Bounds>` so any model fits the
 * canvas regardless of original scale. Auto-rotates slowly when idle.
 * The user can drag to orbit / scroll to zoom interactively — these
 * controls are local to the preview and do not affect the main viewport.
 */
export function AssetPreview({ instance, meshes }: AssetPreviewProps) {
  if (!instance) {
    return (
      <div className="asset-preview asset-preview-empty">
        <span className="dim small">No selection</span>
      </div>
    );
  }
  if (!meshes) {
    return (
      <div className="asset-preview asset-preview-empty">
        <span className="dim small">Mesh data not loaded yet</span>
      </div>
    );
  }

  return (
    <div className="asset-preview">
      <PreviewScene instance={instance} meshes={meshes} />
      <span className="asset-preview-tag mono small">{instance.tuid.split("#")[0]}</span>
    </div>
  );
}

function PreviewScene({
  instance,
  meshes,
}: {
  instance: Instance;
  meshes: LevelMeshes;
}) {
  const asset = useMemo<AssetMeshes | undefined>(() => {
    return (
      meshes.moby_assets.find((a) => a.asset_tuid === instance.asset_tuid) ??
      meshes.tie_assets.find((a) => a.asset_tuid === instance.asset_tuid)
    );
  }, [instance.asset_tuid, meshes.moby_assets, meshes.tie_assets]);

  const submeshes = useMemo<BuiltSubmesh[]>(() => {
    if (!asset) return [];
    return asset.submeshes.map((s) => {
      const geom = new THREE.BufferGeometry();
      geom.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(s.positions, 3),
      );
      if (s.uvs.length > 0) {
        geom.setAttribute("uv", new THREE.Float32BufferAttribute(s.uvs, 2));
      }
      geom.setIndex(s.indices);
      geom.computeVertexNormals();
      geom.computeBoundingSphere();

      let texture: THREE.Texture | null = null;
      if (s.albedo_id != null) {
        const payload = meshes.textures.find((t) => t.id === s.albedo_id);
        if (payload) {
          const blob = new Blob([new Uint8Array(payload.png)], {
            type: "image/png",
          });
          const url = URL.createObjectURL(blob);
          const img = new Image();
          texture = new THREE.Texture(img);
          texture.colorSpace = THREE.SRGBColorSpace;
          texture.flipY = false;
          texture.wrapS = THREE.RepeatWrapping;
          texture.wrapT = THREE.RepeatWrapping;
          texture.needsUpdate = true;
          img.onload = () => {
            if (texture) texture.needsUpdate = true;
            URL.revokeObjectURL(url);
          };
          img.src = url;
        }
      }

      const material = new THREE.MeshStandardMaterial({
        map: texture,
        color: 0xffffff,
        roughness: 0.7,
        metalness: 0,
      });
      return { geom, material };
    });
  }, [asset, meshes.textures]);

  // Dispose GPU-backed resources when this asset changes or unmounts.
  useEffect(() => {
    return () => {
      for (const s of submeshes) {
        s.geom.dispose();
        if (s.material.map) s.material.map.dispose();
        s.material.dispose();
      }
    };
  }, [submeshes]);

  if (!asset) {
    return (
      <div className="asset-preview-empty">
        <span className="dim small">Geometry not decoded yet</span>
      </div>
    );
  }
  if (submeshes.length === 0) {
    return (
      <div className="asset-preview-empty">
        <span className="dim small">Asset has no submeshes</span>
      </div>
    );
  }

  return (
    <Canvas
      camera={{ position: [3, 2, 3], fov: 40, near: 0.01, far: 10000 }}
      dpr={[1, 1.5]}
    >
      <color attach="background" args={["#0b0c0e"]} />
      <ambientLight intensity={0.55} />
      <directionalLight position={[5, 10, 7.5]} intensity={1.1} />
      <directionalLight position={[-5, -2, -5]} intensity={0.35} />

      {/* `<Bounds fit clip observe>` auto-frames whatever's inside it. */}
      <Bounds fit clip observe margin={1.2}>
        <group>
          {submeshes.map((s, i) => (
            <mesh key={i} geometry={s.geom} material={s.material} />
          ))}
        </group>
      </Bounds>

      <OrbitControls
        makeDefault
        enableDamping
        dampingFactor={0.1}
        autoRotate
        autoRotateSpeed={0.6}
      />
    </Canvas>
  );
}
