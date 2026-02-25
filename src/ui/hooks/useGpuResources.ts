import { useRef, useEffect, type RefObject } from 'react';
import { HexData, WorldGenConfig } from '../../core/types';
import { WORLD, MESH } from '../../core/config';
import {
  initWebGPU,
  Scene,
  createTerrainShader,
  createTerrainMaterial,
  createSeaMaterial,
  createSkyMaterial,
  createIslandMaterial,
  createTornadoMaterial,
  createPlumeMaterial,
  TerrainMesh,
  buildTerrainMesh,
  HexStateTexture,
  MeshCompute,
  IslandClassify,
  OBJECT_FLAGS,
  SCENE_OBJECTS,
  ISLAND_VERTEX_BYTE_STRIDE,
} from '../../gpu';
import type { TerrainGridData } from '../../gpu';
import { OverlayMesh } from '../../gpu';

export function useGpuResources(
  gpuCanvasRef: RefObject<HTMLCanvasElement | null>,
  hexesRef: RefObject<HexData[]>,
  worldConfigRef: RefObject<WorldGenConfig>,
) {
  const sceneRef = useRef<Scene | null>(null);
  const meshRef = useRef<TerrainMesh | null>(null);
  const hexStateRef = useRef<HexStateTexture | null>(null);
  const meshComputeRef = useRef<MeshCompute | null>(null);
  const islandClassifyRef = useRef<IslandClassify | null>(null);
  const islandTopMeshRef = useRef<OverlayMesh | null>(null);
  const islandUnderMeshRef = useRef<OverlayMesh | null>(null);
  const tornadoMeshRef = useRef<OverlayMesh | null>(null);
  const plumeMeshRef = useRef<OverlayMesh | null>(null);
  const seaBufferRef = useRef<GPUBuffer | null>(null);
  const terrainGridRef = useRef<TerrainGridData | null>(null);
  const meshConfigRef = useRef<WorldGenConfig | null>(null);
  const hexStateSourceRef = useRef<HexData[] | null>(null);

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
        const tornadoMat = createTornadoMaterial(device, shader, scene.format, scene.group0Layout, scene.group1Layout);
        const plumeMat = createPlumeMaterial(device, shader, scene.format, scene.group0Layout, scene.group1Layout);
        const seaMat = createSeaMaterial(device, shader, scene.format, scene.group0Layout, scene.group1Layout);
        const skyMat = createSkyMaterial(device, shader, scene.format, scene.group0Layout);

        // Overlay mesh buffers (all use 8-float / 32-byte vertex layouts)
        const stride = ISLAND_VERTEX_BYTE_STRIDE;
        const islandTopMesh = new OverlayMesh(device, 50000, stride);
        const islandUnderMesh = new OverlayMesh(device, 50000, stride);
        const tornadoMesh = new OverlayMesh(device, 10000, stride);
        const plumeMesh = new OverlayMesh(device, 10000, stride);

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
        scene.addObject(SCENE_OBJECTS.ISLAND_TOP, {
          material: islandMat,
          mesh: islandTopMesh,
          flags: OBJECT_FLAGS.IS_TERRAIN | OBJECT_FLAGS.IS_ISLAND_DRAW,
          stencilRef: 1,
          renderOrder: 2,
          visible: false,
        });
        scene.addObject(SCENE_OBJECTS.ISLAND_UNDER, {
          material: islandMat,
          mesh: islandUnderMesh,
          flags: OBJECT_FLAGS.IS_TERRAIN | OBJECT_FLAGS.IS_ISLAND_UNDER,
          stencilRef: 1,
          renderOrder: 3,
          visible: false,
        });
        scene.addObject(SCENE_OBJECTS.TORNADO, {
          material: tornadoMat,
          mesh: tornadoMesh,
          flags: OBJECT_FLAGS.IS_TORNADO,
          stencilRef: 1,
          renderOrder: 3.5,
          visible: false,
        });
        scene.addObject(SCENE_OBJECTS.PLUME, {
          material: plumeMat,
          mesh: plumeMesh,
          flags: OBJECT_FLAGS.IS_PLUME,
          stencilRef: 1,
          renderOrder: 3.6,
          visible: false,
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
        islandTopMeshRef.current = islandTopMesh;
        islandUnderMeshRef.current = islandUnderMesh;
        tornadoMeshRef.current = tornadoMesh;
        plumeMeshRef.current = plumeMesh;
        seaBufferRef.current = seaBuffer;

        // Build initial mesh + hex state
        const cfg = worldConfigRef.current;
        const result = await buildTerrainMesh(mc, cfg, WORLD.GRID_RADIUS, WORLD.HEX_SIZE, MESH.VERTEX_SPACING);
        if (cancelled) return;
        mesh.upload(result.mesh);
        terrainGridRef.current = result.grid;
        meshConfigRef.current = cfg;

        // Create island classify pipeline (needs grid data from mesh build)
        const ic = IslandClassify.create(
          device, result.grid, hexState.texture,
          WORLD.HEX_SIZE, WORLD.GRID_RADIUS,
        );
        scene.setIslandTexture(ic.texture);
        islandClassifyRef.current = ic;

        hexState.update(hexesRef.current);
        hexStateSourceRef.current = hexesRef.current;
        ic.classify();

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
      islandClassifyRef.current?.destroy();
      islandClassifyRef.current = null;
      islandTopMeshRef.current?.destroy();
      islandTopMeshRef.current = null;
      islandUnderMeshRef.current?.destroy();
      islandUnderMeshRef.current = null;
      tornadoMeshRef.current?.destroy();
      tornadoMeshRef.current = null;
      plumeMeshRef.current?.destroy();
      plumeMeshRef.current = null;
      seaBufferRef.current?.destroy();
      seaBufferRef.current = null;
      terrainGridRef.current = null;
    };
  }, []);

  return {
    scene: sceneRef,
    mesh: meshRef,
    hexState: hexStateRef,
    meshCompute: meshComputeRef,
    islandClassify: islandClassifyRef,
    islandTopMesh: islandTopMeshRef,
    islandUnderMesh: islandUnderMeshRef,
    tornadoMesh: tornadoMeshRef,
    plumeMesh: plumeMeshRef,
    seaBuffer: seaBufferRef,
    terrainGrid: terrainGridRef,
    meshConfig: meshConfigRef,
    hexStateSource: hexStateSourceRef,
  };
}
