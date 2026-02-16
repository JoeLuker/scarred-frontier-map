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
  const lastMouse = useRef({ x: 0, y: 0 });
  const totalDragDistance = useRef(0);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    // All mouse buttons = pan (orbit is handled by trackpad scroll)
    isDragging.current = true;
    lastMouse.current = { x: e.clientX, y: e.clientY };
    totalDragDistance.current = 0;
    if (canvasRef.current) canvasRef.current.style.cursor = 'grabbing';
  }, [canvasRef]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return null;

    const dx = e.clientX - lastMouse.current.x;
    const dy = e.clientY - lastMouse.current.y;

    if (isDragging.current) {
      totalDragDistance.current += Math.abs(dx) + Math.abs(dy);
      const cam = camera.current;
      const panSpeed = cam.distance * CAMERA.PAN_SPEED;

      // Pan on ground plane relative to camera orientation
      const cosAz = Math.cos(cam.azimuth);
      const sinAz = Math.sin(cam.azimuth);
      cam.targetX -= (cosAz * dx + sinAz * dy) * panSpeed;
      cam.targetZ -= (-sinAz * dx + cosAz * dy) * panSpeed;

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
      isDragging: isDragging.current,
    };
  }, [containerRef]);

  const handleMouseUp = useCallback(() => {
    isDragging.current = false;
    if (canvasRef.current) canvasRef.current.style.cursor = 'default';
  }, [canvasRef]);

  // Wheel: pinch (ctrlKey) = zoom, two-finger scroll = orbit
  const handleWheelRef = useRef<(e: WheelEvent) => void>(() => {});
  handleWheelRef.current = (e: WheelEvent) => {
    e.preventDefault();
    const cam = camera.current;

    if (e.ctrlKey) {
      // Pinch-to-zoom (trackpad pinch sends ctrlKey + deltaY)
      // deltaY is inverted and much smaller for pinch vs discrete scroll
      const zoomSpeed = 1 + Math.min(Math.abs(e.deltaY) * 0.01, 0.15);
      const factor = e.deltaY > 0 ? zoomSpeed : 1 / zoomSpeed;
      cam.distance = Math.max(CAMERA.ZOOM_MIN, Math.min(CAMERA.ZOOM_MAX,
        cam.distance * factor));
    } else {
      // Two-finger scroll = orbit (deltaX → azimuth, deltaY → elevation)
      cam.azimuth -= e.deltaX * CAMERA.ORBIT_SPEED * 0.3;
      cam.elevation = Math.max(0.1, Math.min(Math.PI / 2 - 0.01,
        cam.elevation + e.deltaY * CAMERA.ORBIT_SPEED * 0.3));
    }
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
