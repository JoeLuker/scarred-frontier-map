import type { MeshBuffers } from './terrain-mesh';

/**
 * GPU buffer pair for overlay-driven meshes (islands, tornadoes, lava, etc).
 * Generic: any MeshBuffers can be uploaded. Separate from TerrainMesh because
 * overlay meshes use a different stride (32 vs 28 bytes).
 */
export class OverlayMesh {
  private device: GPUDevice;
  private _vertexBuffer: GPUBuffer;
  private _indexBuffer: GPUBuffer;
  private _vertexCount = 0;
  private _indexCount = 0;

  constructor(device: GPUDevice, initialCapacity: number, byteStride: number) {
    this.device = device;
    this._vertexBuffer = device.createBuffer({
      size: initialCapacity * byteStride,
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
