// Types
export type {
  HexData,
  PlanarOverlay,
  PlanarInfluence,
  WorldGenConfig,
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
export { WORLD, DEFAULT_WORLD_CONFIG, BIOME, NOISE, RENDER } from './config';

// World generation
export { generateWorld, revealSector, revealAll, regenerateUnexplored } from './world';

// Planar system
export { computeHexState, applyOverlaysToMap, mutateTerrainByPlane } from './planar';

// Geometry (public surface — hex<->pixel conversions and distance)
export { hexToPixel, pixelToHex, getHexDistance, hexLine } from './geometry';
