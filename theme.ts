
import { TerrainType, PlanarAlignment } from './types';
import { MAP_CONFIG } from './constants';

// Derived Visual Config
export const VISUAL_CONFIG = {
  SECTOR_SCALE: MAP_CONFIG.SECTOR_SIZE * Math.sqrt(3),
  PLACEHOLDER_PAD: 0.85 
};

export const TERRAIN_COLORS: Record<TerrainType, string> = {
  [TerrainType.FOREST]: '#166534', // Bamboo/Pine Green
  [TerrainType.HILL]: '#9a3412',   // Red Rock / Mesa Orange
  [TerrainType.MARSH]: '#57534e',  // Stone Grey/Brown
  [TerrainType.MOUNTAIN]: '#334155', // Dark Slate (Karst)
  [TerrainType.PLAIN]: '#ca8a04',  // Dried Wheat / Gold
  [TerrainType.SETTLEMENT]: '#be123c', // Lacquer Red
  [TerrainType.WATER]: '#0d9488',  // Jade/Turquoise Water
  [TerrainType.DESERT]: '#c2410c',  // Rust / Sandstone
  [TerrainType.EMPTY]: '#020617',    // Void
  
  // New Types - Brightened for standalone visibility
  [TerrainType.MAGMA]: '#b91c1c',    // Bright Lava Red
  [TerrainType.CRYSTAL]: '#6366f1',  // Electric Indigo
  [TerrainType.FLOATING]: '#38bdf8'  // Vivid Sky Blue
};

export const PLANAR_COLORS: Record<PlanarAlignment, string> = {
  [PlanarAlignment.MATERIAL]: '#64748b', // Slate (Neutral)
  [PlanarAlignment.FIRE]: '#ef4444',     // Red
  [PlanarAlignment.WATER]: '#06b6d4',    // Cyan
  [PlanarAlignment.AIR]: '#a5f3fc',      // Pale Sky
  [PlanarAlignment.EARTH]: '#78350f',    // Brown
  [PlanarAlignment.POSITIVE]: '#facc15', // Gold
  [PlanarAlignment.NEGATIVE]: '#581c87', // Dark Purple
  [PlanarAlignment.SCAR]: '#be185d'      // Pink/Magenta Chaos
};

// SVG Path Data (ViewBox 0 0 24 24)
export const TERRAIN_PATHS: Record<TerrainType, string> = {
  [TerrainType.FOREST]: "M10 10c0-5 3-8 3-8s3 3 3 8c0 .5 0 1.5-.5 2v3h-5v-3c-.5-.5-.5-1.5-.5-2Z M7 12c0-4 2.5-6 2.5-6S12 8 12 12c0 .5 0 1-.5 1.5v1.5H9.5v-1.5c-.5-.5-.5-1-.5-1.5Z", 
  [TerrainType.HILL]: "M4.5 18C4.5 13.5 8 10.5 10 10.5c1 0 2 1 2 3M11 18c0-5.5 3.5-8.5 6.5-8.5 2.5 0 4.5 3 4.5 8.5", 
  [TerrainType.MARSH]: "M2 16c1.5-2 3-2 4.5 0s3 2 4.5 0s3-2 4.5 0s3 2 4.5 0 M6 12c0-3 2-4 2-4s2 1 2 4 M16 12c0-2.5 1.5-3.5 1.5-3.5s1.5 1 1.5 3.5", 
  [TerrainType.MOUNTAIN]: "M8 3l-4 18h16l-4-18l-4 8z M10 14l-2 7 M14 14l2 7", 
  [TerrainType.PLAIN]: "M3 18h18 M5 14h8 M15 14h2 M8 10h4", 
  [TerrainType.SETTLEMENT]: "M3 21h18v-8l-9-7-9 7v8zm5-8h8v8H8v-8z", 
  [TerrainType.WATER]: "M2 12c2-3 5-3 7 0 2 3 5 3 7 0 2-3 5-3 7 0v-6z", 
  [TerrainType.DESERT]: "M12 2v2 M12 20v2 M2 12h2 M20 12h2 M5 5l1.5 1.5 M17.5 17.5L19 19 M5 19l1.5-1.5 M17.5 6.5L19 5", 
  [TerrainType.EMPTY]: "M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm0 18a8 8 0 1 1 8-8 8 8 0 0 1-8 8z M12 6v6l4 2",
  
  // New Icons
  // Magma: Cracks and fissure
  [TerrainType.MAGMA]: "M12 2L9 9l-7 3 7 3 3 7 3-7 7-3-7-3z M12 8v8 M8 12h8",
  // Crystal: Sharp shards
  [TerrainType.CRYSTAL]: "M12 2L8 8l4 14 4-14z M6 14l4-2 2 10z M18 14l-4-2-2 10z",
  // Floating: Cloud + Island
  [TerrainType.FLOATING]: "M4 16c0-2.5 2-4.5 4.5-4.5.5 0 1 .1 1.5.3C10.5 9.5 12.5 8 15 8c3 0 5.5 2.5 5.5 5.5 0 .5-.1 1-.2 1.5H20c0 3-2.5 5-5 5H9c-2.5 0-5-2-5-5z"
};
