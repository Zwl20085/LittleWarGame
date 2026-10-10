import type * as THREE from 'three';
import { BUNKER_SIZE, getStructureParts, PILLBOX_SIZE } from './models';

/**
 * Structure kinds → mesh parts (2.2 hook). Every built structure on the map — the 2.0
 * pillboxes and bunkers today, and the economic buildings (factory, recruitment office, depot)
 * and town supply depots the economy wave adds — is drawn by StructureViews from a kind
 * definition registered here: a handful of part geometries shared by every instance of the kind
 * (one InstancedMesh per kind and part), plus the dimensions the construction / damage / ruin
 * stages need. Adding a kind is one `registerStructureKind` call with its parts; feeding the
 * records is `GameRenderer.structureSources`.
 *
 * Local frame of every part: +x toward the structure's facing (the sim's `facing`), y up from
 * the ground, metres. Parts are vertex-coloured; the instance colour multiplies them (damage
 * darkening), except `flag`, which is tinted toward the owner colour.
 */
export interface StructureKindDef {
  /** Walls / main volume at unit height (scaled by construction progress up to `height`). */
  readonly body: THREE.BufferGeometry;
  /** Roof, placed on top of the body once construction reaches the roof stage (optional). */
  readonly roof?: THREE.BufferGeometry;
  /** Skirt / berm / yard dressing shown when complete (optional). */
  readonly skirt?: THREE.BufferGeometry;
  /** Wall height (m) when complete. */
  readonly height: number;
  /** Footprint (m): along the facing (x) and across it (z). Sizes the footing and the rubble. */
  readonly footprint: { readonly x: number; readonly z: number };
  /** Owner pennant: distance behind the centre and height above the ground (null = none). */
  readonly flag: { readonly back: number; readonly top: number } | null;
}

const REGISTRY = new Map<string, StructureKindDef>();

export function registerStructureKind(kind: string, def: StructureKindDef): void {
  REGISTRY.set(kind, def);
}

/** The definition of a kind (registering the built-in kinds on first use), or undefined. */
export function structureKind(kind: string): StructureKindDef | undefined {
  ensureBuiltins();
  return REGISTRY.get(kind);
}

/** Construction footing and ruin rubble shared by every kind (unit footprint, scaled). */
export function sharedStructureParts(): { readonly footing: THREE.BufferGeometry; readonly rubble: THREE.BufferGeometry } {
  const p = getStructureParts();
  return { footing: p.footing, rubble: p.rubble };
}

let builtins = false;
function ensureBuiltins(): void {
  if (builtins) return;
  builtins = true;
  const p = getStructureParts();
  registerStructureKind('pillbox', {
    body: p.pbBody, roof: p.pbRoof, skirt: p.pbSkirt, height: PILLBOX_SIZE.h,
    footprint: { x: PILLBOX_SIZE.r * 2, z: PILLBOX_SIZE.r * 2 },
    flag: { back: PILLBOX_SIZE.r * 0.6, top: PILLBOX_SIZE.h + 0.3 },
  });
  registerStructureKind('bunker', {
    body: p.bkBody, roof: p.bkRoof, skirt: p.bkBerm, height: BUNKER_SIZE.h,
    footprint: { x: BUNKER_SIZE.d, z: BUNKER_SIZE.w },
    flag: { back: BUNKER_SIZE.d * 0.4, top: BUNKER_SIZE.h + 0.4 },
  });
}
