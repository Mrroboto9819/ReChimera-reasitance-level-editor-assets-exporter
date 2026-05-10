











export type GltfCategory =
  | "fp"        
  | "head"      
  | "body"      
  | "weapon"    
  | "vehicle"   
  | "prop"      
  | "other";    

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
  fp: "hsl(280, 70%, 70%)",       
  head: "hsl(15, 80%, 65%)",      
  body: "hsl(202, 80%, 65%)",     
  weapon: "hsl(43, 90%, 60%)",    
  vehicle: "hsl(151, 60%, 60%)",  
  prop: "hsl(0, 0%, 60%)",        
  other: "hsl(0, 0%, 50%)",       
};


export function categoryLabel(c: GltfCategory): string {
  return CATEGORY_LABEL[c];
}

export function categoryColor(c: GltfCategory): string {
  return CATEGORY_COLOR[c];
}






export function classifyGltf(filename: string): GltfCategory {
  const lower = filename.toLowerCase();

  
  if (
    /(^|[_./-])(fp|firstperson|first_person|first-person|viewmodel|view_model)([_./-]|$)/.test(lower) ||
    lower.startsWith("fp_") ||
    lower.includes("first_person")
  ) {
    return "fp";
  }

  
  if (/(^|[_./-])(head|face|skull|helmet|mask)([_./-]|$)/.test(lower)) {
    return "head";
  }

  
  if (
    /(^|[_./-])(weapon|gun|rifle|pistol|launcher|carbine|shotgun|smg|sniper|grenade|bomb)([_./-]|$)/.test(lower) ||
    lower.startsWith("wpn_") ||
    lower.startsWith("weap_")
  ) {
    return "weapon";
  }

  
  if (
    /(^|[_./-])(vehicle|ship|car|drone|tank|jeep|bike)([_./-]|$)/.test(lower)
  ) {
    return "vehicle";
  }

  
  if (
    /(^|[_./-])(crate|barrel|debris|prop|box|chair|table|lamp|sign)([_./-]|$)/.test(lower)
  ) {
    return "prop";
  }

  
  
  if (/(^|[_./-])(body|torso|chest)([_./-]|$)/.test(lower)) {
    return "body";
  }

  return "other";
}









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
