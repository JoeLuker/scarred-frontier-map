
import { TerrainType, TerrainElement, WorldGenConfig } from '../types';
import { domainWarp, fbm, hash } from './noise';

interface BiomeInfo {
    terrain: TerrainType;
    element: TerrainElement;
    flavor: string;
}

const calculateSettlementScore = (terrain: TerrainType, elev: number, moist: number, q: number, r: number, seed: number): number => {
    if (terrain === TerrainType.WATER || terrain === TerrainType.MOUNTAIN) return 0;
    let score = 0.5;
    if (terrain === TerrainType.PLAIN) score += 0.3;
    if (terrain === TerrainType.HILL) score += 0.2;
    if (terrain === TerrainType.DESERT) score -= 0.1;
    const chaos = hash(q, r, seed + 111) % 100 / 100;
    score += (chaos * 0.2);
    return score;
};

const calculateElement = (terrain: TerrainType, elev: number, moist: number, q: number, r: number, seed: number): TerrainElement => {
    const val = hash(q, r, seed + 777) % 1000 / 1000;
    
    if (terrain === TerrainType.MOUNTAIN) {
        if (val > 0.92) return TerrainElement.SECRET; 
        if (val > 0.75) return TerrainElement.DIFFICULT;
        if (val > 0.65) return TerrainElement.RESOURCE; 
    }
    if (terrain === TerrainType.FOREST) {
        if (val > 0.88) return TerrainElement.HUNTING_GROUND;
        if (val > 0.82) return TerrainElement.SECRET; 
    }
    if (val > 0.96) return TerrainElement.FEATURE; 
    if (val > 0.93) return TerrainElement.RESOURCE;
    
    return TerrainElement.STANDARD;
};

export const getBiomeAt = (
    q: number, 
    r: number, 
    config: WorldGenConfig,
    forceNoRiver: boolean = false, 
    overrideSector?: {sq: number, sr: number}
): BiomeInfo => {
    const { seed, waterLevel, mountainLevel, vegetationLevel, riverDensity, ruggedness } = config;

    // Scale noise freq slightly by ruggedness
    const baseScale = 0.04 + (ruggedness * 0.04); 
    
    // 1. ELEVATION
    let rawElevation = domainWarp(q * baseScale, r * baseScale, seed);
    // Karst factor: Higher ruggedness = sharper peaks/valleys
    const karstFactor = 2.0 + (ruggedness * 2.0); 
    const elevation = Math.pow(rawElevation, karstFactor);

    // 2. MOISTURE
    const moistureNoise = fbm(q * baseScale * 1.5, r * baseScale * 1.5, seed + 500, 3);
    const rainShadow = elevation > 0.6 ? -0.3 : 0; 
    
    // Impact of Vegetation Level on Moisture map (Shift the whole moisture table up/down)
    // Range shift: -0.2 (Arid) to +0.2 (Lush) based on slider
    const moistureShift = (vegetationLevel - 0.5) * 0.5;
    const moisture = Math.max(0, Math.min(1, moistureNoise + rainShadow + moistureShift));

    // 3. RIVER
    const riverNoiseVal = fbm(q * 0.08, r * 0.08, seed + 200, 2);
    const riverRidge = Math.abs(riverNoiseVal - 0.5) * 2; 
    const isRiverPotential = !forceNoRiver && riverRidge < (0.04 * riverDensity);

    // 4. THRESHOLDS
    // Adjusted formulas to allow sliders to force extreme biomes
    
    // Sea Level: 0.0 (Dry) to 0.7 (Archipelago). Default 0.5 -> 0.25
    const seaLevel = waterLevel * 0.6; 
    
    // Mountain Height: Threshold where elevation becomes mountain. 
    // Slider 0 (Few mountains) -> Threshold 0.9. Slider 1 (Many mountains) -> Threshold 0.3
    const mountainThreshold = 0.9 - (mountainLevel * 0.6);
    
    // Hill Height: Just below mountains
    const hillThreshold = mountainThreshold - 0.15;

    let terrain: TerrainType = TerrainType.PLAIN;
    let flavor = "Wilderness";

    if (elevation < seaLevel) {
        terrain = TerrainType.WATER;
        flavor = "Lake";
    } 
    else if (elevation > mountainThreshold) {
        terrain = TerrainType.MOUNTAIN;
        flavor = "Peak";
    } 
    else if (isRiverPotential && elevation > seaLevel && elevation < mountainThreshold) {
        terrain = TerrainType.WATER;
        flavor = "River";
    }
    else if (elevation > hillThreshold) {
        terrain = TerrainType.HILL;
        flavor = "Hills";
    } 
    else {
        // Biome Triangle based on Moisture
        if (moisture < 0.3) {
            terrain = TerrainType.DESERT;
            flavor = "Wasteland";
        } 
        else if (moisture > 0.7) {
            terrain = TerrainType.MARSH;
            flavor = "Marsh";
        } 
        else if (moisture > 0.5) {
            terrain = TerrainType.FOREST;
            flavor = "Forest";
        } 
        else {
            terrain = TerrainType.PLAIN;
            flavor = "Plains";
        }
    }

    // --- FEATURE / ELEMENT PLACEMENT ---
    const element = calculateElement(terrain, elevation, moisture, q, r, seed);
    
    const settlementRoll = (hash(q, r, seed + 999) % 100) / 100;

    if (element === TerrainElement.FEATURE && settlementRoll > 0.7) {
        const settlementScore = calculateSettlementScore(terrain, elevation, moisture, q, r, seed);
        if (settlementScore > 0.75) {
            terrain = TerrainType.SETTLEMENT;
            flavor = flavor + " Settlement";
        }
    }

    return { terrain, element, flavor };
};
