import { describe, it, expect } from 'vitest';
import { HexGraph } from '../graph';
import { PropagationSimulator, SubstanceType } from '../propagation';
import { WaterRule } from '../propagation-rules';
import { hexKey } from '../geometry';
import { HexData, PlanarAlignment, PlanarOverlay, TerrainType, TerrainElement } from '../types';
import { PLANAR } from '../config';

function makeHex(q: number, r: number, terrain: TerrainType, elevation: number, overrides?: Partial<HexData>): HexData {
  return {
    id: `HEX-${q}_${r}`,
    groupId: 'SECTOR-0_0',
    terrain,
    element: TerrainElement.STANDARD,
    description: terrain,
    coordinates: { q, r },
    notes: '',
    elevation,
    hasRiver: false,
    baseTerrain: terrain,
    baseDescription: terrain,
    planarAlignment: PlanarAlignment.MATERIAL,
    planarIntensity: 0,
    planarFragmentation: 0.5,
    planarLift: 0.5,
    planarRadius: 0,
    planarInfluences: [],
    reactionEmission: null,
    ...overrides,
  };
}

describe('PropagationSimulator', () => {
  // Build a small line of hexes: 5 hexes at q=0..4, r=0
  // Elevation descends left to right: 0.8, 0.6, 0.4, 0.2, 0.1
  function buildLine() {
    const hexes: HexData[] = [
      makeHex(0, 0, TerrainType.WATER, 0.1),   // water source (low)
      makeHex(1, 0, TerrainType.PLAIN, 0.3),
      makeHex(2, 0, TerrainType.PLAIN, 0.2),
      makeHex(3, 0, TerrainType.PLAIN, 0.15),
      makeHex(4, 0, TerrainType.PLAIN, 0.05),   // depression
    ];

    const lookup = new Map<string, number>();
    hexes.forEach((h, i) => lookup.set(hexKey(h.coordinates.q, h.coordinates.r), i));

    const graph = new HexGraph(lookup, hexes.map(h => h.coordinates));
    const rules = new Map([[SubstanceType.WATER, WaterRule]]);
    const sim = new PropagationSimulator(graph, hexes, [], rules);

    return { hexes, sim, graph };
  }

  it('identifies water terrain as source', () => {
    const { sim } = buildLine();
    expect(sim.sources[0]).toBe(SubstanceType.WATER);
  });

  it('non-water terrain is not a source', () => {
    const { sim } = buildLine();
    expect(sim.sources[1]).toBe(SubstanceType.NONE);
    expect(sim.sources[2]).toBe(SubstanceType.NONE);
  });

  it('water propagates after ticks', () => {
    const { sim } = buildLine();

    // Run 20 ticks (2 seconds)
    for (let i = 0; i < 20; i++) {
      sim.tick(100);
    }

    // Hex 1 (adjacent to water source) should have some water
    expect(sim.currentLevels[1]).toBeGreaterThan(0);
  });

  it('water reaches depression over many ticks', () => {
    const { sim } = buildLine();

    // Run 100 ticks (10 seconds of sim time)
    for (let i = 0; i < 100; i++) {
      sim.tick(100);
    }

    // Depression at index 4 should have accumulated water
    // (may take more ticks depending on rates, but after 100 it should have some)
    expect(sim.currentLevels[4]).toBeGreaterThan(0);
  });

  it('dirty flag is set after stepping', () => {
    const { sim } = buildLine();
    sim.dirty = false;
    sim.tick(100);
    expect(sim.dirty).toBe(true);
  });

  it('double buffer swap works correctly', () => {
    const { sim } = buildLine();

    // Get initial levels
    const initial0 = sim.currentLevels[0];
    expect(initial0).toBeGreaterThan(0); // source should have level

    // Tick once
    sim.tick(100);

    // Source should still have level (sources are maintained)
    expect(sim.currentLevels[0]).toBeGreaterThan(0);
  });

  it('mountains block water', () => {
    const hexes: HexData[] = [
      makeHex(0, 0, TerrainType.WATER, 0.1),
      makeHex(1, 0, TerrainType.MOUNTAIN, 0.8),
      makeHex(2, 0, TerrainType.PLAIN, 0.05),
    ];

    const lookup = new Map<string, number>();
    hexes.forEach((h, i) => lookup.set(hexKey(h.coordinates.q, h.coordinates.r), i));

    const graph = new HexGraph(lookup, hexes.map(h => h.coordinates));
    const rules = new Map([[SubstanceType.WATER, WaterRule]]);
    const sim = new PropagationSimulator(graph, hexes, [], rules);

    // Run many ticks
    for (let i = 0; i < 50; i++) {
      sim.tick(100);
    }

    // Water should not reach hex 2 (mountain blocks)
    expect(sim.currentLevels[2]).toBe(0);
  });

  it('hexes under Air overlay (non-FLOATING) get lower effective elevation', () => {
    const baseElevation = 0.5;
    const intensity = 0.8;
    const hexes: HexData[] = [
      makeHex(0, 0, TerrainType.PLAIN, baseElevation, {
        planarAlignment: PlanarAlignment.AIR,
        planarIntensity: intensity,
      }),
      makeHex(1, 0, TerrainType.FLOATING, baseElevation, {
        planarAlignment: PlanarAlignment.AIR,
        planarIntensity: intensity,
      }),
      makeHex(2, 0, TerrainType.PLAIN, baseElevation),
    ];

    const lookup = new Map<string, number>();
    hexes.forEach((h, i) => lookup.set(hexKey(h.coordinates.q, h.coordinates.r), i));

    const graph = new HexGraph(lookup, hexes.map(h => h.coordinates));
    const rules = new Map([[SubstanceType.WATER, WaterRule]]);
    const sim = new PropagationSimulator(graph, hexes, [], rules);

    const gougeDepth = Math.abs(PLANAR.TORNADO.GOUGE_DEPTH);

    // Ground hex under Air overlay should have depressed elevation
    expect(sim.elevations[0]).toBeCloseTo(baseElevation - gougeDepth * intensity);

    // Floating island hex keeps base elevation (it's the island itself)
    expect(sim.elevations[1]).toBe(baseElevation);

    // Hex outside Air overlay keeps base elevation
    expect(sim.elevations[2]).toBe(baseElevation);
  });
});
