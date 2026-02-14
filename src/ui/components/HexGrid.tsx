import React, { useRef, useEffect, useCallback, useMemo } from 'react';
import { HexData, PlanarOverlay } from '../../core/types';
import { WORLD, RENDER } from '../../core/config';
import { TERRAIN_PATHS, PLANAR_COLORS } from '../theme';
import { hexToPixel, pixelToHex } from '../../core/geometry';
import { drawTerrainHex, drawHexPath } from './renderUtils';
import { computeHexState } from '../../core/planar';
import { useCamera } from '../hooks/useCamera';

interface HexGridProps {
  hexes: HexData[];
  onHexClick: (hex: HexData) => void;
  focusedHex: HexData | null;
  planarOverlays: PlanarOverlay[];
  onModifyOverlay: (overlay: PlanarOverlay) => void;
  onCommitOverlay: () => void;
  showGizmos: boolean;
}

export const HexGrid: React.FC<HexGridProps> = ({
  hexes,
  onHexClick,
  focusedHex,
  planarOverlays,
  onModifyOverlay,
  onCommitOverlay,
  showGizmos,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const animationRef = useRef<number>(0);
  const hexesRef = useRef(hexes);
  const overlaysRef = useRef(planarOverlays);

  const hoveredHexIdRef = useRef<string | null>(null);
  const draggingOverlayIdRef = useRef<string | null>(null);

  const {
    camera,
    totalDragDistance,
    handleMouseDown: onCamDown,
    handleMouseMove: onCamMove,
    handleMouseUp: onCamUp,
    handleWheel,
    setCamera,
  } = useCamera(canvasRef, containerRef);

  useEffect(() => {
    hexesRef.current = hexes;
  }, [hexes]);

  useEffect(() => {
    overlaysRef.current = planarOverlays;
  }, [planarOverlays]);

  const pathCache = useMemo(() => {
    const cache: Record<string, Path2D> = {};
    for (const [key, d] of Object.entries(TERRAIN_PATHS)) {
      cache[key] = new Path2D(d);
    }
    return cache;
  }, []);

  useEffect(() => {
    if (focusedHex && containerRef.current) {
      const pixel = hexToPixel(focusedHex.coordinates.q, focusedHex.coordinates.r, WORLD.HEX_SIZE);
      setCamera(-pixel.x, -pixel.y, 1.0);
    }
  }, [focusedHex, setCamera]);

  // --- Mouse Handlers ---

  const handleMouseDown = (e: React.MouseEvent) => {
    if (showGizmos) {
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
    if (draggingOverlayIdRef.current && showGizmos) {
      const result = onCamMove(e);
      if (result) {
        const hexCoords = pixelToHex(result.worldX, result.worldY, WORLD.HEX_SIZE);
        const target = overlaysRef.current.find(o => o.id === draggingOverlayIdRef.current);
        if (target) {
          if (target.coordinates.q !== hexCoords.q || target.coordinates.r !== hexCoords.r) {
            onModifyOverlay({ ...target, coordinates: { q: hexCoords.q, r: hexCoords.r } });
          }
        }
      }
      return;
    }

    const result = onCamMove(e);
    if (!result || result.isDragging) return;

    const { worldX, worldY } = result;
    const hexCoords = pixelToHex(worldX, worldY, WORLD.HEX_SIZE);
    const exactHex = hexesRef.current.find(h =>
      h.coordinates.q === hexCoords.q &&
      h.coordinates.r === hexCoords.r,
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

  // --- Renderer ---

  const render = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = container.getBoundingClientRect();

    if (canvas.width !== rect.width * dpr || canvas.height !== rect.height * dpr) {
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.scale(dpr, dpr);
    }

    const zoom = camera.current.zoom;
    const LOD = {
      showIcons: zoom > RENDER.ZOOM_ICONS,
      showCoords: zoom > RENDER.ZOOM_COORDS,
      showFogText: zoom > RENDER.ZOOM_FOG_TEXT,
      simpleFog: zoom < RENDER.ZOOM_SIMPLE_FOG,
      strokeWidth: Math.max(0.5, 1 / zoom),
    };

    ctx.fillStyle = '#020617';
    ctx.fillRect(0, 0, rect.width, rect.height);

    const { x: camX, y: camY } = camera.current;
    const centerX = rect.width / 2;
    const centerY = rect.height / 2;

    ctx.save();
    ctx.translate(centerX, centerY);
    ctx.scale(zoom, zoom);
    ctx.translate(camX, camY);

    const margin = Math.max(WORLD.HEX_SIZE * 25, 1500 / zoom);
    const viewRect = {
      left: -centerX / zoom - camX - margin,
      right: (rect.width - centerX) / zoom - camX + margin,
      top: -centerY / zoom - camY - margin,
      bottom: (rect.height - centerY) / zoom - camY + margin,
    };

    const activeOverlays = overlaysRef.current;

    hexesRef.current.forEach(hex => {
      const pixel = hexToPixel(hex.coordinates.q, hex.coordinates.r, WORLD.HEX_SIZE);

      if (
        pixel.x < viewRect.left ||
        pixel.x > viewRect.right ||
        pixel.y < viewRect.top ||
        pixel.y > viewRect.bottom
      ) {
        return;
      }

      const isHovered = hoveredHexIdRef.current === hex.id;
      const liveHex = computeHexState(hex, activeOverlays);
      drawTerrainHex(ctx, liveHex, pixel.x, pixel.y, LOD, pathCache[liveHex.terrain] ?? null, isHovered, zoom);
    });

    // Render Planar Overlay Gizmos
    if (showGizmos) {
      activeOverlays.forEach(overlay => {
        const pixel = hexToPixel(overlay.coordinates.q, overlay.coordinates.r, WORLD.HEX_SIZE);
        const color = PLANAR_COLORS[overlay.type];

        ctx.beginPath();
        ctx.arc(pixel.x, pixel.y, WORLD.HEX_SIZE, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.strokeStyle = 'white';
        ctx.lineWidth = 2 / zoom;
        ctx.stroke();

        ctx.fillStyle = 'white';
        ctx.font = `bold ${WORLD.HEX_SIZE * 0.5}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(overlay.type.substring(9, 11).toUpperCase(), pixel.x, pixel.y);

        const radiusPx = overlay.radius * WORLD.HEX_SIZE * RENDER.HEX_SQRT3;
        ctx.beginPath();
        ctx.arc(pixel.x, pixel.y, radiusPx, 0, Math.PI * 2);
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
  }, [pathCache, camera, showGizmos]);

  useEffect(() => {
    const loop = () => {
      render();
      animationRef.current = requestAnimationFrame(loop);
    };
    animationRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animationRef.current);
  }, [render]);

  return (
    <div ref={containerRef} className="w-full h-full cursor-default bg-slate-950">
      <canvas
        ref={canvasRef}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onWheel={handleWheel}
        onClick={handleClick}
        className="block w-full h-full"
      />
    </div>
  );
};
