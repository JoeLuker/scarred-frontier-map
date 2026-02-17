import { TerrainType, TerrainElement } from '../core/types';

// --- GPU ↔ CPU terrain ID mappings ---

// Terrain types ordered for GPU lookup (index = shader output)
const TERRAIN_ORDER: readonly TerrainType[] = [
  TerrainType.WATER,
  TerrainType.DESERT,
  TerrainType.PLAIN,
  TerrainType.FOREST,
  TerrainType.MARSH,
  TerrainType.HILL,
  TerrainType.MOUNTAIN,
  TerrainType.SETTLEMENT,
] as const;

const ELEMENT_ORDER: readonly TerrainElement[] = [
  TerrainElement.STANDARD,
  TerrainElement.FEATURE,
  TerrainElement.RESOURCE,
  TerrainElement.DIFFICULT,
  TerrainElement.SECRET,
  TerrainElement.HUNTING_GROUND,
] as const;

// Flavor strings indexed by ID (must match WGSL FLAVOR_* constants)
const FLAVOR_TABLE: readonly string[] = [
  'Deep Ocean',        // 0
  'Shallow Sea',       // 1
  'River',             // 2
  'Bare Peak',         // 3
  'Snow-Capped Peak',  // 4
  'Rocky Bluffs',      // 5
  'Wooded Hills',      // 6
  'Barren Waste',      // 7
  'Arid Scrubland',    // 8
  'Deep Swamp',        // 9
  'Wetland',           // 10
  'Dense Forest',      // 11
  'Light Woodland',    // 12
  'Grassland',         // 13
  'Dry Plains',        // 14
  'Wilderness',        // 15
] as const;

export function terrainFromId(id: number): TerrainType {
  return TERRAIN_ORDER[id] ?? TerrainType.PLAIN;
}

export function elementFromId(id: number): TerrainElement {
  return ELEMENT_ORDER[id] ?? TerrainElement.STANDARD;
}

export function flavorFromId(id: number): string {
  return FLAVOR_TABLE[id] ?? 'Wilderness';
}

// --- GPU context ---

export interface GpuContext {
  readonly adapter: GPUAdapter;
  readonly device: GPUDevice;
}

// --- Mesh vertex data layout for terrain rendering ---
// Each vertex: posX(1) + posZ(1) + elevation(1) + moisture(1) + terrainId(1) + normalXYZ(3) = 8 floats = 32 bytes
export const MESH_VERTEX_STRIDE = 8;
export const MESH_VERTEX_BYTE_STRIDE = MESH_VERTEX_STRIDE * 4;
