
import React, { useRef, useCallback } from 'react';

interface CameraState {
  x: number;
  y: number;
  zoom: number;
}

export const useCamera = (
    canvasRef: React.RefObject<HTMLCanvasElement>, 
    containerRef: React.RefObject<HTMLDivElement>
) => {
  const camera = useRef<CameraState>({ x: 0, y: 0, zoom: 0.5 });
  const isDragging = useRef(false);
  const lastMouse = useRef({ x: 0, y: 0 });
  const totalDragDistance = useRef(0);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    isDragging.current = true;
    lastMouse.current = { x: e.clientX, y: e.clientY };
    totalDragDistance.current = 0;
    if (canvasRef.current) canvasRef.current.style.cursor = 'grabbing';
  }, [canvasRef]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return null;
    
    // Pan
    if (isDragging.current) {
        const dx = e.clientX - lastMouse.current.x;
        const dy = e.clientY - lastMouse.current.y;
        totalDragDistance.current += Math.abs(dx) + Math.abs(dy);
        
        camera.current.x += dx / camera.current.zoom;
        camera.current.y += dy / camera.current.zoom;
        
        lastMouse.current = { x: e.clientX, y: e.clientY };
    }

    // Return World Coordinates for external hover logic
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    const centerX = rect.width / 2;
    const centerY = rect.height / 2;
    const cam = camera.current;
    
    const worldX = (mouseX - centerX) / cam.zoom - cam.x;
    const worldY = (mouseY - centerY) / cam.zoom - cam.y;

    return { worldX, worldY, isDragging: isDragging.current };
  }, [containerRef]);

  const handleMouseUp = useCallback(() => {
    isDragging.current = false;
    if (canvasRef.current) canvasRef.current.style.cursor = 'default';
  }, [canvasRef]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const scaleFactor = 1.1;
    const direction = e.deltaY > 0 ? -1 : 1;
    const factor = direction > 0 ? scaleFactor : 1 / scaleFactor;
    
    const newZoom = Math.max(0.05, Math.min(3.0, camera.current.zoom * factor));
    
    const centerX = rect.width / 2;
    const centerY = rect.height / 2;
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const M = { x: mouseX, y: mouseY };
    const C = { x: centerX, y: centerY };
    const Cam1 = { x: camera.current.x, y: camera.current.y };
    const Z1 = camera.current.zoom;
    const Z2 = newZoom;

    // Zoom towards mouse pointer math
    const W = {
        x: (M.x - C.x) / Z1 - Cam1.x,
        y: (M.y - C.y) / Z1 - Cam1.y
    };

    const Cam2 = {
        x: (M.x - C.x) / Z2 - W.x,
        y: (M.y - C.y) / Z2 - W.y
    };

    camera.current.zoom = newZoom;
    camera.current.x = Cam2.x;
    camera.current.y = Cam2.y;
  }, [containerRef]);

  const setCamera = useCallback((x: number, y: number, zoom?: number) => {
      camera.current.x = x;
      camera.current.y = y;
      if (zoom !== undefined) camera.current.zoom = zoom;
  }, []);

  return {
      camera,
      totalDragDistance,
      handleMouseDown,
      handleMouseMove,
      handleMouseUp,
      handleWheel,
      setCamera
  };
};
