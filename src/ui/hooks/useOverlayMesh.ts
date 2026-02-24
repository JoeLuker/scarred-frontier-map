/**
 * Generic overlay mesh hook — reusable reactive pipeline for any planar overlay
 * that needs GPU readback → CPU mesh build → GPU upload.
 *
 * Handles:
 *   - Filtering overlays by plane type
 *   - Two-tier cache keying (fullKey for mesh rebuild, shapeKey for readback)
 *   - Async readback busy guard with pending queue
 *   - Build + upload on readback completion
 *   - Visibility management
 *
 * Each planar overlay type (Air, Fire, Water, Earth, ...) provides its own
 * OverlayMeshConfig with plane-specific readback, mesh building, and key logic.
 */

import { useRef, useEffect } from 'react';
import type { HexData, PlanarAlignment, PlanarOverlay, WorldGenConfig } from '../../core/types';

export interface OverlayMeshConfig<TReadback> {
  /** Which plane type to filter for */
  readonly planeType: PlanarAlignment;

  /** Are all GPU resources ready? (refs populated, scene objects registered) */
  isReady(): boolean;

  /** Async readback from GPU classify pipeline */
  readback(): Promise<TReadback>;

  /** Build meshes from readback data + upload to GPU buffers + set visibility */
  buildAndUpload(
    readback: TReadback,
    overlays: PlanarOverlay[],
    worldConfig: WorldGenConfig,
    hexes: HexData[],
  ): void;

  /** Hide all scene objects managed by this plane */
  hide(): void;

  /** Show scene objects (cache-hit path — meshes already built) */
  show(): void;

  /** Full cache key: every parameter that affects the final mesh geometry */
  fullKey(overlays: PlanarOverlay[], worldConfig: WorldGenConfig): string;

  /** Shape cache key: only parameters that affect the classify/readback output.
   *  When shapeKey is unchanged, the cached readback is reused (skip GPU readback). */
  shapeKey(overlays: PlanarOverlay[], worldConfig: WorldGenConfig): string;
}

export function useOverlayMesh<TReadback>(
  planarOverlays: PlanarOverlay[],
  worldConfig: WorldGenConfig,
  hexes: HexData[],
  config: OverlayMeshConfig<TReadback>,
): void {
  const fullKeyRef = useRef('');
  const shapeKeyRef = useRef('');
  const cachedReadbackRef = useRef<TReadback | null>(null);
  const guardRef = useRef({ busy: false, pending: null as (() => void) | null });

  useEffect(() => {
    if (!config.isReady()) return;

    const overlays = planarOverlays.filter(o => o.type === config.planeType);
    if (overlays.length === 0) {
      config.hide();
      fullKeyRef.current = '';
      shapeKeyRef.current = '';
      cachedReadbackRef.current = null;
      return;
    }

    const fk = config.fullKey(overlays, worldConfig);
    if (fk === fullKeyRef.current) {
      config.show();
      return;
    }
    fullKeyRef.current = fk;

    const sk = config.shapeKey(overlays, worldConfig);
    const needsReadback = sk !== shapeKeyRef.current;
    shapeKeyRef.current = sk;

    let cancelled = false;

    function onReadback(readback: TReadback) {
      if (cancelled) return;
      cachedReadbackRef.current = readback;
      config.buildAndUpload(readback, overlays, worldConfig, hexes);
    }

    if (!needsReadback && cachedReadbackRef.current) {
      onReadback(cachedReadbackRef.current);
      return;
    }

    // Shape changed — need fresh readback from GPU.
    const guard = guardRef.current;
    function doReadback() {
      if (cancelled) return;
      if (guard.busy) {
        guard.pending = doReadback;
        return;
      }
      guard.busy = true;
      guard.pending = null;

      config.readback().then(data => {
        guard.busy = false;
        onReadback(data);
        if (guard.pending) {
          const fn = guard.pending;
          guard.pending = null;
          fn();
        }
      }).catch(() => {
        guard.busy = false;
        if (guard.pending) {
          const fn = guard.pending;
          guard.pending = null;
          fn();
        }
      });
    }

    doReadback();

    return () => { cancelled = true; };
  }, [planarOverlays, worldConfig, hexes]);
}
