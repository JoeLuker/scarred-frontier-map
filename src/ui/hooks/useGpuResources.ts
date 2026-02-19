import { useRef, useEffect, type RefObject } from 'react';
import { HexData, WorldGenConfig } from '../../core/types';
import { WORLD, MESH } from '../../core/config';
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
  HexStateTexture,
  MeshCompute,
  IslandCompute,
  OBJECT_FLAGS,
} from '../../gpu';
import type { TerrainGridData } from '../../gpu';

export function useGpuResources(
  gpuCanvasRef: RefObject<HTMLCanvasElement | null>,
  hexesRef: RefObject<HexData[]>,
  worldConfigRef: RefObject<WorldGenConfig>,
) {
  const sceneRef = useRef<Scene | null>(null);
  const meshRef = useRef<TerrainMesh | null>(null);
  const hexStateRef = useRef<HexStateTexture | null>(null);
  const meshComputeRef = useRef<MeshCompute | null>(null);
  const islandComputeRef = useRef<IslandCompute | null>(null);
  const islandTopMeshRef = useRef<TerrainMesh | null>(null);
  const islandUnderMeshRef = useRef<TerrainMesh | null>(null);
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

  return {
    scene: sceneRef,
    mesh: meshRef,
    hexState: hexStateRef,
    meshCompute: meshComputeRef,
    islandCompute: islandComputeRef,
    islandTopMesh: islandTopMeshRef,
    islandUnderMesh: islandUnderMeshRef,
    seaBuffer: seaBufferRef,
    terrainGrid: terrainGridRef,
    meshConfig: meshConfigRef,
    hexStateSource: hexStateSourceRef,
  };
}
