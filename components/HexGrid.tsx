
import React, { useRef, useEffect, useCallback, useMemo } from 'react';
import { HexData, PlanarOverlay } from '../types';
import { MAP_CONFIG } from '../constants';
import { TERRAIN_PATHS, PLANAR_COLORS } from '../theme';
import { hexToPixel, pixelToHex, getSectorRadius } from '../services/geometry';
import { drawSectorPlaceholder, drawTerrainHex, drawHexPath } from '../services/renderUtils';
import { computeHexState } from '../services/planar';
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
    showGizmos
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const animationRef = useRef<number>(0);
  const hexesRef = useRef(hexes);
  const overlaysRef = useRef(planarOverlays);
  
  const hoveredHexIdRef = useRef<string | null>(null);
  const draggingOverlayIdRef = useRef<string | null>(null);

  // Use the new Camera Hook
  const { 
      camera, 
      totalDragDistance, 
      handleMouseDown: onCamDown, 
      handleMouseMove: onCamMove, 
      handleMouseUp: onCamUp, 
      handleWheel,
      setCamera
  } = useCamera(canvasRef, containerRef);

  useEffect(() => {
    hexesRef.current = hexes;
  }, [hexes]);

  useEffect(() => {
    overlaysRef.current = planarOverlays;
  }, [planarOverlays]);

  // Cache paths
  const pathCache = useMemo(() => {
    const cache: Record<string, Path2D> = {};
    Object.entries(TERRAIN_PATHS).forEach(([key, d]) => {
      cache[key] = new Path2D(d);
    });
    return cache;
  }, []);

  // Handle Camera Focus
  useEffect(() => {
    if (focusedHex && containerRef.current) {
        const pixel = hexToPixel(focusedHex.coordinates.x, focusedHex.coordinates.y);
        setCamera(-pixel.x, -pixel.y, 1.0);
    }
  }, [focusedHex, setCamera]);

  // --- MOUSE HANDLERS FOR DRAGGING PLANES ---

  const handleMouseDown = (e: React.MouseEvent) => {
      // 1. Check if clicking on an overlay handle (Only if gizmos visible)
      if (showGizmos) {
          const result = onCamMove(e); // Get world coords without moving logic
          if (result) {
              const { worldX, worldY } = result;

              // Check overlay handles (simple circle distance check)
              const handleRadius = MAP_CONFIG.HEX_SIZE * 1.5; // Hitbox size
              
              const clickedOverlay = overlaysRef.current.find(o => {
                  const pixel = hexToPixel(o.coordinates.x, o.coordinates.y);
                  const dist = Math.sqrt(Math.pow(worldX - pixel.x, 2) + Math.pow(worldY - pixel.y, 2));
                  return dist < handleRadius;
              });

              if (clickedOverlay) {
                  draggingOverlayIdRef.current = clickedOverlay.id;
                  if (canvasRef.current) canvasRef.current.style.cursor = 'move';
                  return; // Stop propagation to camera
              }
          }
      }

      // 2. Fallback to Camera Pan
      onCamDown(e);
  };

  const handleMouseMove = (e: React.MouseEvent) => {
      // Dragging an overlay?
      if (draggingOverlayIdRef.current && showGizmos) {
          const result = onCamMove(e); // Just get coords
          if (result) {
               const hexCoords = pixelToHex(result.worldX, result.worldY);
               // Update local ref for smooth rendering
               const target = overlaysRef.current.find(o => o.id === draggingOverlayIdRef.current);
               if (target) {
                   // Only update if hex changed
                   if (target.coordinates.x !== hexCoords.q || target.coordinates.y !== hexCoords.r) {
                       target.coordinates = { x: hexCoords.q, y: hexCoords.r };
                       onModifyOverlay({...target}); // Trigger react state update
                   }
               }
          }
          return;
      }

      // Camera logic + Hex Hover
      const result = onCamMove(e);
      if (!result || result.isDragging) return;

      const { worldX, worldY } = result;

      // Check Terrain Hexes (Exact)
      const hexCoords = pixelToHex(worldX, worldY);
      const exactHex = hexesRef.current.find(h => 
          !h.isSectorPlaceholder && 
          h.coordinates.x === hexCoords.q && 
          h.coordinates.y === hexCoords.r
      );
  
      if (exactHex) {
         hoveredHexIdRef.current = exactHex.id;
         return;
      }
  
      // Check Placeholders (Proximity)
      const sectorVisualRadius = getSectorRadius();
      const hoveredPlaceholder = hexesRef.current.find(h => {
          if (!h.isSectorPlaceholder) return false;
          const pPixel = hexToPixel(h.coordinates.x, h.coordinates.y);
          const dist = Math.sqrt(Math.pow(worldX - pPixel.x, 2) + Math.pow(worldY - pPixel.y, 2));
          return dist < sectorVisualRadius * 0.866; 
      });
  
      hoveredHexIdRef.current = hoveredPlaceholder ? hoveredPlaceholder.id : null;
  };

  const handleMouseUp = () => {
      if (draggingOverlayIdRef.current) {
          // Finished Dragging -> Save History Point
          onCommitOverlay();
          draggingOverlayIdRef.current = null;
          if (canvasRef.current) canvasRef.current.style.cursor = 'default';
          return;
      }
      onCamUp();
  };

  const handleClick = () => {
    if (draggingOverlayIdRef.current) return;
    if (totalDragDistance.current > 5) return; 
    
    if (hoveredHexIdRef.current) {
        const target = hexesRef.current.find(h => h.id === hoveredHexIdRef.current);
        if (target) onHexClick(target);
    }
  };

  // --- RENDERER ---

  const render = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = container.getBoundingClientRect();
    
    // Resize handling
    if (canvas.width !== rect.width * dpr || canvas.height !== rect.height * dpr) {
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
        ctx.scale(dpr, dpr);
    }

    // --- LOD SETTINGS ---
    const zoom = camera.current.zoom;
    const LOD = {
        showIcons: zoom > 0.6,
        showCoords: zoom > 1.5,
        showFogText: zoom > 0.35,
        simpleFog: zoom < 0.20,
        strokeWidth: Math.max(0.5, 1 / zoom)
    };

    // Clear
    ctx.fillStyle = "#020617"; // Slate 950
    ctx.fillRect(0, 0, rect.width, rect.height);

    const { x: camX, y: camY } = camera.current;
    const centerX = rect.width / 2;
    const centerY = rect.height / 2;

    ctx.save();
    ctx.translate(centerX, centerY); 
    ctx.scale(zoom, zoom);
    ctx.translate(camX, camY);

    // Viewport culling bounds
    const margin = Math.max(MAP_CONFIG.HEX_SIZE * 25, 1500 / zoom); 
    const viewRect = {
        left: -centerX / zoom - camX - margin,
        right: (rect.width - centerX) / zoom - camX + margin,
        top: -centerY / zoom - camY - margin,
        bottom: (rect.height - centerY) / zoom - camY + margin
    };

    // 1. Render Hexes
    const activeOverlays = overlaysRef.current;

    hexesRef.current.forEach(hex => {
        const pixel = hexToPixel(hex.coordinates.x, hex.coordinates.y);
        
        if (
            pixel.x < viewRect.left || 
            pixel.x > viewRect.right || 
            pixel.y < viewRect.top || 
            pixel.y > viewRect.bottom
        ) {
            return;
        }

        const isHovered = hoveredHexIdRef.current === hex.id;

        if (hex.isSectorPlaceholder) {
            drawSectorPlaceholder(ctx, hex, pixel.x, pixel.y, LOD, isHovered);
        } else {
            const liveHex = computeHexState(hex, activeOverlays);
            drawTerrainHex(ctx, liveHex, pixel.x, pixel.y, LOD, pathCache[liveHex.terrain], isHovered, zoom);
        }
    });

    // 2. Render Planar Overlays (Gizmos) - ONLY IF ENABLED
    if (showGizmos) {
        activeOverlays.forEach(overlay => {
            const pixel = hexToPixel(overlay.coordinates.x, overlay.coordinates.y);
            const color = PLANAR_COLORS[overlay.type];
            
            // Draw Center Handle
            ctx.beginPath();
            ctx.arc(pixel.x, pixel.y, MAP_CONFIG.HEX_SIZE, 0, Math.PI * 2);
            ctx.fillStyle = color;
            ctx.fill();
            ctx.strokeStyle = "white";
            ctx.lineWidth = 2 / zoom;
            ctx.stroke();

            // Icon/Text in Handle
            ctx.fillStyle = "white";
            ctx.font = `bold ${MAP_CONFIG.HEX_SIZE * 0.5}px sans-serif`;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(overlay.type.substring(9, 11).toUpperCase(), pixel.x, pixel.y);

            // Optional: Draw a very faint ring to show the logical size, but nice and thin
            const radiusPx = overlay.radius * MAP_CONFIG.HEX_SIZE * 1.732; 
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
