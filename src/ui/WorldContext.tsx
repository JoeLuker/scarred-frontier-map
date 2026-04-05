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

// --- Context ---

const WorldContext = createContext<World | null>(null);

// --- Provider: owns World lifecycle + rAF loop ---

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

      // Init WebGPU
      const adapter = await navigator.gpu?.requestAdapter();
      if (!adapter || cancelled) return;
      const device = await adapter.requestDevice();
      if (cancelled) { device.destroy(); return; }

      // Configure canvas
      const format = navigator.gpu.getPreferredCanvasFormat();
      const ctx = canvas.getContext('webgpu');
      if (!ctx || cancelled) { device.destroy(); return; }
      ctx.configure({ device, format, alphaMode: 'opaque' });

      // Create world
      const world = await World.create(device);
      if (cancelled) { world.destroy(); return; }
      worldRef.current = world;
      setReady(true);

      console.log(`World created: ${world.hexes.hexCount} hexes, sim field ${world.simField.config.width}×${world.simField.config.height}`);

      // rAF loop
      let prev = performance.now();
      const loop = () => {
        const now = performance.now();
        const dt = Math.min((now - prev) / 1000, 0.1); // cap at 100ms
        prev = now;
        world.tick(dt);
        animFrame = requestAnimationFrame(loop);
      };
      animFrame = requestAnimationFrame(loop);
    })();

    return () => {
      cancelled = true;
      cancelAnimationFrame(animFrame);
      worldRef.current?.destroy();
      worldRef.current = null;
    };
  }, []);

  return (
    <>
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full"
        style={{ touchAction: 'none' }}
      />
      {ready && worldRef.current && (
        <WorldContext.Provider value={worldRef.current}>
          {children}
        </WorldContext.Provider>
      )}
    </>
  );
}

// --- Hooks ---

export function useWorld(): World {
  const world = useContext(WorldContext);
  if (!world) throw new Error('useWorld must be used within WorldProvider');
  return world;
}

/**
 * Subscribe to World state changes. Selector is called on every version bump.
 * Only re-renders when the selected value changes (by reference).
 */
export function useWorldStore<T>(selector: (world: World) => T): T {
  const world = useWorld();
  return useSyncExternalStore(
    useCallback((cb: () => void) => world.subscribe(cb), [world]),
    () => selector(world),
  );
}
