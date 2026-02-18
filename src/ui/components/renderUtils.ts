import { HexData, PlanarAlignment } from '../../core/types';
import { TERRAIN_COLORS, PLANAR_COLORS } from '../theme';
import { WORLD, RENDER } from '../../core/config';

export interface RenderLOD {
  showIcons: boolean;
  showCoords: boolean;
  strokeWidth: number;
}

export const hexToRgb = (hex: string) => {
  if (!hex || typeof hex !== 'string') return { r: 0, g: 0, b: 0 };
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1]!, 16),
    g: parseInt(result[2]!, 16),
    b: parseInt(result[3]!, 16),
  } : { r: 0, g: 0, b: 0 };
};

export const getBlendedColor = (hex: HexData): string => {
  const baseRgb = hexToRgb(TERRAIN_COLORS[hex.terrain]);

  if (hex.terrain !== hex.baseTerrain) {
    return `rgb(${baseRgb.r}, ${baseRgb.g}, ${baseRgb.b})`;
  }

  const influences = hex.planarInfluences;

  if (influences.length === 0) {
    return `rgb(${baseRgb.r}, ${baseRgb.g}, ${baseRgb.b})`;
  }

  let r = baseRgb.r;
  let g = baseRgb.g;
  let b = baseRgb.b;
  let totalWeight = 1.0;

  for (const inf of influences) {
    const pRgb = hexToRgb(PLANAR_COLORS[inf.type]);

    const weight = inf.intensity * RENDER.PLANAR_TINT_WEIGHT;

    r += pRgb.r * weight;
    g += pRgb.g * weight;
    b += pRgb.b * weight;
    totalWeight += weight;
  }

  return `rgb(${Math.round(r / totalWeight)}, ${Math.round(g / totalWeight)}, ${Math.round(b / totalWeight)})`;
};

export const getStrokeColor = (_hex: HexData): string => {
  return '#0f172a';
};

export const drawHexPath = (ctx: CanvasRenderingContext2D, x: number, y: number, size: number) => {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const angle_deg = 60 * i + 30;
    const angle_rad = (Math.PI / 180) * angle_deg;
    ctx.lineTo(x + size * Math.cos(angle_rad), y + size * Math.sin(angle_rad));
  }
  ctx.closePath();
};

export const drawTerrainHex = (
  ctx: CanvasRenderingContext2D,
  hex: HexData,
  x: number,
  y: number,
  LOD: RenderLOD,
  iconPath: Path2D | null,
  isHovered: boolean,
  zoomLevel: number,
) => {
  drawHexPath(ctx, x, y, WORLD.HEX_SIZE);

  ctx.fillStyle = getBlendedColor(hex);
  ctx.fill();

  ctx.lineWidth = LOD.strokeWidth;
  ctx.strokeStyle = getStrokeColor(hex);
  ctx.stroke();

  // Bevel highlight
  if (zoomLevel > RENDER.ZOOM_BEVEL) {
    ctx.lineWidth = LOD.strokeWidth;
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.stroke();
  }

  // Icon
  if (LOD.showIcons && iconPath) {
    ctx.save();
    ctx.translate(x, y);
    const iconScale = (WORLD.HEX_SIZE / RENDER.ICON_SCALE_DIVISOR) * RENDER.ICON_SCALE_FACTOR;
    ctx.scale(iconScale, iconScale);
    ctx.translate(-12, -12);

    ctx.lineWidth = (1.5 / iconScale) * LOD.strokeWidth;
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.stroke(iconPath);
    ctx.restore();
  }

  // Coordinates
  if (LOD.showCoords) {
    const fontSize = WORLD.HEX_SIZE * RENDER.COORD_FONT_SCALE;
    ctx.font = `${fontSize}px monospace`;
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${hex.coordinates.q},${hex.coordinates.r}`, x, y + WORLD.HEX_SIZE * RENDER.COORD_OFFSET_SCALE);
  }

  // Highlight selection
  if (isHovered) {
    drawHexPath(ctx, x, y, WORLD.HEX_SIZE - 2);
    ctx.lineWidth = 3 * LOD.strokeWidth;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
    ctx.stroke();
  }
};
