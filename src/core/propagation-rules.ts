import { HexGraph } from './graph';
import { SubstanceType, TerrainMutation, TerrainType } from './types';

// --- Terrain ID constants (matching gpu/types.ts TERRAIN_ORDER) ---

const TERRAIN_WATER = 0;
const TERRAIN_DESERT = 1;
const TERRAIN_PLAIN = 2;
const TERRAIN_FOREST = 3;
const TERRAIN_MARSH = 4;
const TERRAIN_MOUNTAIN = 6;
const TERRAIN_MAGMA = 8;

// --- Rule Context ---

export interface PropagationContext {
  hexIndex: number;                    // mutable — set per hex in the hot loop
  readonly graph: HexGraph;
  readonly readLevels: Float32Array;
  readonly readTypes: Uint8Array;
  readonly writeLevels: Float32Array;
  readonly writeTypes: Uint8Array;
  readonly elevations: Float32Array;
  readonly terrainTypes: Uint8Array;
  readonly sources: Uint8Array;
  readonly sourceLevel: Float32Array;
  readonly dt: number;                 // seconds per tick
  readonly mutations: TerrainMutation[];
}

export interface PropagationRule {
  readonly type: SubstanceType;
  tick(ctx: PropagationContext): number[];  // returns newly activated neighbor indices
}

// --- Water Rule ---
// Flows downhill. Pools in depressions. Blocked by mountains. Slowed by forest.

const WATER_FLOW_RATE = 0.15;        // max transfer per tick
const WATER_EQUALIZE_RATE = 0.03;    // rate of leveling in flat areas
const WATER_EVAPORATION = 0.002;     // natural loss per tick (non-source hexes)
const WATER_DESERT_ABSORPTION = 0.01;

export const WaterRule: PropagationRule = {
  type: SubstanceType.WATER,

  tick(ctx: PropagationContext): number[] {
    const i = ctx.hexIndex;
    const myLevel = ctx.readLevels[i]!;
    const myElev = ctx.elevations[i]!;
    const myTerrain = ctx.terrainTypes[i]!;

    if (myLevel < 0.005) return [];

    const activated: number[] = [];
    const nb = ctx.graph.getNeighbors(i);
    let totalOutflow = 0;

    for (let d = 0; d < 6; d++) {
      const ni = nb[d]!;
      if (ni === -1) continue;

      const nTerrain = ctx.terrainTypes[ni]!;

      // Mountains block water
      if (nTerrain === TERRAIN_MOUNTAIN) continue;

      const nElev = ctx.elevations[ni]!;
      const nLevel = ctx.readLevels[ni]!;

      // Effective height = elevation + current fluid level
      const myEffective = myElev + myLevel;
      const nEffective = nElev + nLevel;

      // Only flow to lower effective height
      const diff = myEffective - nEffective;
      if (diff <= 0) continue;

      // Flow rate proportional to height difference
      let transfer = Math.min(diff * WATER_FLOW_RATE, myLevel * 0.15);

      // Forest slows flow
      if (nTerrain === TERRAIN_FOREST || nTerrain === TERRAIN_MARSH) {
        transfer *= 0.5;
      }

      // Cap total outflow to available level
      if (totalOutflow + transfer > myLevel * 0.6) {
        transfer = Math.max(0, myLevel * 0.6 - totalOutflow);
      }
      totalOutflow += transfer;

      if (transfer > 0.001) {
        ctx.writeLevels[ni] = Math.min(1.0, (ctx.writeLevels[ni] ?? 0) + transfer);
        ctx.writeTypes[ni] = SubstanceType.WATER;
        activated.push(ni);
      }
    }

    // Remove outflow from source
    ctx.writeLevels[i] = Math.max(0, (ctx.writeLevels[i] ?? 0) - totalOutflow);

    // Flat-area equalization: if neighbors at similar elevation, share fluid
    if (totalOutflow < 0.001) {
      for (let d = 0; d < 6; d++) {
        const ni = nb[d]!;
        if (ni === -1) continue;
        if (ctx.terrainTypes[ni]! === TERRAIN_MOUNTAIN) continue;

        const nLevel = ctx.readLevels[ni]!;
        const elevDiff = Math.abs(ctx.elevations[ni]! - myElev);

        // Only equalize on relatively flat terrain
        if (elevDiff < 0.05 && myLevel > nLevel + 0.01) {
          const share = (myLevel - nLevel) * WATER_EQUALIZE_RATE;
          ctx.writeLevels[ni] = Math.min(1.0, (ctx.writeLevels[ni] ?? 0) + share);
          ctx.writeLevels[i] = Math.max(0, (ctx.writeLevels[i] ?? 0) - share);
          ctx.writeTypes[ni] = SubstanceType.WATER;
          activated.push(ni);
        }
      }
    }

    // Evaporation for non-source hexes
    if (ctx.sources[i] === SubstanceType.NONE) {
      const evap = myTerrain === TERRAIN_DESERT ? WATER_DESERT_ABSORPTION : WATER_EVAPORATION;
      ctx.writeLevels[i] = Math.max(0, (ctx.writeLevels[i] ?? 0) - evap);
    }

    return activated;
  },
};

// --- Fire Rule ---
// Spreads laterally through flammable terrain. Burns forests. Dies on water/mountain.

const FIRE_SPREAD_RATE = 0.08;
const FIRE_BURN_THRESHOLD = 0.4;   // level at which terrain mutation occurs
const FIRE_DECAY = 0.015;          // natural decay per tick

export const FireRule: PropagationRule = {
  type: SubstanceType.FIRE,

  tick(ctx: PropagationContext): number[] {
    const i = ctx.hexIndex;
    const myLevel = ctx.readLevels[i]!;
    const myTerrain = ctx.terrainTypes[i]!;

    if (myLevel < 0.005) return [];

    // Fire dies on water and mountain
    if (myTerrain === TERRAIN_WATER || myTerrain === TERRAIN_MOUNTAIN) {
      ctx.writeLevels[i] = 0;
      ctx.writeTypes[i] = SubstanceType.NONE;
      return [];
    }

    // Terrain mutation: fire burns forest/marsh to desert
    if (myLevel > FIRE_BURN_THRESHOLD) {
      if (myTerrain === TERRAIN_FOREST || myTerrain === TERRAIN_MARSH) {
        ctx.mutations.push({
          hexIndex: i,
          newTerrain: 'Desert' as any,
          newDescription: 'Scorched Earth',
        });
        ctx.terrainTypes[i] = TERRAIN_DESERT;
      }
    }

    const activated: number[] = [];
    const nb = ctx.graph.getNeighbors(i);

    for (let d = 0; d < 6; d++) {
      const ni = nb[d]!;
      if (ni === -1) continue;

      const nTerrain = ctx.terrainTypes[ni]!;

      // Fire can't spread to water or mountain
      if (nTerrain === TERRAIN_WATER || nTerrain === TERRAIN_MOUNTAIN) continue;

      const nLevel = ctx.readLevels[ni]!;

      // Spread if neighbor has less fire
      if (myLevel > nLevel + 0.05) {
        // Flammable terrain spreads faster
        let rate = FIRE_SPREAD_RATE;
        if (nTerrain === TERRAIN_FOREST) rate *= 2.0;
        if (nTerrain === TERRAIN_MARSH) rate *= 1.5;
        if (nTerrain === TERRAIN_DESERT) rate *= 0.3;

        const transfer = Math.min(rate, myLevel * 0.1);
        ctx.writeLevels[ni] = Math.min(1.0, (ctx.writeLevels[ni] ?? 0) + transfer);
        ctx.writeTypes[ni] = SubstanceType.FIRE;
        activated.push(ni);
      }
    }

    // Natural decay for non-source hexes
    if (ctx.sources[i] === SubstanceType.NONE) {
      ctx.writeLevels[i] = Math.max(0, (ctx.writeLevels[i] ?? 0) - FIRE_DECAY);
      // Fire burns out completely when very low
      if (ctx.writeLevels[i]! < 0.01) {
        ctx.writeTypes[i] = SubstanceType.NONE;
      }
    }

    return activated;
  },
};

// --- Lava Rule ---
// Flows downhill (slow). Converts water hexes to mountain (obsidian).

const LAVA_FLOW_RATE = 0.04;        // much slower than water
const LAVA_COOLING = 0.003;

export const LavaRule: PropagationRule = {
  type: SubstanceType.LAVA,

  tick(ctx: PropagationContext): number[] {
    const i = ctx.hexIndex;
    const myLevel = ctx.readLevels[i]!;
    const myElev = ctx.elevations[i]!;

    if (myLevel < 0.005) return [];

    const activated: number[] = [];
    const nb = ctx.graph.getNeighbors(i);

    for (let d = 0; d < 6; d++) {
      const ni = nb[d]!;
      if (ni === -1) continue;

      const nElev = ctx.elevations[ni]!;
      const nLevel = ctx.readLevels[ni]!;
      const nTerrain = ctx.terrainTypes[ni]!;

      // Lava meeting water → obsidian (mountain)
      if (nTerrain === TERRAIN_WATER && myLevel > 0.1) {
        ctx.mutations.push({
          hexIndex: ni,
          newTerrain: 'Mountain' as any,
          newDescription: 'Obsidian Field',
        });
        ctx.terrainTypes[ni] = TERRAIN_MOUNTAIN;
        ctx.writeLevels[i] = Math.max(0, (ctx.writeLevels[i] ?? 0) - 0.05);
        continue;
      }

      // Mountains block lava
      if (nTerrain === TERRAIN_MOUNTAIN) continue;

      const myEffective = myElev + myLevel;
      const nEffective = nElev + nLevel;
      const diff = myEffective - nEffective;

      if (diff <= 0) continue;

      const transfer = Math.min(diff * LAVA_FLOW_RATE, myLevel * 0.1);
      if (transfer > 0.001) {
        ctx.writeLevels[ni] = Math.min(1.0, (ctx.writeLevels[ni] ?? 0) + transfer);
        ctx.writeTypes[ni] = SubstanceType.LAVA;
        activated.push(ni);

        ctx.writeLevels[i] = Math.max(0, (ctx.writeLevels[i] ?? 0) - transfer);

        // Lava burns forest/marsh
        if (nTerrain === TERRAIN_FOREST || nTerrain === TERRAIN_MARSH) {
          ctx.mutations.push({
            hexIndex: ni,
            newTerrain: 'Desert' as any,
            newDescription: 'Scorched Earth',
          });
          ctx.terrainTypes[ni] = TERRAIN_DESERT;
        }
      }
    }

    // Cooling for non-source hexes
    if (ctx.sources[i] === SubstanceType.NONE) {
      ctx.writeLevels[i] = Math.max(0, (ctx.writeLevels[i] ?? 0) - LAVA_COOLING);
      if (ctx.writeLevels[i]! < 0.01) {
        ctx.writeTypes[i] = SubstanceType.NONE;
      }
    }

    return activated;
  },
};

// --- Fluid-to-Terrain Feedback ---

export function getFluidTerrainEffect(
  baseTerrain: number,
  fluidLevel: number,
  fluidType: SubstanceType,
): { terrain: TerrainType; terrainId: number; description: string } | null {
  if (fluidType === SubstanceType.WATER) {
    if (baseTerrain === TERRAIN_PLAIN && fluidLevel > 0.5) {
      return { terrain: TerrainType.MARSH, terrainId: TERRAIN_MARSH, description: 'Waterlogged Plains' };
    }
    if (baseTerrain === TERRAIN_DESERT && fluidLevel > 0.7) {
      return { terrain: TerrainType.WATER, terrainId: TERRAIN_WATER, description: 'Flooded Basin' };
    }
    if (baseTerrain === TERRAIN_FOREST && fluidLevel > 0.3) {
      return { terrain: TerrainType.MARSH, terrainId: TERRAIN_MARSH, description: 'Sodden Woods' };
    }
  }

  if (fluidType === SubstanceType.FIRE) {
    if ((baseTerrain === TERRAIN_FOREST || baseTerrain === TERRAIN_MARSH) && fluidLevel > 0.4) {
      return { terrain: TerrainType.DESERT, terrainId: TERRAIN_DESERT, description: 'Scorched Earth' };
    }
  }

  if (fluidType === SubstanceType.LAVA) {
    if (baseTerrain !== TERRAIN_MOUNTAIN && baseTerrain !== TERRAIN_MAGMA && fluidLevel > 0.3) {
      return { terrain: TerrainType.MAGMA, terrainId: TERRAIN_MAGMA, description: 'Lava Field' };
    }
  }

  return null;
}
