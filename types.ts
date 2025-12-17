
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
  FLOATING = 'Floating Islands'
}

export enum TerrainElement {
  DIFFICULT = 'Difficult',
  FEATURE = 'Feature',
  HUNTING_GROUND = 'Hunting Ground',
  RESOURCE = 'Resource',
  SECRET = 'Secret',
  STANDARD = 'Standard'
}

export enum PlanarAlignment {
  MATERIAL = 'Material', // Default/Center
  FIRE = 'Plane of Fire',
  WATER = 'Plane of Water',
  AIR = 'Plane of Air',
  EARTH = 'Plane of Earth',
  POSITIVE = 'Positive Energy',
  NEGATIVE = 'Negative Energy',
  SCAR = 'The World Scar'
}

export type PartySpeed = 15 | 20 | 30 | 40 | 50;

export interface PlanarOverlay {
  id: string;
  type: PlanarAlignment;
  coordinates: { x: number, y: number }; // Hex Coordinates (q, r)
  radius: number; // In Hexes
}

export interface PlanarInfluence {
  type: PlanarAlignment;
  intensity: number; // 0.0 to 1.0
}

export interface HexData {
  id: string;
  groupId?: string; 
  
  // Current State (Visible)
  terrain: TerrainType;
  element: TerrainElement;
  description?: string; 
  travelTimeHours: number;
  explorationTimeDays: number;
  coordinates: { x: number, y: number };
  isExplored: boolean;
  notes: string;
  color?: string; 
  icon?: string; 
  isSectorPlaceholder?: boolean; 
  
  // Base State (For reverting Planar Mutations)
  baseTerrain: TerrainType;
  baseDescription: string;

  // Planar Data
  planarAlignment?: PlanarAlignment; // Dominant alignment for Logic/Text
  planarIntensity?: number; 
  planarInfluences?: PlanarInfluence[]; // All active influences for Visual Blending
}

export interface TravelRuleResult {
  travelTime: number; // hours
  explorationTime: number; // days
}

export interface WorldGenConfig {
  waterLevel: number; 
  mountainLevel: number; 
  vegetationLevel: number; 
  riverDensity: number; 
  ruggedness: number; 
  seed: number;
}
