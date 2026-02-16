// Types
export type {
  HexData,
  PlanarOverlay,
  PlanarInfluence,
  WorldGenConfig,
  WorldState,
  HistoryAction,
  MutationRule,
  AxialCoord,
  PixelCoord,
} from './types';

export {
  TerrainType,
  TerrainElement,
  PlanarAlignment,
} from './types';

// Config
export { WORLD, DEFAULT_WORLD_CONFIG, TERRAIN, BIOME, NOISE, RENDER, MESH } from './config';

// Continuous terrain field
export { sampleTerrain } from './terrain';
export type { TerrainSample } from './terrain';

// World generation
export { generateWorld, revealSector, revealAll, regenerateUnexplored, regenerateTerrain } from './world';

// Planar system
export { computeHexState, applyOverlaysToMap, mutateTerrainByPlane } from './planar';

// History engine
export { applyAction, replayFrom, getActionLabel, EMPTY_STATE } from './history';

// Geometry (public surface — hex<->pixel conversions and distance)
export { hexToPixel, pixelToHex, getHexDistance, hexLine } from './geometry';
