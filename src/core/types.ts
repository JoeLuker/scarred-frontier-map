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
  intensity: number;  // 0-1, scales max per-hex intensity
  falloff: number;    // exponent for distance curve (0.5=gradual, 6=sharp)
  fragmentation: number; // 0-1, controls island chunk noise frequency (Air only)
  lift: number;          // 0-1, controls how high floating islands rise (Air only)
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
  notes: string;

  // Terrain elevation (0-1 continuous value from noise)
  elevation: number;

  // Base State (For reverting Planar Mutations)
  readonly baseTerrain: TerrainType;
  readonly baseDescription: string;

  // Planar Data
  planarAlignment: PlanarAlignment;
  planarIntensity: number;
  planarFragmentation: number;  // 0-1, chunk noise frequency from dominant overlay
  planarLift: number;           // 0-1, island lift height from dominant overlay
  planarInfluences: PlanarInfluence[];
  reactionEmission: PlanarAlignment | null;
}

export interface WorldGenConfig {
  readonly waterLevel: number;
  readonly mountainLevel: number;
  readonly vegetationLevel: number;
  readonly riverDensity: number;
  readonly ruggedness: number;
  readonly seed: number;
  readonly continentScale: number;
  readonly temperature: number;
  readonly ridgeSharpness: number;
  readonly plateauFactor: number;
  readonly coastComplexity: number;
  readonly erosion: number;
  readonly valleyDepth: number;
  readonly chaos: number;
  readonly verticality: number;
}

export interface ChemistryRule {
  // Conditions — all specified must be met for rule to match
  readonly terrain?: TerrainType | undefined;            // hex terrain (omit = any terrain)
  readonly planes: readonly PlanarAlignment[];           // all must be present
  readonly minIntensity?: number | undefined;            // threshold (default 0.1)

  // Results
  readonly outputTerrain?: TerrainType | undefined;      // new terrain (omit = keep current)
  readonly flavorPrimary: string;                        // high-intensity description
  readonly flavorSecondary: string;                      // low-intensity description
  readonly emit?: PlanarAlignment | undefined;           // virtual emission
}

// --- Action-based history ---

export interface WorldState {
  readonly hexes: HexData[];
  readonly overlays: PlanarOverlay[];
  readonly config: WorldGenConfig;
}

export type HistoryAction =
  | { readonly type: 'generateWorld'; readonly config: WorldGenConfig }
  | { readonly type: 'worldConfig'; readonly config: WorldGenConfig }
  | { readonly type: 'updateHex'; readonly hexId: string; readonly changes: Partial<HexData> }
  | { readonly type: 'addOverlay'; readonly overlay: PlanarOverlay }
  | { readonly type: 'removeOverlay'; readonly overlayId: string }
  | { readonly type: 'modifyOverlay'; readonly overlay: PlanarOverlay }
  | { readonly type: 'importMap'; readonly hexes: HexData[] }
