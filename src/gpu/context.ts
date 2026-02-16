import { GpuContext } from './types';

/**
 * Initialize WebGPU. Returns null when unsupported or unavailable.
 * The caller should fall back to Canvas 2D rendering / CPU compute.
 */
async function initWebGPUInternal(): Promise<GpuContext | null> {
  if (typeof navigator === 'undefined' || !navigator.gpu) {
    console.warn('WebGPU not supported in this browser');
    return null;
  }

  const adapter = await navigator.gpu.requestAdapter({
    powerPreference: 'high-performance',
  });
  if (!adapter) {
    console.warn('WebGPU adapter not available');
    return null;
  }

  const device = await adapter.requestDevice();

  device.lost.then((info) => {
    console.error(`WebGPU device lost (${info.reason}): ${info.message}`);
  });

  return { adapter, device };
}

// Singleton: both TerrainRenderer and TerrainCompute share the same device.
let cachedPromise: Promise<GpuContext | null> | null = null;

export function getGpuContext(): Promise<GpuContext | null> {
  if (!cachedPromise) {
    cachedPromise = initWebGPUInternal();
  }
  return cachedPromise;
}

// Legacy alias for existing call sites
export const initWebGPU = getGpuContext;
