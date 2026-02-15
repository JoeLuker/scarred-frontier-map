import { useRef, useCallback, useEffect, type RefObject } from 'react';
import { CAMERA } from '../../core/config';
import type { OrbitalCamera } from '../../gpu';
import { getViewProjection, screenToGround } from '../../gpu';

export const useCamera = (
  canvasRef: RefObject<HTMLCanvasElement | null>,
  containerRef: RefObject<HTMLDivElement | null>,
) => {
  const camera = useRef<OrbitalCamera>({
    azimuth: CAMERA.DEFAULT_AZIMUTH,
    elevation: CAMERA.DEFAULT_ELEVATION,
    distance: CAMERA.DEFAULT_DISTANCE,
    targetX: 0,
    targetZ: 0,
  });

  const isDragging = useRef(false);
  const isOrbiting = useRef(false);
  const lastMouse = useRef({ x: 0, y: 0 });
  const totalDragDistance = useRef(0);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button === 2) {
      // Right-click: orbit
      isOrbiting.current = true;
    } else {
      // Left-click: pan
      isDragging.current = true;
    }
    lastMouse.current = { x: e.clientX, y: e.clientY };
    totalDragDistance.current = 0;
    if (canvasRef.current) canvasRef.current.style.cursor = 'grabbing';
  }, [canvasRef]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return null;

    const dx = e.clientX - lastMouse.current.x;
    const dy = e.clientY - lastMouse.current.y;

    if (isOrbiting.current) {
      totalDragDistance.current += Math.abs(dx) + Math.abs(dy);
      const cam = camera.current;
      cam.azimuth -= dx * CAMERA.ORBIT_SPEED;
      cam.elevation = Math.max(0.1, Math.min(Math.PI / 2 - 0.01,
        cam.elevation + dy * CAMERA.ORBIT_SPEED));
      lastMouse.current = { x: e.clientX, y: e.clientY };
      return null; // No world position during orbit
    }

    if (isDragging.current) {
      totalDragDistance.current += Math.abs(dx) + Math.abs(dy);
      const cam = camera.current;
      const panSpeed = cam.distance * CAMERA.PAN_SPEED;

      // Pan on ground plane relative to camera orientation
      const cosAz = Math.cos(cam.azimuth);
      const sinAz = Math.sin(cam.azimuth);
      cam.targetX -= (cosAz * dx - sinAz * dy) * panSpeed;
      cam.targetZ -= (-sinAz * dx - cosAz * dy) * panSpeed;

      lastMouse.current = { x: e.clientX, y: e.clientY };
    }

    // Raycast mouse to ground plane for hover detection
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    const hit = screenToGround(
      mouseX, mouseY, rect.width, rect.height,
      camera.current, CAMERA.FOV, rect.width / rect.height,
    );

    if (!hit) return null;

    return {
      worldX: hit.x,
      worldY: hit.z, // hex Y = world Z
      isDragging: isDragging.current || isOrbiting.current,
    };
  }, [containerRef]);

  const handleMouseUp = useCallback(() => {
    isDragging.current = false;
    isOrbiting.current = false;
    if (canvasRef.current) canvasRef.current.style.cursor = 'default';
  }, [canvasRef]);

  // Prevent context menu on right-click (used for orbit)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onContext = (e: Event) => e.preventDefault();
    canvas.addEventListener('contextmenu', onContext);
    return () => canvas.removeEventListener('contextmenu', onContext);
  }, [canvasRef]);

  // Scroll = zoom
  const handleWheelRef = useRef<(e: WheelEvent) => void>(() => {});
  handleWheelRef.current = (e: WheelEvent) => {
    e.preventDefault();
    const factor = e.deltaY > 0 ? CAMERA.ZOOM_FACTOR : 1 / CAMERA.ZOOM_FACTOR;
    camera.current.distance = Math.max(CAMERA.ZOOM_MIN, Math.min(CAMERA.ZOOM_MAX,
      camera.current.distance * factor));
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => handleWheelRef.current(e);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [canvasRef]);

  /** Compute the current view-projection matrix for the given aspect ratio. */
  const computeViewProjection = useCallback((aspect: number): Float32Array => {
    return getViewProjection(camera.current, CAMERA.FOV, aspect, CAMERA.NEAR, CAMERA.FAR);
  }, []);

  const setCamera = useCallback((targetX: number, targetZ: number, distance?: number) => {
    camera.current.targetX = targetX;
    camera.current.targetZ = targetZ;
    if (distance !== undefined) camera.current.distance = distance;
  }, []);

  return {
    camera,
    totalDragDistance,
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
    computeViewProjection,
    setCamera,
  };
};
