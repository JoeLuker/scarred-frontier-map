// Types
export type {
  HexData,
  PlanarOverlay,
  PlanarInfluence,
  WorldGenConfig,
  WorldState,
  HistoryAction,
  ChemistryRule,
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
export { computeHexState, applyOverlaysToMap, resolveChemistry } from './planar';

// History engine
export { applyAction, replayFrom, getActionLabel, EMPTY_STATE } from './history';

// World engine (pure state machine — no React, no GPU)
export { WorldEngine } from './engine';

// Geometry (public surface — hex<->pixel conversions and distance)
export { hexToPixel, pixelToHex, getHexDistance, hexLine } from './geometry';
