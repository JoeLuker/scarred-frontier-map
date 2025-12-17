
import { PlanarAlignment, TerrainType, HexData, PlanarOverlay, PlanarInfluence } from '../types';
import { PLANAR_MUTATIONS } from '../constants';
import { getHexDistance } from './geometry';
import { calculateTravelStats } from './gameLogic';
import { hash } from './noise';

const getGenericFlavorPrefix = (plane: PlanarAlignment, isPrimary: boolean): string => {
    switch(plane) {
        case PlanarAlignment.FIRE: return isPrimary ? "Infernal" : "Hot";
        case PlanarAlignment.WATER: return isPrimary ? "Submerged" : "Drenched";
        case PlanarAlignment.EARTH: return isPrimary ? "Geo-Crystalline" : "Dusty";
        case PlanarAlignment.AIR: return isPrimary ? "Tempestuous" : "Breezy";
        case PlanarAlignment.POSITIVE: return isPrimary ? "Radiant" : "Vibrant";
        case PlanarAlignment.NEGATIVE: return isPrimary ? "Necrotic" : "Shadow-Touched";
        case PlanarAlignment.SCAR: return isPrimary ? "Chaotic" : "Warped";
        default: return "Magical";
    }
};

export const mutateTerrainByPlane = (
    baseTerrain: TerrainType, 
    baseFlavor: string, 
    plane: PlanarAlignment,
    intensity: number
): { terrain: TerrainType, flavor: string } => {
    
    if (plane === PlanarAlignment.MATERIAL || intensity <= 0) {
        return { terrain: baseTerrain, flavor: baseFlavor };
    }

    // Since we now use a "Natural Shape" logic, if intensity > 0 it means we are "Inside" the zone.
    // We treat almost any presence as a full mutation to avoid "blunt" fade-ins.
    const isPrimary = intensity > 0.1; 
    
    const planeRules = PLANAR_MUTATIONS[plane];
    if (planeRules) {
        const mutation = planeRules[baseTerrain];
        if (mutation) {
            const newTerrain = isPrimary && mutation.targetTerrain ? mutation.targetTerrain : baseTerrain;
            return {
                terrain: newTerrain,
                flavor: isPrimary ? mutation.flavorPrimary : mutation.flavorSecondary
            };
        }
    }

    const prefix = getGenericFlavorPrefix(plane, isPrimary);
    return {
        terrain: baseTerrain,
        flavor: `${prefix} ${baseFlavor}`
    };
};

/**
 * Calculates the mutated state for a single hex based on active overlays.
 */
export const computeHexState = (hex: HexData, overlays: PlanarOverlay[]): HexData => {
    // Optimization: If no overlays, return base state immediately
    if (overlays.length === 0) {
         if (hex.planarAlignment === PlanarAlignment.MATERIAL) return hex;
         
         const stats = calculateTravelStats(30, hex.baseTerrain, hex.element);
         return {
             ...hex,
             terrain: hex.baseTerrain,
             description: hex.baseDescription,
             planarAlignment: PlanarAlignment.MATERIAL,
             planarIntensity: 0,
             planarInfluences: [],
             travelTimeHours: stats.travelTime,
             explorationTimeDays: stats.explorationTime
         };
    }

    const influences: PlanarInfluence[] = [];
    let maxIntensity = 0;
    let dominantPlane = PlanarAlignment.MATERIAL;

    // Calculate all influences
    for (const overlay of overlays) {
        const dist = getHexDistance(
            {q: hex.coordinates.x, r: hex.coordinates.y}, 
            {q: overlay.coordinates.x, r: overlay.coordinates.y}
        );

        // ORGANIC EDGE CALCULATION
        // Instead of a perfect circle (dist <= radius), we add noise to the radius.
        // This makes the boundary "wobble" based on the hex's position.
        
        // Hash returns 0..1. We map it to -1.5..1.5 variation
        const noiseVal = (hash(hex.coordinates.x, hex.coordinates.y, 12345) / 4294967296); 
        const noiseOffset = (noiseVal * 3.0) - 1.5; 
        
        const effectiveRadius = overlay.radius + noiseOffset;

        if (dist <= effectiveRadius) {
            // We are "inside" the natural zone.
            // Intensity is high near center, but stays relatively high until the very edge
            // to create a solid "patch" of terrain rather than a soft gradient.
            const normalizedDist = dist / (effectiveRadius + 0.1);
            const intensity = Math.max(0, 1.0 - (normalizedDist * normalizedDist * normalizedDist)); 
            
            if (intensity > 0) {
                influences.push({ type: overlay.type, intensity });

                if (intensity > maxIntensity) {
                    maxIntensity = intensity;
                    dominantPlane = overlay.type;
                }
            }
        }
    }

    // Apply mutation based on DOMINANT plane
    const { terrain, flavor } = mutateTerrainByPlane(
        hex.baseTerrain, 
        hex.baseDescription, 
        dominantPlane, 
        maxIntensity
    );

    // Only recalculate stats if terrain type actually changed
    let stats = { travelTime: hex.travelTimeHours, explorationTime: hex.explorationTimeDays };
    if (terrain !== hex.terrain) {
        stats = calculateTravelStats(30, terrain, hex.element);
    }

    return {
        ...hex,
        terrain,
        description: flavor,
        planarAlignment: dominantPlane,
        planarIntensity: maxIntensity,
        planarInfluences: influences,
        travelTimeHours: stats.travelTime,
        explorationTimeDays: stats.explorationTime
    };
};

export const applyOverlaysToMap = (hexes: HexData[], overlays: PlanarOverlay[]): HexData[] => {
    return hexes.map(hex => computeHexState(hex, overlays));
};
