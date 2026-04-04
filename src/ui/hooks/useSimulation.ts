import { useRef, useEffect, useCallback, type RefObject } from 'react';
import { HexData, PlanarOverlay, AxialCoord, TerrainType } from '../../core/types';
import { HexGraph } from '../../core/graph';
import { PropagationSimulator, SubstanceType } from '../../core/propagation';
import { WaterRule, FireRule, LavaRule } from '../../core/propagation-rules';
import { FluidTexture } from '../../gpu/fluid-texture';
import { hexKey } from '../../core/geometry';

const RULES = new Map([
  [SubstanceType.WATER, WaterRule],
  [SubstanceType.FIRE, FireRule],
  [SubstanceType.LAVA, LavaRule],
]);

export function useSimulation(
  hexes: HexData[],
  overlays: readonly PlanarOverlay[],
  fluidTextureRef: RefObject<FluidTexture | null>,
  onMutations?: (indices: number[]) => void,
) {
  const simulatorRef = useRef<PropagationSimulator | null>(null);
  const graphRef = useRef<HexGraph | null>(null);
  const coordsRef = useRef<AxialCoord[]>([]);
  const hexesRef = useRef(hexes);
  const onMutationsRef = useRef(onMutations);

  hexesRef.current = hexes;
  onMutationsRef.current = onMutations;

  // Rebuild simulator when hexes or overlays change
  useEffect(() => {
    if (hexes.length === 0) return;

    // Build hex lookup (same as WorldEngine._buildLookup)
    const lookup = new Map<string, number>();
    const coords: AxialCoord[] = new Array(hexes.length);
    for (let i = 0; i < hexes.length; i++) {
      const hex = hexes[i]!;
      lookup.set(hexKey(hex.coordinates.q, hex.coordinates.r), i);
      coords[i] = hex.coordinates;
    }
    coordsRef.current = coords;

    // Build graph (only if hex count changed — coords are stable between overlay changes)
    if (!graphRef.current || graphRef.current.count !== hexes.length) {
      graphRef.current = new HexGraph(lookup, coords);
    }

    const sim = new PropagationSimulator(graphRef.current, hexes, overlays, RULES);
    simulatorRef.current = sim;

    return () => {
      simulatorRef.current = null;
    };
  }, [hexes, overlays]);

  // Tick function called from rAF loop
  const tick = useCallback((dtMs: number) => {
    const sim = simulatorRef.current;
    const fluidTex = fluidTextureRef.current;
    if (!sim || !fluidTex) return;

    const stepped = sim.tick(dtMs);
    if (stepped && sim.dirty) {
      fluidTex.update(sim.currentLevels, sim.currentTypes, coordsRef.current);
      sim.dirty = false;
    }

    // Drain mutations and apply to live hex data
    if (sim.mutations.length > 0) {
      const liveHexes = hexesRef.current;
      const mutatedIndices: number[] = [];

      for (const mut of sim.mutations) {
        const hex = liveHexes[mut.hexIndex];
        if (hex) {
          hex.terrain = mut.newTerrain as TerrainType;
          hex.description = mut.newDescription;
          mutatedIndices.push(mut.hexIndex);
        }
      }
      sim.mutations.length = 0;

      if (mutatedIndices.length > 0) {
        onMutationsRef.current?.(mutatedIndices);
      }
    }
  }, [fluidTextureRef]);

  return { tick, simulator: simulatorRef };
}
