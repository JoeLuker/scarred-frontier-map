import { useRef, useCallback, useEffect, type RefObject } from 'react';
import { RENDER } from '../../core/config';

const ISO_TILT = RENDER.ISO_TILT;

interface CameraState {
  x: number;
  y: number;
  zoom: number;
}

export const useCamera = (
  canvasRef: RefObject<HTMLCanvasElement | null>,
  containerRef: RefObject<HTMLDivElement | null>,
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

    if (isDragging.current) {
      const dx = e.clientX - lastMouse.current.x;
      const dy = e.clientY - lastMouse.current.y;
      totalDragDistance.current += Math.abs(dx) + Math.abs(dy);

      camera.current.x += dx / camera.current.zoom;
      camera.current.y += dy / (camera.current.zoom * ISO_TILT);

      lastMouse.current = { x: e.clientX, y: e.clientY };
    }

    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    const centerX = rect.width / 2;
    const centerY = rect.height / 2;
    const cam = camera.current;

    const worldX = (mouseX - centerX) / cam.zoom - cam.x;
    const worldY = (mouseY - centerY) / (cam.zoom * ISO_TILT) - cam.y;

    return { worldX, worldY, isDragging: isDragging.current };
  }, [containerRef]);

  const handleMouseUp = useCallback(() => {
    isDragging.current = false;
    if (canvasRef.current) canvasRef.current.style.cursor = 'default';
  }, [canvasRef]);

  const handleWheelRef = useRef<(e: WheelEvent) => void>(() => {});
  handleWheelRef.current = (e: WheelEvent) => {
    e.preventDefault();
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const direction = e.deltaY > 0 ? -1 : 1;
    const factor = direction > 0 ? RENDER.ZOOM_SCALE_FACTOR : 1 / RENDER.ZOOM_SCALE_FACTOR;

    const newZoom = Math.max(RENDER.ZOOM_MIN, Math.min(RENDER.ZOOM_MAX, camera.current.zoom * factor));

    const centerX = rect.width / 2;
    const centerY = rect.height / 2;
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const M = { x: mouseX, y: mouseY };
    const C = { x: centerX, y: centerY };
    const Cam1 = { x: camera.current.x, y: camera.current.y };
    const Z1 = camera.current.zoom;
    const Z2 = newZoom;

    // World point under cursor (inverse of isometric projection)
    const W = {
      x: (M.x - C.x) / Z1 - Cam1.x,
      y: (M.y - C.y) / (Z1 * ISO_TILT) - Cam1.y,
    };

    // New camera offset to keep W under cursor at new zoom
    const Cam2 = {
      x: (M.x - C.x) / Z2 - W.x,
      y: (M.y - C.y) / (Z2 * ISO_TILT) - W.y,
    };

    camera.current.zoom = newZoom;
    camera.current.x = Cam2.x;
    camera.current.y = Cam2.y;
  };

  // Attach wheel listener with { passive: false } to allow preventDefault
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const onWheel = (e: WheelEvent) => handleWheelRef.current(e);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [canvasRef]);

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
    setCamera,
  };
};
