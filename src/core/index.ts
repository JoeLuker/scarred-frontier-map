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

// World generation (geometry only — terrain sampling is GPU)
export { generateWorldGrid, mergeTerrain } from './world';

// Planar system
export { computeHexState, applyOverlaysToMap, resolveChemistry } from './planar';

// History engine
export { applyAction, getActionLabel, EMPTY_STATE } from './history';

// World engine (async state machine — requires TerrainProvider)
export { WorldEngine } from './engine';
export type { TerrainProvider, TerrainResult } from './engine';

// Geometry (public surface — hex<->pixel conversions and distance)
export { hexToPixel, pixelToHex, getHexDistance, hexLine } from './geometry';
