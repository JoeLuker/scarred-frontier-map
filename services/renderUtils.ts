
import { HexData, PlanarAlignment, PlanarOverlay } from '../types';
import { TERRAIN_COLORS, PLANAR_COLORS } from '../theme';
import { MAP_CONFIG } from '../constants';

// --- Types ---
export interface RenderLOD {
    showIcons: boolean;
    showCoords: boolean;
    showFogText: boolean;
    simpleFog: boolean;
    strokeWidth: number;
}

// --- Helpers ---

export const hexToRgb = (hex: string) => {
  if (!hex || typeof hex !== 'string') return { r: 0, g: 0, b: 0 };
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : { r: 0, g: 0, b: 0 };
}

/**
 * Calculates the hex color.
 * CRITICAL UPDATE: If the terrain has mutated (preview state), we use the pure color of the new terrain.
 * We only apply the "Planar Tint" to hexes that are influenced but NOT mutated (the edge/falloff).
 */
export const getBlendedColor = (hex: HexData): string => {
    // FOG OF WAR: If not explored, use dark fog base
    const baseColorHex = hex.isExplored 
        ? (hex.color || TERRAIN_COLORS[hex.terrain]) 
        : '#0f172a'; // Slate 900 for Fog

    const baseRgb = hexToRgb(baseColorHex);

    // 1. If the terrain type has changed from the base (Mutated via Preview),
    // return the pure color of the new terrain. This ensures Preview == Baked.
    if (hex.terrain !== hex.baseTerrain) {
        return `rgb(${baseRgb.r}, ${baseRgb.g}, ${baseRgb.b})`;
    }

    const influences = hex.planarInfluences || [];

    // Optimization: Pure Base Color if no influences
    if (influences.length === 0) {
         return `rgb(${baseRgb.r}, ${baseRgb.g}, ${baseRgb.b})`;
    }

    // 2. If we are here, the hex is in the "Falloff" zone (influenced, but not mutated).
    // Apply a very subtle glow to show it's being touched by the plane.
    let r = baseRgb.r;
    let g = baseRgb.g;
    let b = baseRgb.b;
    let totalWeight = 1.0; 

    for (const inf of influences) {
        const pRgb = hexToRgb(PLANAR_COLORS[inf.type]);
        
        // Drastically reduced weight to avoid "blunt" look. Just a tint.
        const effectiveIntensity = hex.isExplored ? inf.intensity : inf.intensity * 0.3;
        const weight = effectiveIntensity * 0.6; // Reduced from 2.5
        
        r += pRgb.r * weight;
        g += pRgb.g * weight;
        b += pRgb.b * weight;
        totalWeight += weight;
    }

    return `rgb(${Math.round(r / totalWeight)}, ${Math.round(g / totalWeight)}, ${Math.round(b / totalWeight)})`;
};

export const getStrokeColor = (hex: HexData): string => {
    // If Unexplored, stroke is faint
    if (!hex.isExplored) return '#1e293b';

    // Standard stroke logic - keep it clean, don't colorize the stroke excessively
    // unless you want to highlight the grid boundary.
    return '#0f172a'; // Standard Slate 900
};

export const drawHexPath = (ctx: CanvasRenderingContext2D, x: number, y: number, size: number, flatTop: boolean = false) => {
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const angle_deg = 60 * i + (flatTop ? 0 : 30); 
      const angle_rad = Math.PI / 180 * angle_deg;
      ctx.lineTo(x + size * Math.cos(angle_rad), y + size * Math.sin(angle_rad));
    }
    ctx.closePath();
};

export const drawSectorPlaceholder = (
    ctx: CanvasRenderingContext2D,
    hex: HexData,
    x: number,
    y: number,
    LOD: RenderLOD,
    isHovered: boolean
) => {
   // Deprecated visual
};

export const drawTerrainHex = (
    ctx: CanvasRenderingContext2D,
    hex: HexData, // This expects a fully computed "Live Hex"
    x: number,
    y: number,
    LOD: RenderLOD,
    iconPath: Path2D | null,
    isHovered: boolean,
    zoomLevel: number
) => {
    drawHexPath(ctx, x, y, MAP_CONFIG.HEX_SIZE, false);
    
    ctx.fillStyle = getBlendedColor(hex);
    ctx.fill();

    ctx.lineWidth = LOD.strokeWidth;
    ctx.strokeStyle = getStrokeColor(hex); 
    ctx.stroke();
    
    // Unexplored Styling
    if (!hex.isExplored) {
        if (zoomLevel > 0.5) {
            ctx.fillStyle = "rgba(255,255,255,0.03)";
            ctx.fill();
        }
        
        if (isHovered) {
            ctx.lineWidth = LOD.strokeWidth * 2;
            ctx.strokeStyle = "#fbbf24"; // Amber
            ctx.stroke();
            
            if (LOD.showFogText) {
                const fontSize = MAP_CONFIG.HEX_SIZE * 0.3;
                ctx.font = `bold ${fontSize}px sans-serif`;
                ctx.fillStyle = "#fbbf24";
                ctx.textAlign = "center";
                ctx.textBaseline = "middle";
                ctx.fillText("REVEAL", x, y);
            }
        }
        return; 
    }

    // Bevel highlight
    if (zoomLevel > 0.4) {
        ctx.lineWidth = LOD.strokeWidth;
        ctx.strokeStyle = 'rgba(255,255,255,0.1)';
        ctx.stroke();
    }

    // Icon
    if (LOD.showIcons && iconPath) {
        ctx.save();
        ctx.translate(x, y);
        const iconScale = MAP_CONFIG.HEX_SIZE / 24 * 0.5;
        ctx.scale(iconScale, iconScale);
        ctx.translate(-12, -12); 
        
        ctx.lineWidth = 1.5 / iconScale * LOD.strokeWidth; 
        ctx.strokeStyle = "rgba(255,255,255,0.7)";
        ctx.stroke(iconPath);
        ctx.restore();
    }

    // Coordinates
    if (LOD.showCoords) {
        const fontSize = MAP_CONFIG.HEX_SIZE * 0.25;
        ctx.font = `${fontSize}px monospace`;
        ctx.fillStyle = "rgba(255,255,255,0.4)";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(`${hex.coordinates.x},${hex.coordinates.y}`, x, y + (MAP_CONFIG.HEX_SIZE * 0.6));
    }

    // Highlight selection
    if (isHovered) {
        drawHexPath(ctx, x, y, MAP_CONFIG.HEX_SIZE - 2, false);
        ctx.lineWidth = 3 * LOD.strokeWidth;
        ctx.strokeStyle = "rgba(255, 255, 255, 0.8)";
        ctx.stroke();
    }
};
