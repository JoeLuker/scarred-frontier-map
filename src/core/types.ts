export enum TerrainType {
  FOREST = 'Forest',
  HILL = 'Hill',
  MARSH = 'Marsh',
  MOUNTAIN = 'Mountain',
  PLAIN = 'Plain',
  SETTLEMENT = 'Settlement',
  WATER = 'Water',
  DESERT = 'Desert',
  EMPTY = 'Unexplored',

  // Mutation Only Types
  MAGMA = 'Magma Fields',
  CRYSTAL = 'Crystal Spires',
  FLOATING = 'Floating Islands',
}

export enum TerrainElement {
  DIFFICULT = 'Difficult',
  FEATURE = 'Feature',
  HUNTING_GROUND = 'Hunting Ground',
  RESOURCE = 'Resource',
  SECRET = 'Secret',
  STANDARD = 'Standard',
}

export enum PlanarAlignment {
  MATERIAL = 'Material',
  FIRE = 'Plane of Fire',
  WATER = 'Plane of Water',
  AIR = 'Plane of Air',
  EARTH = 'Plane of Earth',
  POSITIVE = 'Positive Energy',
  NEGATIVE = 'Negative Energy',
  SCAR = 'The World Scar',
}

export interface AxialCoord {
  readonly q: number;
  readonly r: number;
}

export interface PixelCoord {
  readonly x: number;
  readonly y: number;
}

export interface PlanarOverlay {
  readonly id: string;
  readonly type: PlanarAlignment;
  coordinates: AxialCoord;
  radius: number;
}

export interface PlanarInfluence {
  readonly type: PlanarAlignment;
  readonly intensity: number;
}

export interface HexData {
  readonly id: string;
  readonly groupId: string;

  // Current State (Visible)
  terrain: TerrainType;
  element: TerrainElement;
  description: string;
  coordinates: AxialCoord;
  isExplored: boolean;
  notes: string;

  // Terrain elevation (0-1 continuous value from noise)
  elevation: number;

  // Base State (For reverting Planar Mutations)
  readonly baseTerrain: TerrainType;
  readonly baseDescription: string;

  // Planar Data
  planarAlignment: PlanarAlignment;
  planarIntensity: number;
  planarInfluences: PlanarInfluence[];
}

export interface WorldGenConfig {
  readonly waterLevel: number;
  readonly mountainLevel: number;
  readonly vegetationLevel: number;
  readonly riverDensity: number;
  readonly ruggedness: number;
  readonly seed: number;
}

export interface MutationRule {
  readonly targetTerrain?: TerrainType | undefined;
  readonly flavorPrimary: string;
  readonly flavorSecondary: string;
}

// --- Action-based history ---

export interface WorldState {
  readonly hexes: HexData[];
  readonly overlays: PlanarOverlay[];
  readonly config: WorldGenConfig;
}

export type HistoryAction =
  | { readonly type: 'generateWorld'; readonly config: WorldGenConfig }
  | { readonly type: 'worldConfig'; readonly config: WorldGenConfig; readonly preserveExplored: boolean }
  | { readonly type: 'revealSector'; readonly groupId: string }
  | { readonly type: 'revealAll' }
  | { readonly type: 'updateHex'; readonly hexId: string; readonly changes: Partial<HexData> }
  | { readonly type: 'addOverlay'; readonly overlay: PlanarOverlay }
  | { readonly type: 'removeOverlay'; readonly overlayId: string }
  | { readonly type: 'modifyOverlay'; readonly overlay: PlanarOverlay }
  | { readonly type: 'importMap'; readonly hexes: HexData[] }
