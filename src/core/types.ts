// Domain enums — shared across ECS, GPU, and UI layers

export enum TerrainType {
  WATER = 0,
  DESERT = 1,
  PLAIN = 2,
  FOREST = 3,
  MARSH = 4,
  HILL = 5,
  MOUNTAIN = 6,
  SETTLEMENT = 7,
  MAGMA = 8,
  CRYSTAL = 9,
  FLOATING = 10,
}

export enum TerrainElement {
  STANDARD = 0,
  DIFFICULT = 1,
  FEATURE = 2,
  HUNTING_GROUND = 3,
  RESOURCE = 4,
  SECRET = 5,
}

export enum PlanarAlignment {
  MATERIAL = 0,
  FIRE = 1,
  WATER = 2,
  EARTH = 3,
  AIR = 4,
  POSITIVE = 5,
  NEGATIVE = 6,
  SCAR = 7,
}

export enum SubstanceType {
  NONE = 0,
  WATER = 1,
  FIRE = 2,
  LAVA = 3,
  STEAM = 4,
}

export interface AxialCoord {
  readonly q: number;
  readonly r: number;
}

export interface PixelCoord {
  readonly x: number;
  readonly y: number;
}

// --- Terrain Generation ---

export interface TerrainResult {
  readonly terrain: TerrainType;
  readonly element: TerrainElement;
  readonly elevation: number;
  readonly description: string;
  readonly hasRiver: boolean;
}

export interface TerrainProvider {
  setCoords(coords: ReadonlyArray<AxialCoord>): void;
  generate(config: WorldGenConfig, hexCount: number, forceNoRiver?: boolean): Promise<TerrainResult[]>;
  destroy(): void;
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
