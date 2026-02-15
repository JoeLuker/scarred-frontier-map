import React, { useRef, useEffect, useCallback, useMemo } from 'react';
import { HexData, PlanarOverlay, WorldGenConfig, TerrainType } from '../../core/types';
import { WORLD, RENDER, BIOME, CAMERA } from '../../core/config';
import { TERRAIN_COLORS, PLANAR_COLORS } from '../theme';
import { hexToPixel, pixelToHex } from '../../core/geometry';
import { hexToRgb } from './renderUtils';
import { computeHexState } from '../../core/planar';
import { useCamera } from '../hooks/useCamera';
import { initWebGPU, HexRenderer, worldToScreen } from '../../gpu';
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
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);     // overlay (top)
  const gpuCanvasRef = useRef<HTMLCanvasElement>(null);   // WebGPU canvas (behind)
  const animationRef = useRef<number>(0);
  const hexesRef = useRef(hexes);
  const overlaysRef = useRef(planarOverlays);
  const worldConfigRef = useRef(worldConfig);
  const showGizmosRef = useRef(showGizmos);
  const hoveredHexIdRef = useRef<string | null>(null);
  const draggingOverlayIdRef = useRef<string | null>(null);

  const gpuRef = useRef<HexRenderer | null>(null);
  const instanceBuf = useRef<Float32Array | null>(null);

  const {
    camera,
    totalDragDistance,
    handleMouseDown: onCamDown,
    handleMouseMove: onCamMove,
    handleMouseUp: onCamUp,
    computeViewProjection,
    setCamera,
  } = useCamera(canvasRef, containerRef);

  // --- Sync refs ---
  useEffect(() => { hexesRef.current = hexes; }, [hexes]);
  useEffect(() => { overlaysRef.current = planarOverlays; }, [planarOverlays]);
  useEffect(() => { worldConfigRef.current = worldConfig; }, [worldConfig]);
  useEffect(() => { showGizmosRef.current = showGizmos; }, [showGizmos]);

  // --- GPU Init ---
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const ctx = await initWebGPU();
      if (cancelled || !ctx || !gpuCanvasRef.current) return;
      try {
        const renderer = HexRenderer.create(ctx.device, gpuCanvasRef.current, 20000);
        gpuRef.current = renderer;
        console.log('WebGPU 3D hex renderer initialized');
      } catch (err) {
        console.warn('WebGPU renderer init failed:', err);
      }
    })();
    return () => {
      cancelled = true;
      gpuRef.current?.destroy();
      gpuRef.current = null;
    };
  }, []);

  // --- Focus hex ---
  useEffect(() => {
    if (focusedHex && containerRef.current) {
      const pixel = hexToPixel(focusedHex.coordinates.q, focusedHex.coordinates.r, WORLD.HEX_SIZE);
      setCamera(pixel.x, pixel.y); // pixel.y → world Z
    }
  }, [focusedHex, setCamera]);

  // ===================================================================
  // Mouse Handlers
  // ===================================================================

  const handleMouseDown = (e: React.MouseEvent) => {
    if (showGizmosRef.current && e.button === 0) {
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
    if (totalDragDistance.current > CAMERA.DRAG_THRESHOLD) return;
    if (hoveredHexIdRef.current) {
      const target = hexesRef.current.find(h => h.id === hoveredHexIdRef.current);
      if (target) onHexClick(target);
    }
  };

  // ===================================================================
  // GPU Render
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

    if (gpuCanvas.width !== pixW || gpuCanvas.height !== pixH) {
      gpuCanvas.width = pixW;
      gpuCanvas.height = pixH;
      gpu.reconfigure();
    }
    if (canvas.width !== pixW || canvas.height !== pixH) {
      canvas.width = pixW;
      canvas.height = pixH;
    }

    const aspect = logW / logH;
    const viewProj = computeViewProjection(aspect);
    gpu.updateCamera(viewProj);

    // --- Build instance buffer ---
    const allHexes = hexesRef.current;
    const activeOverlays = overlaysRef.current;
    const hoveredId = hoveredHexIdRef.current;
    const needed = allHexes.length * INSTANCE_STRIDE;
    if (!instanceBuf.current || instanceBuf.current.length < needed) {
      instanceBuf.current = new Float32Array(needed);
    }
    const buf = instanceBuf.current;

    const cfg = worldConfigRef.current;
    const seaLevel = BIOME.SEA_LEVEL_MIN + cfg.waterLevel * BIOME.SEA_LEVEL_RANGE;
    const landRange = 1 - seaLevel;

    // Distance-based culling from camera target
    const cam = camera.current;
    const cullDist = cam.distance * 2.5;
    const cullDist2 = cullDist * cullDist;

    let count = 0;
    for (const hex of allHexes) {
      const px = hexToPixel(hex.coordinates.q, hex.coordinates.r, WORLD.HEX_SIZE);

      // Cull hexes too far from camera target
      const dx = px.x - cam.targetX;
      const dz = px.y - cam.targetZ; // hex y → world z
      if (dx * dx + dz * dz > cullDist2) continue;

      const live = computeHexState(hex, activeOverlays);
      const col = resolveColor(live);

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

    // --- Canvas 2D overlay (hover, gizmos) ---
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, logW, logH);

    // Draw hover highlight at projected position
    if (hoveredId) {
      const hovered = allHexes.find(h => h.id === hoveredId);
      if (hovered) {
        const hp = hexToPixel(hovered.coordinates.q, hovered.coordinates.r, WORLD.HEX_SIZE);
        const screen = worldToScreen(hp.x, 0, hp.y, viewProj, logW, logH);
        if (screen) {
          const radius = Math.max(4, 600 / cam.distance * WORLD.HEX_SIZE);
          ctx.beginPath();
          ctx.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
          ctx.strokeStyle = hovered.isExplored
            ? 'rgba(255, 255, 255, 0.8)'
            : '#fbbf24';
          ctx.lineWidth = 2;
          ctx.stroke();

          if (!hovered.isExplored) {
            ctx.fillStyle = '#fbbf24';
            ctx.font = `bold ${Math.max(10, radius * 0.6)}px sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('REVEAL', screen.x, screen.y);
          }
        }
      }
    }

    // Planar overlay gizmos
    if (showGizmosRef.current) {
      activeOverlays.forEach(overlay => {
        const op = hexToPixel(overlay.coordinates.q, overlay.coordinates.r, WORLD.HEX_SIZE);
        const screen = worldToScreen(op.x, 0, op.y, viewProj, logW, logH);
        if (!screen) return;
        const color = PLANAR_COLORS[overlay.type];
        const radius = Math.max(6, 800 / cam.distance * WORLD.HEX_SIZE);

        ctx.beginPath();
        ctx.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.strokeStyle = 'white';
        ctx.lineWidth = 2;
        ctx.stroke();

        ctx.fillStyle = 'white';
        ctx.font = `bold ${radius * 0.7}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(overlay.type.substring(9, 11).toUpperCase(), screen.x, screen.y);
      });
    }
  }, [computeViewProjection, camera]);

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

  return (
    <div ref={containerRef} className="w-full h-full cursor-default bg-slate-950 relative">
      <canvas ref={gpuCanvasRef} className="absolute inset-0 block w-full h-full" />
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
