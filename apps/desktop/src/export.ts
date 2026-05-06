import * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import {
  decodeMeshGeom,
  fetchAnimsetClip,
  type AssetMeshes,
  type Instance,
  type LevelMeshes,
  type TextureBlobMap,
} from "./api";
import {
  buildAnimationClipFromDecoded,
  buildSkinnedAsset,
  isSkinnedAsset,
} from "./skinning";

/** Phase the export pipeline is currently in. */
export type ExportPhase =
  | "preparing"
  | "decoding-textures"
  | "encoding"
  | "writing"
  | "done";

export interface ExportProgressState {
  phase: ExportPhase;
  /** Human-readable label for the current phase. */
  label: string;
  /** 0..1 — best-effort estimate (some phases are atomic and stay at the same value). */
  fraction: number;
  /** Optional context such as the destination path. */
  detail?: string;
  /** Set when the operation aborted (currently only on internal errors —
   *  the picker now happens BEFORE this function is called). */
  cancelled?: boolean;
}

export interface ExportResult {
  /** Where it ended up on disk. */
  path: string;
  bytes: number;
}

/** Sanitize an asset name into a filesystem-safe filename stem. */
function sanitizeFilename(s: string): string {
  // Strip characters disallowed on Windows (the strictest of the three OSes).
  return (
    s
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
      .replace(/\s+/g, "_")
      .replace(/^\.+/, "")
      .slice(0, 80) || "asset"
  );
}

/**
 * Open the native save dialog for the .glb export. Returns the chosen
 * path or null if the user cancelled. Kept as a separate step (rather
 * than rolling it into `exportToGlb`) so the caller can run it BEFORE
 * showing any in-app modal — otherwise the OS dialog can end up behind
 * the modal and never get focus on Windows / Linux.
 *
 * Default filename uses the actual asset name(s):
 *   - single selection: `<sanitized_name>.glb`
 *   - multi: `<first_name>_+N.glb`
 *   - empty selection: legacy `rechimera-0-objects.glb`
 */
export async function pickGlbExportPath(
  selectedInstances: Instance[],
): Promise<string | null> {
  let defaultName: string;
  if (selectedInstances.length === 0) {
    defaultName = "rechimera-0-objects.glb";
  } else if (selectedInstances.length === 1) {
    const inst = selectedInstances[0]!;
    const stem = sanitizeFilename(inst.name || inst.tuid.split("#")[0] || "asset");
    defaultName = `${stem}.glb`;
  } else {
    const first = selectedInstances[0]!;
    const stem = sanitizeFilename(first.name || first.tuid.split("#")[0] || "asset");
    defaultName = `${stem}_+${selectedInstances.length - 1}.glb`;
  }

  const path = await save({
    title: "Export selection as glTF binary (.glb)",
    defaultPath: defaultName,
    filters: [{ name: "Binary glTF", extensions: ["glb"] }],
  });
  return typeof path === "string" ? path : null;
}

/**
 * Encode the current selection to `.glb` and write it to `path`.
 * Reports progress through `onProgress` callbacks so the UI can show a
 * phased modal.
 *
 * The phases:
 *   1. preparing         — assemble three.js scene from selection + cached meshes
 *   2. decoding-textures  — decode any textures the selection references
 *   3. encoding          — GLTFExporter serializes the scene to a binary glTF
 *   4. writing           — bytes flushed to disk via the `write_bytes` Tauri command
 *   5. done              — final state; modal can close
 */
export async function exportToGlb(
  selectedIds: Set<string>,
  instances: Instance[],
  meshes: LevelMeshes | null,
  /** Texture PNG bytes keyed by id. Required when the selection
   *  references textures — null is allowed when the bulk fetch hasn't
   *  resolved yet, but the export will skip texture maps in that case. */
  textureBlobs: TextureBlobMap | null,
  path: string,
  onProgress?: (s: ExportProgressState) => void,
  levelFolder?: string | null,
  /** Optional clip override (TUID hex) — when set, every skinned
   *  character in the export gets THIS animset baked in instead of
   *  the moby's own `animset_hash`. Drives the "selected animation
   *  in the Hierarchy" → "Blender Action" path. Pass `null` to use
   *  each moby's own animset. */
  overrideAnimsetHash?: string | null,
): Promise<ExportResult> {
  const emit = (s: ExportProgressState) => onProgress?.(s);

  if (selectedIds.size === 0 || !meshes) {
    throw new Error("Nothing selected to export");
  }
  const selectedInstances = instances.filter((i) => selectedIds.has(i.tuid));
  if (selectedInstances.length === 0) {
    throw new Error("No matching instances in selection");
  }

  // ── Phase 1: build the three.js scene from the streamed payloads.
  emit({
    phase: "preparing",
    label: "Building scene from selection",
    fraction: 0.05,
    detail: path,
  });
  await yieldToBrowser();

  const assetLib = new Map<string, AssetMeshes>();
  for (const a of meshes.moby_assets) assetLib.set(a.asset_tuid, a);
  for (const a of meshes.tie_assets) assetLib.set(a.asset_tuid, a);

  const root = new THREE.Group();
  root.name = `ReChimera-export-${selectedInstances.length}`;

  // Track which texture ids we'll need.
  const neededAlbedos = new Set<number>();
  // Animation clips collected across the whole export. Blender's glTF
  // importer reads each as a separate Action (NLA strip), so a character
  // with one animset → one Action; a multi-character export ends up
  // with one Action per character.
  const animationClips: THREE.AnimationClip[] = [];
  // Track skinned-asset rigs we've already built so we can dispose them
  // after the GLTFExporter has serialized everything.
  const skinnedRigsToDispose: Array<{ dispose: () => void }> = [];

  for (let idx = 0; idx < selectedInstances.length; idx++) {
    const inst = selectedInstances[idx]!;
    const asset = assetLib.get(inst.asset_tuid);
    if (!asset) continue;

    const node = new THREE.Group();
    node.name = inst.name || inst.tuid;
    node.position.set(inst.position[0]!, inst.position[1]!, inst.position[2]!);
    node.quaternion.set(
      inst.quaternion[0]!,
      inst.quaternion[1]!,
      inst.quaternion[2]!,
      inst.quaternion[3]!,
    );
    node.scale.set(inst.scale[0]!, inst.scale[1]!, inst.scale[2]!);
    node.userData = {
      tuid: inst.tuid,
      asset_tuid: inst.asset_tuid,
      kind: inst.kind,
    };

    if (isSkinnedAsset(asset)) {
      // Skinned path — build a real SkinnedMesh + Skeleton and (when an
      // animset is linked + we know the level folder) fetch + bake the
      // animation clip into the export. Blender opens the resulting .glb
      // with the rig + Action populated.
      const built = buildSkinnedAsset(asset);
      if (built) {
        skinnedRigsToDispose.push(built);
        node.add(built.root);
        for (const s of asset.submeshes) {
          if (s.albedo_id != null) neededAlbedos.add(s.albedo_id);
          if (s.normal_id != null) neededAlbedos.add(s.normal_id);
          if (s.emissive_id != null) neededAlbedos.add(s.emissive_id);
        }

        // Pick which animset to bake. Override wins (user picked a
        // specific clip in the Hierarchy); else fall back to the moby's
        // own animset_hash; else skip animations entirely.
        const targetHash = overrideAnimsetHash ?? asset.animset_hash;
        if (targetHash && levelFolder) {
          try {
            const decoded = await fetchAnimsetClip(
              levelFolder,
              targetHash,
              asset.bind_pose_inverse_offset ?? 0,
              asset.skeleton?.scale_shift ?? 0,
            );
            const aclip = buildAnimationClipFromDecoded(
              decoded,
              built.bones.length,
            );
            if (aclip.tracks.length > 0) {
              // Name the clip after the moby + animset clip name so
              // Blender's Action list shows something legible.
              aclip.name = `${inst.name || inst.tuid}_${decoded.name || "clip"}`;
              animationClips.push(aclip);
              // Attach to first SkinnedMesh so GLTFExporter's animation
              // walker picks it up (it scans `.animations` arrays on
              // every mesh).
              const sm = built.skinnedMeshes[0];
              if (sm) sm.animations = [aclip];
            }
          } catch (err) {
            // Don't fail the whole export over one clip — log and move on.
            console.warn(`Animset fetch failed for ${targetHash}:`, err);
          }
        }
      }
    } else {
      // Static path — original behavior. One plain Mesh per submesh.
      for (let i = 0; i < asset.submeshes.length; i++) {
        const s = asset.submeshes[i]!;
        const decoded = decodeMeshGeom(s);
        const geom = new THREE.BufferGeometry();
        geom.setAttribute("position", new THREE.BufferAttribute(decoded.positions, 3));
        if (decoded.uvs.length > 0) {
          geom.setAttribute("uv", new THREE.BufferAttribute(decoded.uvs, 2));
        }
        geom.setIndex(new THREE.BufferAttribute(decoded.indices, 1));

        const material = new THREE.MeshStandardMaterial({
          color: 0xffffff,
          roughness: 0.85,
          metalness: 0,
          emissive: s.emissive_id != null ? 0xffffff : 0x000000,
          emissiveIntensity: s.emissive_id != null ? 0.7 : 0,
          name: `slots_a${s.albedo_id ?? "_"}_n${s.normal_id ?? "_"}_e${s.emissive_id ?? "_"}`,
        });
        if (s.albedo_id != null) neededAlbedos.add(s.albedo_id);
        if (s.normal_id != null) neededAlbedos.add(s.normal_id);
        if (s.emissive_id != null) neededAlbedos.add(s.emissive_id);

        const mesh = new THREE.Mesh(geom, material);
        mesh.name = `${inst.name || inst.tuid}_sm${i}`;
        node.add(mesh);
      }
    }
    root.add(node);

    // Yield every 32 instances so we don't block the event loop on huge selections.
    if (idx % 32 === 0) {
      const frac = 0.05 + (idx / selectedInstances.length) * 0.25;
      emit({
        phase: "preparing",
        label: `Building scene (${idx + 1}/${selectedInstances.length})`,
        fraction: frac,
        detail: path,
      });
      await yieldToBrowser();
    }
  }

  // ── Phase 3: decode textures (PNG bytes → THREE.Texture).
  emit({
    phase: "decoding-textures",
    label: `Decoding ${neededAlbedos.size} texture(s)`,
    fraction: 0.35,
    detail: path,
  });
  await yieldToBrowser();

  const textureMap = new Map<number, THREE.Texture>();
  let texCount = 0;
  for (const id of neededAlbedos) {
    const blob = textureBlobs?.get(id);
    if (!blob) continue;
    const tex = await loadOneTexture(blob);
    textureMap.set(id, tex);
    texCount++;
    const frac = 0.35 + (texCount / Math.max(1, neededAlbedos.size)) * 0.2;
    emit({
      phase: "decoding-textures",
      label: `Decoded ${texCount}/${neededAlbedos.size} textures`,
      fraction: frac,
      detail: path,
    });
  }

  // Attach albedo / normal / emissive textures to materials. The material
  // name has format `slots_a<aId|_>_n<nId|_>_e<eId|_>`; we parse each slot
  // and look it up in the texture cache.
  // `[^_]+|_` so the null marker (single `_`) matches its own group instead
  // of failing the whole regex. Without this, any moby with even one missing
  // slot (most non-character mobys) exported with NO textures at all — the
  // available albedo never got attached because the regex bailed on the
  // null normal/emissive slots.
  const slotRe = /^slots_a([^_]+|_)_n([^_]+|_)_e([^_]+|_)$/;
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const mat = obj.material as THREE.MeshStandardMaterial;
    if (!mat.name) return;
    const match = slotRe.exec(mat.name);
    if (!match) return;
    const [_, aRaw, nRaw, eRaw] = match;
    const aId = aRaw === "_" ? null : Number(aRaw);
    const nId = nRaw === "_" ? null : Number(nRaw);
    const eId = eRaw === "_" ? null : Number(eRaw);
    const a = aId != null ? textureMap.get(aId) : undefined;
    const n = nId != null ? textureMap.get(nId) : undefined;
    const e = eId != null ? textureMap.get(eId) : undefined;
    if (a) mat.map = a;
    if (n) mat.normalMap = n;
    if (e) mat.emissiveMap = e;
    if (a || n || e) mat.needsUpdate = true;
  });

  // ── Phase 4: GLTFExporter — synchronous and the slowest single step.
  emit({
    phase: "encoding",
    label: "Encoding binary glTF",
    fraction: 0.6,
    detail: path,
  });
  await yieldToBrowser();

  const exporter = new GLTFExporter();
  // Silence GLTFExporter's per-mesh "Creating normalized normal attribute…"
  // warning. It fires whether or not we precompute normals — the exporter
  // re-derives them as packed Int8 for the GLB and warns each time. The
  // output is fine; the warning is just noise that floods DevTools.
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    if (
      typeof args[0] === "string" &&
      args[0].includes("Creating normalized normal attribute")
    ) {
      return;
    }
    origWarn.apply(console, args);
  };
  let bytes: ArrayBuffer;
  try {
    bytes = await new Promise<ArrayBuffer>((resolve, reject) => {
      exporter.parse(
        root,
        (gltf) => {
          if (gltf instanceof ArrayBuffer) resolve(gltf);
          else
            reject(new Error("GLTFExporter returned JSON; expected binary"));
        },
        (err) => reject(err),
        {
          binary: true,
          includeCustomExtensions: false,
          embedImages: true,
          // Pass each AnimationClip explicitly. The exporter also walks
          // `.animations` arrays on meshes, but giving it the array up
          // front guarantees nothing is missed even if a SkinnedMesh
          // got reparented mid-build.
          animations: animationClips,
        },
      );
    });
  } finally {
    console.warn = origWarn;
    // Now that GLTFExporter has serialized everything, free the GPU
    // resources held by the SkinnedMesh rigs we built. This runs in the
    // success AND failure paths so a partial export still cleans up.
    for (const rig of skinnedRigsToDispose) rig.dispose();
  }

  // ── Phase 5: write to disk via the Tauri command.
  emit({
    phase: "writing",
    label: `Writing ${formatBytes(bytes.byteLength)} to disk`,
    fraction: 0.9,
    detail: path,
  });
  await yieldToBrowser();

  await invoke<void>("write_bytes", {
    path,
    bytes: Array.from(new Uint8Array(bytes)),
  });

  emit({
    phase: "done",
    label: `Saved ${formatBytes(bytes.byteLength)}`,
    fraction: 1,
    detail: path,
  });

  return { path, bytes: bytes.byteLength };
}

/** Yield to the browser between heavy synchronous chunks. */
function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => resolve());
    } else {
      setTimeout(resolve, 0);
    }
  });
}

function loadOneTexture(blob: Blob): Promise<THREE.Texture> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const tex = new THREE.Texture(img);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.flipY = false;
      tex.needsUpdate = true;
      URL.revokeObjectURL(url);
      resolve(tex);
    };
    img.onerror = (e) => {
      URL.revokeObjectURL(url);
      reject(e);
    };
    img.src = url;
  });
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
