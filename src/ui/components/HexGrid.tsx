import React, { useRef, useEffect, useCallback, useMemo } from 'react';
import { HexData, PlanarOverlay, WorldGenConfig, TerrainType } from '../../core/types';
import { WORLD, RENDER, BIOME } from '../../core/config';
import { TERRAIN_COLORS, PLANAR_COLORS } from '../theme';
import { hexToPixel, pixelToHex } from '../../core/geometry';
import { drawHexPath, hexToRgb } from './renderUtils';
import { computeHexState } from '../../core/planar';
import { useCamera } from '../hooks/useCamera';
import { initWebGPU, HexRenderer } from '../../gpu';
import { INSTANCE_STRIDE } from '../../gpu/types';

interface HexGridProps {
  hexes: HexData[];
  worldConfig: WorldGenConfig;
  onHexClick: (hex: HexData) => void;
  focusedHex: HexData | null;
  planarOverlays: PlanarOverlay[];
  onModifyOverlay: (overlay: PlanarOverlay) => void;
  onCommitOverlay: () => void;
  showGizmos: boolean;
}

/** Resolve hex display color as normalized [0-1] RGB for the GPU instance buffer. */
function resolveColor(hex: HexData): { r: number; g: number; b: number } {
  const baseHex = hex.isExplored ? TERRAIN_COLORS[hex.terrain] : '#0f172a';
  const base = hexToRgb(baseHex);

  if (hex.terrain !== hex.baseTerrain || hex.planarInfluences.length === 0) {
    return { r: base.r / 255, g: base.g / 255, b: base.b / 255 };
  }

  let r = base.r, g = base.g, b = base.b, tw = 1.0;
  for (const inf of hex.planarInfluences) {
    const p = hexToRgb(PLANAR_COLORS[inf.type]);
    const eff = hex.isExplored ? inf.intensity : inf.intensity * RENDER.FOG_TINT_MULT;
    const w = eff * RENDER.PLANAR_TINT_WEIGHT;
    r += p.r * w; g += p.g * w; b += p.b * w; tw += w;
  }
  return { r: r / tw / 255, g: g / tw / 255, b: b / tw / 255 };
}

export const HexGrid: React.FC<HexGridProps> = ({
  hexes,
  worldConfig,
  onHexClick,
  focusedHex,
  planarOverlays,
  onModifyOverlay,
  onCommitOverlay,
  showGizmos,
}) => {
  // --- Refs ---
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);     // overlay (top) + fallback
  const gpuCanvasRef = useRef<HTMLCanvasElement>(null);   // WebGPU canvas (behind)
  const animationRef = useRef<number>(0);
  const hexesRef = useRef(hexes);
  const overlaysRef = useRef(planarOverlays);
  const worldConfigRef = useRef(worldConfig);
  const showGizmosRef = useRef(showGizmos);
  const hoveredHexIdRef = useRef<string | null>(null);
  const draggingOverlayIdRef = useRef<string | null>(null);

  // GPU renderer (null = use Canvas 2D fallback)
  const gpuRef = useRef<HexRenderer | null>(null);
  // Reusable instance buffer to avoid per-frame allocation
  const instanceBuf = useRef<Float32Array | null>(null);

  // --- Camera ---
  const {
    camera,
    totalDragDistance,
    handleMouseDown: onCamDown,
    handleMouseMove: onCamMove,
    handleMouseUp: onCamUp,
    setCamera,
  } = useCamera(canvasRef, containerRef);

  // --- Sync refs ---
  useEffect(() => { hexesRef.current = hexes; }, [hexes]);
  useEffect(() => { overlaysRef.current = planarOverlays; }, [planarOverlays]);
  useEffect(() => { worldConfigRef.current = worldConfig; }, [worldConfig]);
  useEffect(() => { showGizmosRef.current = showGizmos; }, [showGizmos]);

  // --- GPU Init (async, runs once) ---
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const ctx = await initWebGPU();
      if (cancelled || !ctx || !gpuCanvasRef.current) return;
      try {
        const renderer = HexRenderer.create(ctx.device, gpuCanvasRef.current, 20000);
        gpuRef.current = renderer;
        console.log('WebGPU hex renderer initialized');
      } catch (err) {
        console.warn('WebGPU renderer init failed, using Canvas 2D fallback:', err);
      }
    })();
    return () => {
      cancelled = true;
      gpuRef.current?.destroy();
      gpuRef.current = null;
    };
  }, []);

  // --- Path cache for overlay gizmo labels ---
  const pathCache = useMemo(() => {
    const cache: Record<string, Path2D> = {};
    return cache;
  }, []);

  // --- Focus hex ---
  useEffect(() => {
    if (focusedHex && containerRef.current) {
      const pixel = hexToPixel(focusedHex.coordinates.q, focusedHex.coordinates.r, WORLD.HEX_SIZE);
      setCamera(-pixel.x, -pixel.y, 1.0);
    }
  }, [focusedHex, setCamera]);

  // ===================================================================
  // Mouse Handlers (identical for both render paths)
  // ===================================================================

  const handleMouseDown = (e: React.MouseEvent) => {
    if (showGizmosRef.current) {
      const result = onCamMove(e);
      if (result) {
        const { worldX, worldY } = result;
        const handleRadius = WORLD.HEX_SIZE * RENDER.GIZMO_HIT_RADIUS_FACTOR;
        const clickedOverlay = overlaysRef.current.find(o => {
          const pixel = hexToPixel(o.coordinates.q, o.coordinates.r, WORLD.HEX_SIZE);
          const dist = Math.sqrt(Math.pow(worldX - pixel.x, 2) + Math.pow(worldY - pixel.y, 2));
          return dist < handleRadius;
        });
        if (clickedOverlay) {
          draggingOverlayIdRef.current = clickedOverlay.id;
          if (canvasRef.current) canvasRef.current.style.cursor = 'move';
          return;
        }
      }
    }
    onCamDown(e);
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (draggingOverlayIdRef.current && showGizmosRef.current) {
      const result = onCamMove(e);
      if (result) {
        const hexCoords = pixelToHex(result.worldX, result.worldY, WORLD.HEX_SIZE);
        const target = overlaysRef.current.find(o => o.id === draggingOverlayIdRef.current);
        if (target && (target.coordinates.q !== hexCoords.q || target.coordinates.r !== hexCoords.r)) {
          onModifyOverlay({ ...target, coordinates: { q: hexCoords.q, r: hexCoords.r } });
        }
      }
      return;
    }
    const result = onCamMove(e);
    if (!result || result.isDragging) return;
    const hexCoords = pixelToHex(result.worldX, result.worldY, WORLD.HEX_SIZE);
    const exactHex = hexesRef.current.find(h =>
      h.coordinates.q === hexCoords.q && h.coordinates.r === hexCoords.r,
    );
    hoveredHexIdRef.current = exactHex ? exactHex.id : null;
  };

  const handleMouseUp = () => {
    if (draggingOverlayIdRef.current) {
      onCommitOverlay();
      draggingOverlayIdRef.current = null;
      if (canvasRef.current) canvasRef.current.style.cursor = 'default';
      return;
    }
    onCamUp();
  };

  const handleClick = () => {
    if (draggingOverlayIdRef.current) return;
    if (totalDragDistance.current > RENDER.DRAG_THRESHOLD) return;
    if (hoveredHexIdRef.current) {
      const target = hexesRef.current.find(h => h.id === hoveredHexIdRef.current);
      if (target) onHexClick(target);
    }
  };

  // ===================================================================
  // GPU Render Path
  // ===================================================================

  const renderGpu = useCallback(() => {
    const gpu = gpuRef.current;
    const canvas = canvasRef.current;
    const gpuCanvas = gpuCanvasRef.current;
    const container = containerRef.current;
    if (!gpu || !canvas || !gpuCanvas || !container) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = container.getBoundingClientRect();
    const logW = rect.width;
    const logH = rect.height;
    const pixW = Math.round(logW * dpr);
    const pixH = Math.round(logH * dpr);

    // Resize canvases
    if (gpuCanvas.width !== pixW || gpuCanvas.height !== pixH) {
      gpuCanvas.width = pixW;
      gpuCanvas.height = pixH;
      gpu.reconfigure();
    }
    if (canvas.width !== pixW || canvas.height !== pixH) {
      canvas.width = pixW;
      canvas.height = pixH;
    }

    const { x: camX, y: camY, zoom } = camera.current;
    gpu.updateCamera(camX, camY, zoom, logW, logH);

    // --- Build instance buffer ---
    const allHexes = hexesRef.current;
    const activeOverlays = overlaysRef.current;
    const hoveredId = hoveredHexIdRef.current;
    const needed = allHexes.length * INSTANCE_STRIDE;
    if (!instanceBuf.current || instanceBuf.current.length < needed) {
      instanceBuf.current = new Float32Array(needed);
    }
    const buf = instanceBuf.current;

    // Compute sea level for height normalization
    const cfg = worldConfigRef.current;
    const seaLevel = BIOME.SEA_LEVEL_MIN + cfg.waterLevel * BIOME.SEA_LEVEL_RANGE;
    const landRange = 1 - seaLevel;

    // View culling in world space (Y extents expanded for isometric foreshortening + height)
    const isoTilt = RENDER.ISO_TILT;
    const heightMargin = WORLD.HEX_SIZE * RENDER.HEIGHT_SCALE;
    const cx = logW / 2;
    const cy = logH / 2;
    const margin = Math.max(WORLD.HEX_SIZE * 2, 100 / zoom);
    const vl = -cx / zoom - camX - margin;
    const vr = (logW - cx) / zoom - camX + margin;
    const vt = -cy / (zoom * isoTilt) - camY - margin - heightMargin;
    const vb = (logH - cy) / (zoom * isoTilt) - camY + margin;

    let count = 0;
    for (const hex of allHexes) {
      const px = hexToPixel(hex.coordinates.q, hex.coordinates.r, WORLD.HEX_SIZE);
      if (px.x < vl || px.x > vr || px.y < vt || px.y > vb) continue;

      const live = computeHexState(hex, activeOverlays);
      const col = resolveColor(live);

      // Normalize elevation to 0-1 above sea level (water = 0)
      const height = live.terrain === TerrainType.WATER
        ? 0
        : landRange > 0 ? Math.max(0, (hex.elevation - seaLevel) / landRange) : 0;

      const off = count * INSTANCE_STRIDE;
      buf[off] = px.x;
      buf[off + 1] = px.y;
      buf[off + 2] = col.r;
      buf[off + 3] = col.g;
      buf[off + 4] = col.b;
      buf[off + 5] = hoveredId === hex.id ? 1.0 : 0.97;
      buf[off + 6] = height;
      buf[off + 7] = hex.isExplored ? 1.0 : 0.0;
      count++;
    }

    gpu.updateInstances(buf.subarray(0, count * INSTANCE_STRIDE));
    gpu.render();

    // --- Canvas 2D overlay (text, icons, hover, gizmos) ---
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, logW, logH);

    const showCoords = zoom > RENDER.ZOOM_COORDS;
    const showFogText = zoom > RENDER.ZOOM_FOG_TEXT;
    const strokeW = Math.max(0.5, 1 / zoom);

    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(zoom, zoom * isoTilt);
    ctx.translate(camX, camY);

    // Overlay detail at high zoom
    if (showCoords || showFogText) {
      for (const hex of allHexes) {
        const px = hexToPixel(hex.coordinates.q, hex.coordinates.r, WORLD.HEX_SIZE);
        if (px.x < vl || px.x > vr || px.y < vt || px.y > vb) continue;
        const live = computeHexState(hex, activeOverlays);
        const isHovered = hoveredId === hex.id;

        if (!live.isExplored) {
          if (isHovered && showFogText) {
            drawHexPath(ctx, px.x, px.y, WORLD.HEX_SIZE);
            ctx.lineWidth = strokeW * 2;
            ctx.strokeStyle = '#fbbf24';
            ctx.stroke();
            const fs = WORLD.HEX_SIZE * RENDER.FOG_FONT_SCALE;
            ctx.font = `bold ${fs}px sans-serif`;
            ctx.fillStyle = '#fbbf24';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('REVEAL', px.x, px.y);
          }
          continue;
        }

        // Hover highlight
        if (isHovered) {
          drawHexPath(ctx, px.x, px.y, WORLD.HEX_SIZE - 2);
          ctx.lineWidth = 3 * strokeW;
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
          ctx.stroke();
        }

        // Coordinates
        if (showCoords) {
          const fs = WORLD.HEX_SIZE * RENDER.COORD_FONT_SCALE;
          ctx.font = `${fs}px monospace`;
          ctx.fillStyle = 'rgba(255,255,255,0.4)';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(
            `${hex.coordinates.q},${hex.coordinates.r}`,
            px.x, px.y + WORLD.HEX_SIZE * RENDER.COORD_OFFSET_SCALE,
          );
        }
      }
    } else if (hoveredId) {
      // Low zoom: still draw hover highlight for hovered hex
      const hovered = allHexes.find(h => h.id === hoveredId);
      if (hovered) {
        const px = hexToPixel(hovered.coordinates.q, hovered.coordinates.r, WORLD.HEX_SIZE);
        if (!hovered.isExplored) {
          drawHexPath(ctx, px.x, px.y, WORLD.HEX_SIZE);
          ctx.lineWidth = strokeW * 2;
          ctx.strokeStyle = '#fbbf24';
          ctx.stroke();
        } else {
          drawHexPath(ctx, px.x, px.y, WORLD.HEX_SIZE - 2);
          ctx.lineWidth = 3 * strokeW;
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
          ctx.stroke();
        }
      }
    }

    // Planar overlay gizmos
    if (showGizmosRef.current) {
      activeOverlays.forEach(overlay => {
        const px = hexToPixel(overlay.coordinates.q, overlay.coordinates.r, WORLD.HEX_SIZE);
        const color = PLANAR_COLORS[overlay.type];

        ctx.beginPath();
        ctx.arc(px.x, px.y, WORLD.HEX_SIZE, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.strokeStyle = 'white';
        ctx.lineWidth = 2 / zoom;
        ctx.stroke();

        ctx.fillStyle = 'white';
        ctx.font = `bold ${WORLD.HEX_SIZE * 0.5}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(overlay.type.substring(9, 11).toUpperCase(), px.x, px.y);

        const radiusPx = overlay.radius * WORLD.HEX_SIZE * RENDER.HEX_SQRT3;
        ctx.beginPath();
        ctx.arc(px.x, px.y, radiusPx, 0, Math.PI * 2);
        ctx.strokeStyle = color;
        ctx.globalAlpha = 0.3;
        ctx.lineWidth = 1 / zoom;
        ctx.setLineDash([5, 5]);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1.0;
      });
    }

    ctx.restore();
  }, [pathCache, camera]);

  // ===================================================================
  // Render Loop
  // ===================================================================

  useEffect(() => {
    const loop = () => {
      if (gpuRef.current) {
        renderGpu();
      }
      animationRef.current = requestAnimationFrame(loop);
    };
    animationRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animationRef.current);
  }, [renderGpu]);

  // ===================================================================
  // JSX
  // ===================================================================

  return (
    <div ref={containerRef} className="w-full h-full cursor-default bg-slate-950 relative">
      {/* WebGPU canvas (behind) — always mounted for ref stability */}
      <canvas ref={gpuCanvasRef} className="absolute inset-0 block w-full h-full" />
      {/* Overlay / fallback canvas (top) — receives all events */}
      <canvas
        ref={canvasRef}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onClick={handleClick}
        className="absolute inset-0 block w-full h-full"
      />
    </div>
  );
};
