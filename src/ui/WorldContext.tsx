import React, {
  createContext,
  useContext,
  useRef,
  useState,
  useEffect,
  useSyncExternalStore,
  useCallback,
  type ReactNode,
} from 'react';
import { World } from '../ecs/World';
import { CAMERA } from '../core/constants';

const WorldContext = createContext<World | null>(null);

export function WorldProvider({ children }: { children: ReactNode }) {
  const worldRef = useRef<World | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let animFrame = 0;

    (async () => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      const adapter = await navigator.gpu?.requestAdapter();
      if (!adapter || cancelled) return;
      const device = await adapter.requestDevice();
      if (cancelled) { device.destroy(); return; }

      const world = await World.create(device, canvas);
      if (cancelled) { world.destroy(); return; }
      worldRef.current = world;

      // --- Camera controls ---
      const keysDown = new Set<string>();
      let isDragging = false;
      let lastX = 0, lastY = 0;

      const onKeyDown = (e: KeyboardEvent) => {
        keysDown.add(e.key.toLowerCase());
      };
      const onKeyUp = (e: KeyboardEvent) => {
        keysDown.delete(e.key.toLowerCase());
      };

      const onMouseDown = (e: MouseEvent) => {
        isDragging = true;
        lastX = e.clientX;
        lastY = e.clientY;
        canvas.style.cursor = 'grabbing';
      };

      const onMouseMove = (e: MouseEvent) => {
        if (!isDragging) return;
        const dx = e.clientX - lastX;
        const dy = e.clientY - lastY;
        lastX = e.clientX;
        lastY = e.clientY;

        const cam = world.camera;
        if (e.shiftKey || e.buttons === 4) {
          // Pan: shift+drag or middle-click drag
          const speed = cam.distance * CAMERA.PAN_SPEED;
          const cosAz = Math.cos(cam.azimuth);
          const sinAz = Math.sin(cam.azimuth);
          cam.targetX -= (dx * cosAz + dy * sinAz) * speed;
          cam.targetZ -= (-dx * sinAz + dy * cosAz) * speed;
        } else {
          // Orbit
          cam.azimuth -= dx * CAMERA.ORBIT_SPEED;
          cam.elevation += dy * CAMERA.ORBIT_SPEED;
          cam.elevation = Math.max(CAMERA.ELEVATION_MIN, Math.min(Math.PI / 2 - 0.01, cam.elevation));
        }
      };

      const onMouseUp = () => {
        isDragging = false;
        canvas.style.cursor = 'default';
      };

      const onWheel = (e: WheelEvent) => {
        e.preventDefault();
        const cam = world.camera;

        if (e.ctrlKey) {
          // Pinch-to-zoom
          const factor = 1 + Math.min(Math.abs(e.deltaY) * 0.01, 0.15);
          cam.distance *= e.deltaY > 0 ? factor : 1 / factor;
        } else {
          // Scroll = zoom
          cam.distance *= e.deltaY > 0 ? CAMERA.ZOOM_FACTOR : 1 / CAMERA.ZOOM_FACTOR;
        }
        cam.distance = Math.max(CAMERA.ZOOM_MIN, Math.min(CAMERA.ZOOM_MAX, cam.distance));
      };

      window.addEventListener('keydown', onKeyDown);
      window.addEventListener('keyup', onKeyUp);
      canvas.addEventListener('mousedown', onMouseDown);
      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
      canvas.addEventListener('wheel', onWheel, { passive: false });

      // rAF loop
      let prev = performance.now();
      const loop = () => {
        const now = performance.now();
        const dt = Math.min((now - prev) / 1000, 0.1);
        prev = now;

        // WASD camera movement
        if (keysDown.size > 0) {
          const cam = world.camera;
          const speed = cam.distance * 0.012 * (dt / (1 / 60));
          const cosAz = Math.cos(cam.azimuth);
          const sinAz = Math.sin(cam.azimuth);
          if (keysDown.has('w')) { cam.targetX -= sinAz * speed; cam.targetZ -= cosAz * speed; }
          if (keysDown.has('s')) { cam.targetX += sinAz * speed; cam.targetZ += cosAz * speed; }
          if (keysDown.has('a')) { cam.targetX -= cosAz * speed; cam.targetZ += sinAz * speed; }
          if (keysDown.has('d')) { cam.targetX += cosAz * speed; cam.targetZ -= sinAz * speed; }
          if (keysDown.has('q')) { cam.azimuth -= 0.03 * (dt / (1 / 60)); }
          if (keysDown.has('e')) { cam.azimuth += 0.03 * (dt / (1 / 60)); }
        }

        world.tick(dt);
        animFrame = requestAnimationFrame(loop);
      };
      animFrame = requestAnimationFrame(loop);
      setReady(true);

      // Cleanup
      const cleanup = () => {
        window.removeEventListener('keydown', onKeyDown);
        window.removeEventListener('keyup', onKeyUp);
        canvas.removeEventListener('mousedown', onMouseDown);
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
        canvas.removeEventListener('wheel', onWheel);
      };
      // Store cleanup for the effect teardown
      (world as any)._inputCleanup = cleanup;
    })();

    return () => {
      cancelled = true;
      cancelAnimationFrame(animFrame);
      const w = worldRef.current;
      if (w) {
        (w as any)._inputCleanup?.();
        w.destroy();
      }
      worldRef.current = null;
    };
  }, []);

  return (
    <>
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full"
        style={{ touchAction: 'none' }}
        tabIndex={0}
      />
      {ready && worldRef.current && (
        <WorldContext.Provider value={worldRef.current}>
          {children}
        </WorldContext.Provider>
      )}
    </>
  );
}

export function useWorld(): World {
  const world = useContext(WorldContext);
  if (!world) throw new Error('useWorld must be used within WorldProvider');
  return world;
}

export function useWorldStore<T>(selector: (world: World) => T): T {
  const world = useWorld();
  return useSyncExternalStore(
    useCallback((cb: () => void) => world.subscribe(cb), [world]),
    () => selector(world),
  );
}
