/**
 * Filename-based classification for InsomniaToolset GLTF outputs.
 *
 * R2/R3 character assets are split across multiple GLTFs — a body, a head
 * (sometimes multiple heads for variant kits), first-person hands for the
 * FPS view, and per-weapon GLTFs. The Hierarchy needs to surface these
 * relationships so the user can find related parts together.
 *
 * Heuristics live here rather than in the backend so we can iterate without
 * a Rust restart.
 */

export type GltfCategory =
  | "fp"        // first-person model (hands, viewmodel)
  | "head"      // head / face / skull
  | "body"      // body / torso
  | "weapon"    // weapon / gun / rifle / etc.
  | "vehicle"   // ship / car / drone
  | "prop"      // crate / barrel / debris
  | "other";    // anything else

const CATEGORY_LABEL: Record<GltfCategory, string> = {
  fp: "FP",
  head: "Head",
  body: "Body",
  weapon: "Weapon",
  vehicle: "Vehicle",
  prop: "Prop",
  other: "Other",
};

const CATEGORY_COLOR: Record<GltfCategory, string> = {
  fp: "hsl(280, 70%, 70%)",       // purple — FPS-only
  head: "hsl(15, 80%, 65%)",      // orange-red
  body: "hsl(202, 80%, 65%)",     // blue
  weapon: "hsl(43, 90%, 60%)",    // yellow
  vehicle: "hsl(151, 60%, 60%)",  // green
  prop: "hsl(0, 0%, 60%)",        // gray
  other: "hsl(0, 0%, 50%)",       // dim gray
};

/** What to display next to a row. */
export function categoryLabel(c: GltfCategory): string {
  return CATEGORY_LABEL[c];
}

export function categoryColor(c: GltfCategory): string {
  return CATEGORY_COLOR[c];
}

/**
 * Classify a GLTF filename. Order matters — first-person check must run
 * before "hand" matching since FP models are usually called something
 * like `firstperson_hands.gltf`.
 */
export function classifyGltf(filename: string): GltfCategory {
  const lower = filename.toLowerCase();

  // First-person view models — usually a hands+arms rig used in FPS view.
  if (
    /(^|[_./-])(fp|firstperson|first_person|first-person|viewmodel|view_model)([_./-]|$)/.test(lower) ||
    lower.startsWith("fp_") ||
    lower.includes("first_person")
  ) {
    return "fp";
  }

  // Heads / faces / skulls.
  if (/(^|[_./-])(head|face|skull|helmet|mask)([_./-]|$)/.test(lower)) {
    return "head";
  }

  // Weapons.
  if (
    /(^|[_./-])(weapon|gun|rifle|pistol|launcher|carbine|shotgun|smg|sniper|grenade|bomb)([_./-]|$)/.test(lower) ||
    lower.startsWith("wpn_") ||
    lower.startsWith("weap_")
  ) {
    return "weapon";
  }

  // Vehicles.
  if (
    /(^|[_./-])(vehicle|ship|car|drone|tank|jeep|bike)([_./-]|$)/.test(lower)
  ) {
    return "vehicle";
  }

  // Common props (when filename is suggestive).
  if (
    /(^|[_./-])(crate|barrel|debris|prop|box|chair|table|lamp|sign)([_./-]|$)/.test(lower)
  ) {
    return "prop";
  }

  // Bodies / torsos — checked last because "body" is generic and we'd
  // rather a more-specific category win.
  if (/(^|[_./-])(body|torso|chest)([_./-]|$)/.test(lower)) {
    return "body";
  }

  return "other";
}

/**
 * Best-guess "character name" prefix used to group related parts. Strips
 * the file extension and known part suffixes (body/head/etc.). Two files
 * with the same prefix are likely the same character.
 *
 * E.g. `chimeran_grunt_body.gltf` + `chimeran_grunt_head.gltf` both yield
 * `chimeran_grunt`. `firstperson_hands.gltf` yields `firstperson_hands`.
 */
export function characterPrefix(filename: string): string {
  const noExt = filename.replace(/\.(gltf|glb)$/i, "");
  // Strip well-known part suffixes one at a time, walking right to left.
  const SUFFIX_RE = /[_./-](body|head|face|skull|helmet|mask|torso|chest|hands?|arms?|legs?|feet|skin|skin\d+|variant\d*|var\d*|v\d+|lod\d+)$/i;
  let stem = noExt;
  // Two passes — handles `_body_lod0` style suffixes too.
  for (let i = 0; i < 2; i++) {
    const replaced = stem.replace(SUFFIX_RE, "");
    if (replaced === stem) break;
    stem = replaced;
  }
  return stem || noExt;
}
