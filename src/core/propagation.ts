import { HexData, PlanarOverlay, PlanarAlignment, TerrainType, SubstanceType, TerrainMutation } from './types';
import { HexGraph } from './graph';
import { PLANAR } from './config';
import type { PropagationRule, PropagationContext } from './propagation-rules';
import { getFluidTerrainEffect } from './propagation-rules';

export { SubstanceType, type TerrainMutation };

// --- Propagation Simulator ---

const TICK_INTERVAL = 100; // ms per simulation step (10Hz)
const LEVEL_EPSILON = 0.005;

export class PropagationSimulator {
  private readonly graph: HexGraph;
  private readonly hexCount: number;

  // Double-buffered substance state
  private readonly levels: [Float32Array, Float32Array];
  private readonly types: [Uint8Array, Uint8Array];
  private current: 0 | 1 = 0;

  // Source data (recomputed on overlay/terrain change)
  readonly sources: Uint8Array;       // SubstanceType per hex (0 = not a source)
  readonly sourceLevel: Float32Array; // emission rate per source

  // Cached terrain data for rules
  readonly elevations: Float32Array;
  readonly terrainTypes: Uint8Array;

  // Wavefront tracking
  private activeSet: Set<number>;
  private nextActiveSet: Set<number>;

  // Fixed timestep accumulator
  private accumulator = 0;

  // Output
  dirty = false;
  readonly mutations: TerrainMutation[] = [];

  // Rules
  private rules: Map<SubstanceType, PropagationRule>;

  constructor(
    graph: HexGraph,
    hexes: readonly HexData[],
    overlays: readonly PlanarOverlay[],
    rules: Map<SubstanceType, PropagationRule>,
  ) {
    this.graph = graph;
    this.hexCount = hexes.length;
    this.rules = rules;

    // Allocate buffers
    this.levels = [new Float32Array(this.hexCount), new Float32Array(this.hexCount)];
    this.types = [new Uint8Array(this.hexCount), new Uint8Array(this.hexCount)];
    this.sources = new Uint8Array(this.hexCount);
    this.sourceLevel = new Float32Array(this.hexCount);
    this.elevations = new Float32Array(this.hexCount);
    this.terrainTypes = new Uint8Array(this.hexCount);

    // Cache terrain data — apply gouge depression for ground under floating islands
    const gougeDepth = Math.abs(PLANAR.TORNADO.GOUGE_DEPTH);
    for (let i = 0; i < this.hexCount; i++) {
      const hex = hexes[i]!;
      let elevation = hex.elevation;
      if (hex.planarAlignment === PlanarAlignment.AIR && hex.planarIntensity > 0 && hex.terrain !== TerrainType.FLOATING) {
        elevation -= gougeDepth * hex.planarIntensity;
      }
      this.elevations[i] = elevation;
      this.terrainTypes[i] = terrainToId(hex.terrain);
    }

    // Compute sources from terrain + overlays
    this.activeSet = new Set();
    this.nextActiveSet = new Set();
    this.computeSources(hexes, overlays);
  }

  /** Recompute which hexes are perpetual substance sources. */
  computeSources(hexes: readonly HexData[], overlays: readonly PlanarOverlay[]): void {
    this.sources.fill(0);
    this.sourceLevel.fill(0);

    // Terrain-based sources: coastal water hexes (adjacent to non-water)
    const gougeDepth = Math.abs(PLANAR.TORNADO.GOUGE_DEPTH);
    for (let i = 0; i < this.hexCount; i++) {
      const hex = hexes[i]!;
      this.terrainTypes[i] = terrainToId(hex.terrain);
      let elevation = hex.elevation;
      if (hex.planarAlignment === PlanarAlignment.AIR && hex.planarIntensity > 0 && hex.terrain !== TerrainType.FLOATING) {
        elevation -= gougeDepth * hex.planarIntensity;
      }
      this.elevations[i] = elevation;

      if (hex.terrain === TerrainType.WATER) {
        const nb = this.graph.getNeighbors(i);
        for (let d = 0; d < 6; d++) {
          const ni = nb[d]!;
          if (ni === -1) continue;
          if (hexes[ni]!.terrain !== TerrainType.WATER) {
            this.sources[i] = SubstanceType.WATER;
            this.sourceLevel[i] = 0.8;
            break;
          }
        }
      }

      if (hex.hasRiver) {
        this.sources[i] = SubstanceType.WATER;
        this.sourceLevel[i] = Math.max(this.sourceLevel[i]!, 0.5);
      }

      if (hex.terrain === TerrainType.MAGMA) {
        this.sources[i] = SubstanceType.LAVA;
        this.sourceLevel[i] = 0.9;
      }
    }

    // Overlay-based sources
    for (const overlay of overlays) {
      if (overlay.type === PlanarAlignment.FIRE) {
        this.markOverlaySources(hexes, overlay, SubstanceType.FIRE, 0.7);
      } else if (overlay.type === PlanarAlignment.WATER) {
        this.markOverlaySources(hexes, overlay, SubstanceType.WATER, 0.9);
      }
    }

    // Seed active set from sources + their neighbors
    this.activeSet.clear();
    for (let i = 0; i < this.hexCount; i++) {
      if (this.sources[i] !== SubstanceType.NONE) {
        this.activeSet.add(i);
        // Initialize source levels
        const read = this.levels[this.current]!;
        if (read[i]! < this.sourceLevel[i]!) {
          read[i] = this.sourceLevel[i]!;
          this.types[this.current]![i] = this.sources[i]!;
        }
        const nb = this.graph.getNeighbors(i);
        for (let d = 0; d < 6; d++) {
          if (nb[d]! !== -1) this.activeSet.add(nb[d]!);
        }
      }
    }

    this.dirty = true;
  }

  private markOverlaySources(
    hexes: readonly HexData[],
    overlay: PlanarOverlay,
    substance: SubstanceType,
    level: number,
  ): void {
    const oq = overlay.coordinates.q;
    const or = overlay.coordinates.r;
    const r2 = overlay.radius * overlay.radius;

    for (let i = 0; i < this.hexCount; i++) {
      const hex = hexes[i]!;
      const dq = hex.coordinates.q - oq;
      const dr = hex.coordinates.r - or;
      // Hex distance approximation (exact check via cube coords)
      const dist = (Math.abs(dq) + Math.abs(dq + dr) + Math.abs(dr)) / 2;
      if (dist <= overlay.radius) {
        // Don't override stronger sources
        if (this.sourceLevel[i]! < level) {
          this.sources[i] = substance;
          this.sourceLevel[i] = level * overlay.intensity;
        }
      }
    }
  }

  /** Advance simulation by dtMs milliseconds. Returns true if state changed. */
  tick(dtMs: number): boolean {
    this.accumulator += dtMs;
    let stepped = false;

    while (this.accumulator >= TICK_INTERVAL) {
      this.accumulator -= TICK_INTERVAL;
      if (this.activeSet.size > 0) {
        this.step();
        stepped = true;
      }
    }

    return stepped;
  }

  private step(): void {
    const read = this.current;
    const write: 0 | 1 = read === 0 ? 1 : 0;

    const readLevels = this.levels[read]!;
    const readTypes = this.types[read]!;
    const writeLevels = this.levels[write]!;
    const writeTypes = this.types[write]!;

    // Copy current to next (untouched hexes retain values)
    writeLevels.set(readLevels);
    writeTypes.set(readTypes);

    this.nextActiveSet.clear();

    // Process sources: always emit, always active
    for (let i = 0; i < this.hexCount; i++) {
      if (this.sources[i] === SubstanceType.NONE) continue;
      writeLevels[i] = Math.max(readLevels[i]!, this.sourceLevel[i]!);
      writeTypes[i] = this.sources[i]!;
      this.nextActiveSet.add(i);
      const nb = this.graph.getNeighbors(i);
      for (let d = 0; d < 6; d++) {
        if (nb[d]! !== -1) this.nextActiveSet.add(nb[d]!);
      }
    }

    // Process wavefront
    const ctx: PropagationContext = {
      hexIndex: 0,
      graph: this.graph,
      readLevels,
      readTypes,
      writeLevels,
      writeTypes,
      elevations: this.elevations,
      terrainTypes: this.terrainTypes,
      sources: this.sources,
      sourceLevel: this.sourceLevel,
      dt: TICK_INTERVAL / 1000,
      mutations: this.mutations,
    };

    for (const hexIndex of this.activeSet) {
      const substanceType = readTypes[hexIndex]!;
      if (substanceType === SubstanceType.NONE && this.sources[hexIndex] === SubstanceType.NONE) continue;

      const effectiveType = this.sources[hexIndex] !== SubstanceType.NONE
        ? this.sources[hexIndex]!
        : substanceType;

      const rule = this.rules.get(effectiveType);
      if (!rule) continue;

      ctx.hexIndex = hexIndex;
      const activated = rule.tick(ctx);

      for (const idx of activated) {
        this.nextActiveSet.add(idx);
      }

      // Keep this hex active if it still has fluid
      if (writeLevels[hexIndex]! > LEVEL_EPSILON) {
        this.nextActiveSet.add(hexIndex);
        const nb = this.graph.getNeighbors(hexIndex);
        for (let d = 0; d < 6; d++) {
          if (nb[d]! !== -1) this.nextActiveSet.add(nb[d]!);
        }
      }
    }

    // Fluid-to-terrain feedback: check all active hexes for threshold crossings
    for (const hexIndex of this.nextActiveSet) {
      const level = writeLevels[hexIndex]!;
      if (level < 0.1) continue;
      const substType = writeTypes[hexIndex]! as SubstanceType;
      if (substType === SubstanceType.NONE) continue;

      const effect = getFluidTerrainEffect(this.terrainTypes[hexIndex]!, level, substType);
      if (effect) {
        this.mutations.push({
          hexIndex,
          newTerrain: effect.terrain,
          newDescription: effect.description,
        });
        this.terrainTypes[hexIndex] = effect.terrainId;
      }
    }

    // Swap buffers
    this.current = write;

    // Swap active sets
    const tmp = this.activeSet;
    this.activeSet = this.nextActiveSet;
    this.nextActiveSet = tmp;

    this.dirty = true;
  }

  /** Current read buffer (for GPU upload). */
  get currentLevels(): Float32Array { return this.levels[this.current]!; }
  get currentTypes(): Uint8Array { return this.types[this.current]!; }
  get activeCount(): number { return this.activeSet.size; }
}

// --- Terrain ID mapping (matches gpu/types.ts TERRAIN_ORDER) ---

function terrainToId(terrain: TerrainType): number {
  switch (terrain) {
    case TerrainType.WATER: return 0;
    case TerrainType.DESERT: return 1;
    case TerrainType.PLAIN: return 2;
    case TerrainType.FOREST: return 3;
    case TerrainType.MARSH: return 4;
    case TerrainType.HILL: return 5;
    case TerrainType.MOUNTAIN: return 6;
    case TerrainType.SETTLEMENT: return 7;
    case TerrainType.MAGMA: return 8;
    case TerrainType.CRYSTAL: return 9;
    case TerrainType.FLOATING: return 10;
    default: return 2;
  }
}
