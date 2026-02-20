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
  TerrainMesh,
  buildTerrainMesh,
  HexStateTexture,
  MeshCompute,
  IslandClassify,
  OBJECT_FLAGS,
  ISLAND_VERTEX_BYTE_STRIDE,
} from '../../gpu';
import type { TerrainGridData, MeshBuffers } from '../../gpu';

/**
 * GPU buffer pair for island meshes (8-float vertex layout).
 * Separate from TerrainMesh because stride differs (32 vs 28 bytes).
 */
export class IslandMesh {
  private device: GPUDevice;
  private _vertexBuffer: GPUBuffer;
  private _indexBuffer: GPUBuffer;
  private _vertexCount = 0;
  private _indexCount = 0;

  constructor(device: GPUDevice, initialCapacity: number) {
    this.device = device;
    this._vertexBuffer = device.createBuffer({
      size: initialCapacity * ISLAND_VERTEX_BYTE_STRIDE,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this._indexBuffer = device.createBuffer({
      size: initialCapacity * 6 * 4,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
  }

  upload(mesh: MeshBuffers): void {
    const vertBytes = mesh.vertices.byteLength;
    if (vertBytes > this._vertexBuffer.size) {
      this._vertexBuffer.destroy();
      this._vertexBuffer = this.device.createBuffer({
        size: Math.ceil(vertBytes * 1.5),
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
    }
    const idxBytes = mesh.indices.byteLength;
    if (idxBytes > this._indexBuffer.size) {
      this._indexBuffer.destroy();
      this._indexBuffer = this.device.createBuffer({
        size: Math.ceil(idxBytes * 1.5),
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      });
    }
    this.device.queue.writeBuffer(this._vertexBuffer, 0, mesh.vertices);
    this.device.queue.writeBuffer(this._indexBuffer, 0, mesh.indices);
    this._vertexCount = mesh.vertexCount;
    this._indexCount = mesh.indexCount;
  }

  get vertexBuffer(): GPUBuffer { return this._vertexBuffer; }
  get indexBuffer(): GPUBuffer { return this._indexBuffer; }
  get vertexCount(): number { return this._vertexCount; }
  get indexCount(): number { return this._indexCount; }

  destroy(): void {
    this._vertexBuffer.destroy();
    this._indexBuffer.destroy();
  }
}

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
  const islandTopMeshRef = useRef<IslandMesh | null>(null);
  const islandUnderMeshRef = useRef<IslandMesh | null>(null);
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

        // Island mesh buffers (dedicated 8-float vertex layout)
        const islandTopMesh = new IslandMesh(device, 50000);
        const islandUnderMesh = new IslandMesh(device, 50000);

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
        scene.addObject('island-top', {
          material: islandMat,
          mesh: islandTopMesh,
          flags: OBJECT_FLAGS.IS_TERRAIN | OBJECT_FLAGS.IS_ISLAND_DRAW,
          stencilRef: 1,
          renderOrder: 2,
          visible: false,
        });
        scene.addObject('island-under', {
          material: islandMat,
          mesh: islandUnderMesh,
          flags: OBJECT_FLAGS.IS_TERRAIN | OBJECT_FLAGS.IS_ISLAND_UNDER,
          stencilRef: 1,
          renderOrder: 3,
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
    seaBuffer: seaBufferRef,
    terrainGrid: terrainGridRef,
    meshConfig: meshConfigRef,
    hexStateSource: hexStateSourceRef,
  };
}
