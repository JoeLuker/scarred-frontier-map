import React, { useRef, useEffect, useCallback } from 'react';
import { HexData, PlanarAlignment, PlanarOverlay, WorldGenConfig, TerrainType } from '../../core/types';
import { WORLD, TERRAIN, CAMERA, MESH, getTerrainRenderParams } from '../../core/config';
import { TERRAIN_COLORS, PLANAR_COLORS } from '../theme';
import { hexToPixel, pixelToHex } from '../../core/geometry';
import { hexToRgb } from './renderUtils';
import { useCamera } from '../hooks/useCamera';
import {
  initWebGPU,
  Scene,
  createTerrainShader,
  createTerrainMaterial,
  createIslandMaterial,
  createSeaMaterial,
  createSkyMaterial,
  TerrainMesh,
  buildTerrainMesh,
  buildIslandMesh,
  computeDisplacedY,
  HexStateTexture,
  MeshCompute,
  IslandCompute,
  worldToScreen,
  getEyePosition,
  screenToGround,
  TERRAIN_ORDER,
  OBJECT_FLAGS,
} from '../../gpu';
import type { TerrainGridData } from '../../gpu';

// ===================================================================
// Pre-computed terrain color array for GPU uniform upload (11 × RGBA)
// Uses TERRAIN_ORDER from gpu/types.ts (single source of truth for ID→type mapping)
// IDs 0-7: base types, 8-10: mutation-only (Magma, Crystal, Floating)
// ===================================================================

function buildTerrainColorArray(): Float32Array {
  const count = TERRAIN_ORDER.length; // 11
  const colors = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const hex = TERRAIN_COLORS[TERRAIN_ORDER[i]!];
    const { r, g, b } = hexToRgb(hex);
    colors[i * 4] = r / 255;
    colors[i * 4 + 1] = g / 255;
    colors[i * 4 + 2] = b / 255;
    colors[i * 4 + 3] = 1.0;
  }
  return colors;
}

const GPU_TERRAIN_COLORS = buildTerrainColorArray();

// ===================================================================
// Component
// ===================================================================

interface HexGridProps {
  hexes: HexData[];
  worldConfig: WorldGenConfig;
  onHexClick: (hex: HexData) => void;
  focusedHex: HexData | null;
  planarOverlays: PlanarOverlay[];
  onModifyOverlay: (overlay: PlanarOverlay) => void;
  onCommitOverlay: () => void;
  showGizmos: boolean;
  showGrid: boolean;
}

export const HexGrid: React.FC<HexGridProps> = ({
  hexes,
  worldConfig,
  onHexClick,
  focusedHex,
  planarOverlays,
  onModifyOverlay,
  onCommitOverlay,
  showGizmos,
  showGrid,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);     // overlay (top)
  const gpuCanvasRef = useRef<HTMLCanvasElement>(null);   // WebGPU canvas (behind)
  const animationRef = useRef<number>(0);
  const hexesRef = useRef(hexes);
  const overlaysRef = useRef(planarOverlays);
  const worldConfigRef = useRef(worldConfig);
  const showGizmosRef = useRef(showGizmos);
  const showGridRef = useRef(showGrid);
  const draggingOverlayIdRef = useRef<string | null>(null);

  // GPU resources
  const sceneRef = useRef<Scene | null>(null);
  const meshRef = useRef<TerrainMesh | null>(null);
  const hexStateRef = useRef<HexStateTexture | null>(null);
  const meshComputeRef = useRef<MeshCompute | null>(null);
  const islandComputeRef = useRef<IslandCompute | null>(null);
  const islandTopMeshRef = useRef<TerrainMesh | null>(null);
  const islandUnderMeshRef = useRef<TerrainMesh | null>(null);
  const seaBufferRef = useRef<GPUBuffer | null>(null);

  // Track what mesh was built for (to know when to rebuild)
  const meshConfigRef = useRef<WorldGenConfig | null>(null);

  // Cached terrain grid data for island mesh builder
  const terrainGridRef = useRef<TerrainGridData | null>(null);

  // Track what hex state was built for
  const hexStateSourceRef = useRef<HexData[] | null>(null);

  // Island mesh rebuild key — serialized Air overlay state
  const islandKeyRef = useRef('');

  // O(1) hex coordinate → array index lookup
  const hexLookupRef = useRef<Map<string, number>>(new Map());
  const hoveredHexIndexRef = useRef(-1);

  // FPS counter
  const fpsRef = useRef({ frames: 0, lastTime: performance.now(), fps: 0 });
  const fpsElRef = useRef<HTMLDivElement>(null);

  const {
    camera,
    totalDragDistance,
    handleMouseDown: onCamDown,
    handleMouseMove: onCamMove,
    handleMouseUp: onCamUp,
    computeViewProjection,
    setCamera,
    tickKeys,
  } = useCamera(canvasRef, containerRef);

  // --- Sync refs + rebuild lookup map when hexes change ---
  useEffect(() => {
    hexesRef.current = hexes;
    const lookup = new Map<string, number>();
    for (let i = 0; i < hexes.length; i++) {
      const h = hexes[i]!;
      lookup.set(`${h.coordinates.q},${h.coordinates.r}`, i);
    }
    hexLookupRef.current = lookup;
    hoveredHexIndexRef.current = -1;
  }, [hexes]);
  useEffect(() => { overlaysRef.current = planarOverlays; }, [planarOverlays]);
  useEffect(() => { worldConfigRef.current = worldConfig; }, [worldConfig]);
  useEffect(() => { showGizmosRef.current = showGizmos; }, [showGizmos]);
  useEffect(() => { showGridRef.current = showGrid; }, [showGrid]);

  // --- GPU Init ---
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const ctx = await initWebGPU();
      if (cancelled || !ctx || !gpuCanvasRef.current) return;
      try {
        const { device } = ctx;
        const scene = Scene.create(device, gpuCanvasRef.current);
        const mesh = TerrainMesh.create(device, 250000);
        const hexState = HexStateTexture.create(device, WORLD.GRID_RADIUS);
        const mc = MeshCompute.create(device, 250000);

        // Create shader + materials
        const shader = device.createShaderModule({ code: createTerrainShader() });
        const terrainMat = createTerrainMaterial(device, shader, scene.format, scene.group0Layout, scene.group1Layout);
        const islandMat = createIslandMaterial(device, shader, scene.format, scene.group0Layout, scene.group1Layout);
        const seaMat = createSeaMaterial(device, shader, scene.format, scene.group0Layout, scene.group1Layout);
        const skyMat = createSkyMaterial(device, shader, scene.format, scene.group0Layout);

        // Sea quad vertex buffer (7 floats/vert: pos_xz, elevation, moisture, normal)
        const SEA_EXTENT = 100000;
        const seaVerts = new Float32Array([
          -SEA_EXTENT, -SEA_EXTENT, 0, 0, 0, 1, 0,
           SEA_EXTENT, -SEA_EXTENT, 0, 0, 0, 1, 0,
          -SEA_EXTENT,  SEA_EXTENT, 0, 0, 0, 1, 0,
          -SEA_EXTENT,  SEA_EXTENT, 0, 0, 0, 1, 0,
           SEA_EXTENT, -SEA_EXTENT, 0, 0, 0, 1, 0,
           SEA_EXTENT,  SEA_EXTENT, 0, 0, 0, 1, 0,
        ]);
        const seaBuffer = device.createBuffer({
          size: seaVerts.byteLength,
          usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(seaBuffer, 0, seaVerts);

        // Set hex state texture (stable reference — data updates via writeTexture)
        scene.setHexStateTexture(hexState.texture);

        // Register scene objects
        scene.addObject('sky', { material: skyMat, drawCount: 3, renderOrder: 0 });
        scene.addObject('terrain', {
          material: terrainMat,
          mesh,
          flags: OBJECT_FLAGS.IS_TERRAIN,
          stencilRef: 1,
          renderOrder: 1,
        });
        scene.addObject('sea', {
          material: seaMat,
          mesh: { vertexBuffer: seaBuffer, vertexCount: 6 },
          flags: OBJECT_FLAGS.IS_SEA,
          stencilRef: 0,
          renderOrder: 4,
        });

        sceneRef.current = scene;
        meshRef.current = mesh;
        hexStateRef.current = hexState;
        meshComputeRef.current = mc;
        seaBufferRef.current = seaBuffer;

        // Island compute + meshes
        const ic = IslandCompute.create(device, hexState.texture, 250000);
        const islandTopMesh = TerrainMesh.create(device, 60000);
        const islandUnderMesh = TerrainMesh.create(device, 80000);

        // Register island scene objects (initially hidden)
        scene.addObject('island-top', {
          material: islandMat,
          mesh: islandTopMesh,
          flags: OBJECT_FLAGS.IS_TERRAIN | OBJECT_FLAGS.IS_ISLAND_LAYER,
          stencilRef: 1,
          renderOrder: 2,
          visible: false,
        });
        scene.addObject('island-under', {
          material: islandMat,
          mesh: islandUnderMesh,
          flags: OBJECT_FLAGS.IS_TERRAIN | OBJECT_FLAGS.IS_ISLAND_UNDERSIDE,
          stencilRef: 1,
          renderOrder: 3,
          visible: false,
        });

        islandComputeRef.current = ic;
        islandTopMeshRef.current = islandTopMesh;
        islandUnderMeshRef.current = islandUnderMesh;

        // Build initial mesh + hex state
        const cfg = worldConfigRef.current;
        const result = await buildTerrainMesh(mc, cfg, WORLD.GRID_RADIUS, WORLD.HEX_SIZE, MESH.VERTEX_SPACING);
        if (cancelled) return;
        mesh.upload(result.mesh);
        terrainGridRef.current = result.grid;
        meshConfigRef.current = cfg;

        hexState.update(hexesRef.current);
        hexStateSourceRef.current = hexesRef.current;

        console.log(`Scene graph initialized (${result.mesh.vertexCount} verts, ${result.mesh.indexCount / 3} tris)`);
      } catch (err) {
        console.warn('Scene init failed:', err);
      }
    })();
    return () => {
      cancelled = true;
      sceneRef.current?.destroy();
      sceneRef.current = null;
      meshRef.current?.destroy();
      meshRef.current = null;
      hexStateRef.current?.destroy();
      hexStateRef.current = null;
      meshComputeRef.current?.destroy();
      meshComputeRef.current = null;
      islandComputeRef.current?.destroy();
      islandComputeRef.current = null;
      islandTopMeshRef.current?.destroy();
      islandTopMeshRef.current = null;
      islandUnderMeshRef.current?.destroy();
      islandUnderMeshRef.current = null;
      seaBufferRef.current?.destroy();
      seaBufferRef.current = null;
      terrainGridRef.current = null;
    };
  }, []);

  // --- Rebuild terrain mesh when world config changes ---
  useEffect(() => {
    const mesh = meshRef.current;
    const mc = meshComputeRef.current;
    if (!mesh || !mc) return;

    // Skip if config hasn't changed (same reference = same config)
    if (meshConfigRef.current === worldConfig) return;
    meshConfigRef.current = worldConfig;

    // Build mesh asynchronously (GPU compute for elevation+moisture)
    const cfg = worldConfig;
    let cancelled = false;
    requestIdleCallback(() => {
      buildTerrainMesh(mc, cfg, WORLD.GRID_RADIUS, WORLD.HEX_SIZE, MESH.VERTEX_SPACING).then(result => {
        if (cancelled) return;
        mesh.upload(result.mesh);
        terrainGridRef.current = result.grid;
        console.log(`Terrain mesh: ${result.mesh.vertexCount} verts, ${result.mesh.indexCount / 3} tris`);
      });
    });
    return () => { cancelled = true; };
  }, [worldConfig]);

  // --- Update hex state texture when hex data changes ---
  useEffect(() => {
    const hexState = hexStateRef.current;
    if (!hexState) return;
    if (hexStateSourceRef.current === hexes) return;
    hexStateSourceRef.current = hexes;
    hexState.update(hexes);
  }, [hexes]);

  // --- Rebuild island meshes when Air overlays or terrain change ---
  useEffect(() => {
    const scene = sceneRef.current;
    const ic = islandComputeRef.current;
    const topMesh = islandTopMeshRef.current;
    const underMesh = islandUnderMeshRef.current;
    const grid = terrainGridRef.current;
    if (!scene || !ic || !topMesh || !underMesh) return;

    const islandTop = scene.getObject('island-top');
    const islandUnder = scene.getObject('island-under');
    if (!islandTop || !islandUnder) return;

    // Check if Air overlays are present
    const airOverlays = planarOverlays.filter(o => o.type === PlanarAlignment.AIR);
    const hasAir = airOverlays.length > 0;

    if (!hasAir || !grid) {
      islandTop.visible = false;
      islandUnder.visible = false;
      islandKeyRef.current = '';
      return;
    }

    // Serialize Air overlay state to detect changes
    const key = airOverlays.map(o =>
      `${o.id}:${o.coordinates.q},${o.coordinates.r}:${o.intensity}:${o.radius}:${o.falloff}:${o.fragmentation}:${o.lift}`
    ).sort().join('|') + `|cfg:${worldConfig.seed}`;

    if (key === islandKeyRef.current) {
      islandTop.visible = true;
      islandUnder.visible = true;
      return;
    }
    islandKeyRef.current = key;

    const cfg = worldConfig;
    const { seaLevel, landRange, heightScale } = getTerrainRenderParams(cfg);
    let cancelled = false;

    requestIdleCallback(() => {
      if (cancelled) return;
      ic.classify(
        grid.positions,
        grid.cols * grid.rows,
        WORLD.HEX_SIZE,
        WORLD.GRID_RADIUS,
        heightScale,
        seaLevel,
      ).then(classifyData => {
        if (cancelled) return;
        const result = buildIslandMesh(classifyData, grid, { seaLevel, landRange, heightScale });
        if (!result) {
          islandTop.visible = false;
          islandUnder.visible = false;
          return;
        }
        topMesh.upload(result.top);
        underMesh.upload(result.underside);
        islandTop.visible = true;
        islandUnder.visible = true;
        console.log(`Island mesh: top ${result.top.vertexCount}v/${result.top.indexCount / 3}t, under ${result.underside.vertexCount}v/${result.underside.indexCount / 3}t`);
      });
    });

    return () => { cancelled = true; };
  }, [planarOverlays, worldConfig, hexes]);

  // --- Focus hex ---
  useEffect(() => {
    if (focusedHex && containerRef.current) {
      const pixel = hexToPixel(focusedHex.coordinates.q, focusedHex.coordinates.r, WORLD.HEX_SIZE);
      setCamera(pixel.x, pixel.y);
    }
  }, [focusedHex, setCamera]);

  // ===================================================================
  // Mouse Handlers
  // ===================================================================

  const handleMouseDown = (e: React.MouseEvent) => {
    if (showGizmosRef.current && e.button === 0) {
      const rect = containerRef.current?.getBoundingClientRect();
      if (rect) {
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        const aspect = rect.width / rect.height;
        const viewProj = computeViewProjection(aspect);
        const cfg = worldConfigRef.current;
        const { seaLevel, heightScale } = getTerrainRenderParams(cfg);
        const landRange = 1 - seaLevel;
        const allHexes = hexesRef.current;

        // Screen-space hit radius — matches visual gizmo size
        const hitRadiusPx = Math.max(12, 800 / camera.current.distance * WORLD.HEX_SIZE);

        const clickedOverlay = overlaysRef.current.find(o => {
          const pixel = hexToPixel(o.coordinates.q, o.coordinates.r, WORLD.HEX_SIZE);
          const gIdx = hexLookupRef.current.get(`${o.coordinates.q},${o.coordinates.r}`);
          const gHex = gIdx !== undefined ? allHexes[gIdx] : undefined;
          const gY = gHex ? computeDisplacedY(gHex.elevation, seaLevel, landRange, heightScale) : 0;
          const screen = worldToScreen(pixel.x, gY, pixel.y, viewProj, rect.width, rect.height);
          if (!screen) return false;
          const dx = mouseX - screen.x;
          const dy = mouseY - screen.y;
          return Math.sqrt(dx * dx + dy * dy) < hitRadiusPx;
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
    if (draggingOverlayIdRef.current && showGizmosRef.current) {
      const rect = containerRef.current?.getBoundingClientRect();
      if (rect) {
        const target = overlaysRef.current.find(o => o.id === draggingOverlayIdRef.current);
        if (target) {
          // Raycast at the overlay's current terrain elevation for accurate placement
          const gIdx = hexLookupRef.current.get(`${target.coordinates.q},${target.coordinates.r}`);
          const gHex = gIdx !== undefined ? hexesRef.current[gIdx] : undefined;
          const cfg = worldConfigRef.current;
          const { seaLevel, heightScale } = getTerrainRenderParams(cfg);
          const landRange = 1 - seaLevel;
          const planeY = gHex ? computeDisplacedY(gHex.elevation, seaLevel, landRange, heightScale) : 0;

          const hit = screenToGround(
            e.clientX - rect.left, e.clientY - rect.top,
            rect.width, rect.height,
            camera.current, CAMERA.FOV, rect.width / rect.height,
            planeY,
          );
          if (hit) {
            const hexCoords = pixelToHex(hit.x, hit.z, WORLD.HEX_SIZE);
            if (target.coordinates.q !== hexCoords.q || target.coordinates.r !== hexCoords.r) {
              onModifyOverlay({ ...target, coordinates: { q: hexCoords.q, r: hexCoords.r } });
            }
          }
        }
      }
      return;
    }
    const result = onCamMove(e);
    if (!result || result.isDragging) return;

    // Initial hex from Y=0 raycast
    const hex0 = pixelToHex(result.worldX, result.worldY, WORLD.HEX_SIZE);
    const idx0 = hexLookupRef.current.get(`${hex0.q},${hex0.r}`);

    // Refine: re-raycast at actual terrain elevation for accurate hit
    if (idx0 !== undefined) {
      const hexData = hexesRef.current[idx0]!;
      const { seaLevel, landRange, heightScale: hs } = getTerrainRenderParams(worldConfigRef.current);
      const terrainY = computeDisplacedY(hexData.elevation, seaLevel, landRange, hs);

      if (terrainY > 0.5) {
        const rect = containerRef.current?.getBoundingClientRect();
        if (rect) {
          const refined = screenToGround(
            e.clientX - rect.left, e.clientY - rect.top,
            rect.width, rect.height,
            camera.current, CAMERA.FOV, rect.width / rect.height,
            terrainY,
          );
          if (refined) {
            const hexR = pixelToHex(refined.x, refined.z, WORLD.HEX_SIZE);
            const idxR = hexLookupRef.current.get(`${hexR.q},${hexR.r}`);
            hoveredHexIndexRef.current = idxR !== undefined ? idxR : -1;
            return;
          }
        }
      }
    }

    hoveredHexIndexRef.current = idx0 !== undefined ? idx0 : -1;
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
    if (totalDragDistance.current > CAMERA.DRAG_THRESHOLD) return;
    const idx = hoveredHexIndexRef.current;
    if (idx >= 0) {
      const target = hexesRef.current[idx];
      if (target) onHexClick(target);
    }
  };

  // ===================================================================
  // GPU Render
  // ===================================================================

  const renderGpu = useCallback(() => {
    const scene = sceneRef.current;
    const canvas = canvasRef.current;
    const gpuCanvas = gpuCanvasRef.current;
    const container = containerRef.current;
    if (!scene || !canvas || !gpuCanvas || !container) return;

    // --- WASD keyboard panning ---
    tickKeys();

    // --- FPS tracking ---
    const fpsState = fpsRef.current;
    fpsState.frames++;
    const now = performance.now();
    if (now - fpsState.lastTime >= 1000) {
      fpsState.fps = fpsState.frames;
      fpsState.frames = 0;
      fpsState.lastTime = now;
      if (fpsElRef.current) fpsElRef.current.textContent = `${fpsState.fps} fps`;
    }

    // --- Canvas sizing ---
    const dpr = window.devicePixelRatio || 1;
    const rect = container.getBoundingClientRect();
    const logW = rect.width;
    const logH = rect.height;
    const pixW = Math.round(logW * dpr);
    const pixH = Math.round(logH * dpr);

    if (gpuCanvas.width !== pixW || gpuCanvas.height !== pixH) {
      gpuCanvas.width = pixW;
      gpuCanvas.height = pixH;
      scene.reconfigure();
    }
    if (canvas.width !== pixW || canvas.height !== pixH) {
      canvas.width = pixW;
      canvas.height = pixH;
    }

    // --- Camera + uniforms ---
    const cam = camera.current;
    const aspect = logW / logH;
    const viewProj = computeViewProjection(aspect);
    const cfg = worldConfigRef.current;
    const { seaLevel, heightScale } = getTerrainRenderParams(cfg);

    const mountainThreshold = TERRAIN.MOUNTAIN_THRESHOLD_BASE - cfg.mountainLevel * TERRAIN.MOUNTAIN_THRESHOLD_RANGE;
    const hillThreshold = mountainThreshold - TERRAIN.HILL_OFFSET;

    // Temperature-shifted moisture thresholds
    const tempShift = cfg.temperature - 0.5;
    const moistureDesert = TERRAIN.MOISTURE_DESERT + tempShift * 0.3;
    const moistureForest = TERRAIN.MOISTURE_FOREST + tempShift * 0.2;
    const moistureMarsh = TERRAIN.MOISTURE_MARSH - tempShift * 0.2;

    const eyePos = getEyePosition(cam);

    scene.updateFrameUniforms(
      viewProj,
      heightScale,
      WORLD.HEX_SIZE,
      seaLevel,
      mountainThreshold,
      hillThreshold,
      WORLD.GRID_RADIUS,
      moistureDesert,
      moistureForest,
      moistureMarsh,
      showGridRef.current ? MESH.HEX_GRID_OPACITY : 0,
      GPU_TERRAIN_COLORS,
      eyePos,
    );

    scene.render();

    // --- Canvas 2D overlay ---
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, logW, logH);

    const allHexes = hexesRef.current;
    const hoveredIdx = hoveredHexIndexRef.current;

    // Height params for overlay projection
    const landRange = 1 - seaLevel;

    // Hover highlight
    if (hoveredIdx >= 0) {
      const hovered = allHexes[hoveredIdx];
      if (hovered) {
        const hp = hexToPixel(hovered.coordinates.q, hovered.coordinates.r, WORLD.HEX_SIZE);
        const hoverY = computeDisplacedY(hovered.elevation, seaLevel, landRange, heightScale);
        const screen = worldToScreen(hp.x, hoverY, hp.y, viewProj, logW, logH);
        if (screen) {
          const radius = Math.max(4, 600 / cam.distance * WORLD.HEX_SIZE);
          ctx.beginPath();
          ctx.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
          ctx.lineWidth = 2;
          ctx.stroke();
        }
      }
    }

    // Planar overlay gizmos
    const activeOverlays = overlaysRef.current;
    if (showGizmosRef.current) {
      activeOverlays.forEach(overlay => {
        const op = hexToPixel(overlay.coordinates.q, overlay.coordinates.r, WORLD.HEX_SIZE);
        // Look up terrain elevation at gizmo position
        const gizmoIdx = hexLookupRef.current.get(`${overlay.coordinates.q},${overlay.coordinates.r}`);
        const gizmoHex = gizmoIdx !== undefined ? allHexes[gizmoIdx] : undefined;
        const gizmoY = gizmoHex
          ? computeDisplacedY(gizmoHex.elevation, seaLevel, landRange, heightScale)
          : 0;
        const screen = worldToScreen(op.x, gizmoY, op.y, viewProj, logW, logH);
        if (!screen) return;
        const color = PLANAR_COLORS[overlay.type];
        const radius = Math.max(6, 800 / cam.distance * WORLD.HEX_SIZE);

        ctx.beginPath();
        ctx.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.strokeStyle = 'white';
        ctx.lineWidth = 2;
        ctx.stroke();

        ctx.fillStyle = 'white';
        ctx.font = `bold ${radius * 0.7}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(overlay.type.substring(9, 11).toUpperCase(), screen.x, screen.y);
      });
    }
  }, [computeViewProjection, camera, tickKeys]);

  // ===================================================================
  // Render Loop
  // ===================================================================

  useEffect(() => {
    const loop = () => {
      if (sceneRef.current) {
        renderGpu();
      }
      animationRef.current = requestAnimationFrame(loop);
    };
    animationRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animationRef.current);
  }, [renderGpu]);

  return (
    <div ref={containerRef} className="w-full h-full cursor-default bg-slate-950 relative">
      <canvas ref={gpuCanvasRef} className="absolute inset-0 block w-full h-full" />
      <canvas
        ref={canvasRef}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onClick={handleClick}
        className="absolute inset-0 block w-full h-full"
      />
      <div
        ref={fpsElRef}
        className="absolute top-2 left-2 z-50 text-white/40 text-[11px] font-mono pointer-events-none"
      />
    </div>
  );
};
