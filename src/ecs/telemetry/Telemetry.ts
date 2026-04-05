/**
 * Performance telemetry for the ECS world.
 *
 * Three layers:
 * 1. CPU timing: performance.now() around system calls
 * 2. GPU timing: WebGPU timestamp queries on compute/render passes (if supported)
 * 3. Structured logging: periodic console output with rolling averages
 *
 * All metrics are rolling averages over a configurable window (default 60 frames).
 */

const WINDOW_SIZE = 60;
const LOG_INTERVAL_MS = 5000;

// --- Metric Ring Buffer ---

class Metric {
  readonly name: string;
  private values: Float64Array;
  private index = 0;
  private count = 0;

  constructor(name: string, windowSize = WINDOW_SIZE) {
    this.name = name;
    this.values = new Float64Array(windowSize);
  }

  push(value: number): void {
    this.values[this.index % this.values.length] = value;
    this.index++;
    this.count = Math.min(this.count + 1, this.values.length);
  }

  get avg(): number {
    if (this.count === 0) return 0;
    let sum = 0;
    for (let i = 0; i < this.count; i++) sum += this.values[i]!;
    return sum / this.count;
  }

  get max(): number {
    if (this.count === 0) return 0;
    let m = 0;
    for (let i = 0; i < this.count; i++) {
      if (this.values[i]! > m) m = this.values[i]!;
    }
    return m;
  }

  get last(): number {
    if (this.count === 0) return 0;
    return this.values[(this.index - 1) % this.values.length]!;
  }
}

// --- GPU Timestamp Query ---

class GpuTimestamps {
  private querySet: GPUQuerySet;
  private resolveBuffer: GPUBuffer;
  private readBuffer: GPUBuffer;
  private capacity: number;
  private pending = false;

  readonly supported: boolean;

  // Results (nanoseconds, 1-2 frames behind)
  readonly results: Map<string, number> = new Map();

  private constructor(
    querySet: GPUQuerySet,
    resolveBuffer: GPUBuffer,
    readBuffer: GPUBuffer,
    capacity: number,
  ) {
    this.querySet = querySet;
    this.resolveBuffer = resolveBuffer;
    this.readBuffer = readBuffer;
    this.capacity = capacity;
    this.supported = true;
  }

  static create(device: GPUDevice): GpuTimestamps | null {
    if (!device.features.has('timestamp-query')) return null;

    const capacity = 8; // 4 pairs (start/end) for: shallow water, source injection, render, total
    const querySet = device.createQuerySet({ type: 'timestamp', count: capacity });
    const resolveBuffer = device.createBuffer({
      size: capacity * 8,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    });
    const readBuffer = device.createBuffer({
      size: capacity * 8,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });

    return new GpuTimestamps(querySet, resolveBuffer, readBuffer, capacity);
  }

  /** Get timestamp writes descriptor for a compute/render pass. */
  getTimestampWrites(beginIdx: number, endIdx: number): GPUComputePassTimestampWrites {
    return {
      querySet: this.querySet,
      beginningOfPassWriteIndex: beginIdx,
      endOfPassWriteIndex: endIdx,
    };
  }

  /** Resolve + copy after all passes are done. Call once per frame. */
  resolve(encoder: GPUCommandEncoder): void {
    if (this.pending) return;
    encoder.resolveQuerySet(this.querySet, 0, this.capacity, this.resolveBuffer, 0);
    encoder.copyBufferToBuffer(this.resolveBuffer, 0, this.readBuffer, 0, this.capacity * 8);
  }

  /** Async readback. Call after queue submit. Updates this.results. */
  async readback(labels: [string, number, number][]): Promise<void> {
    if (this.pending) return;
    this.pending = true;

    try {
      await this.readBuffer.mapAsync(GPUMapMode.READ);
      const times = new BigUint64Array(this.readBuffer.getMappedRange());

      for (const [label, startIdx, endIdx] of labels) {
        const start = times[startIdx]!;
        const end = times[endIdx]!;
        if (end > start) {
          this.results.set(label, Number(end - start) / 1_000_000); // ns → ms
        }
      }

      this.readBuffer.unmap();
    } catch {
      // readback failed (device lost, etc.) — silently skip
    }

    this.pending = false;
  }

  destroy(): void {
    this.querySet.destroy();
    this.resolveBuffer.destroy();
    this.readBuffer.destroy();
  }
}

// --- Telemetry System ---

export class Telemetry {
  // CPU metrics (ms)
  readonly frameTime = new Metric('frame_time');
  readonly simTime = new Metric('sim_time');
  readonly uniformTime = new Metric('uniform_time');
  readonly renderTime = new Metric('render_time');
  readonly simTickCount = new Metric('sim_ticks_per_frame');

  // GPU metrics (ms, async)
  private gpuTimestamps: GpuTimestamps | null;

  // FPS
  private frameCount = 0;
  private fpsAccumulator = 0;
  fps = 0;

  // Structured logging
  private lastLogTime = 0;
  private logEnabled = true;

  private constructor(gpuTimestamps: GpuTimestamps | null) {
    this.gpuTimestamps = gpuTimestamps;
  }

  static create(device: GPUDevice): Telemetry {
    const gpu = GpuTimestamps.create(device);
    if (gpu) {
      console.log('GPU timestamp queries enabled');
    } else {
      console.log('GPU timestamp queries not supported — CPU-only telemetry');
    }
    return new Telemetry(gpu);
  }

  get gpuSupported(): boolean { return this.gpuTimestamps !== null; }

  // --- CPU timing helpers ---

  beginFrame(): number { return performance.now(); }

  endFrame(start: number): void {
    const dt = performance.now() - start;
    this.frameTime.push(dt);
    this.frameCount++;
    this.fpsAccumulator += dt;

    if (this.fpsAccumulator >= 1000) {
      this.fps = Math.round(this.frameCount * 1000 / this.fpsAccumulator);
      this.frameCount = 0;
      this.fpsAccumulator = 0;
    }

    this.maybeLog();
  }

  measureSim(fn: () => number): void {
    const t0 = performance.now();
    const ticks = fn();
    this.simTime.push(performance.now() - t0);
    this.simTickCount.push(ticks);
  }

  measureUniform(fn: () => void): void {
    const t0 = performance.now();
    fn();
    this.uniformTime.push(performance.now() - t0);
  }

  measureRender(fn: () => void): void {
    const t0 = performance.now();
    fn();
    this.renderTime.push(performance.now() - t0);
  }

  // --- GPU timestamps ---

  /** Get timestamp writes for a compute pass, or undefined if not supported. */
  getComputeTimestampWrites(beginIdx: number, endIdx: number): GPUComputePassTimestampWrites | undefined {
    return this.gpuTimestamps?.getTimestampWrites(beginIdx, endIdx);
  }

  resolveGpuTimestamps(encoder: GPUCommandEncoder): void {
    this.gpuTimestamps?.resolve(encoder);
  }

  readbackGpuTimestamps(): void {
    this.gpuTimestamps?.readback([
      ['gpu_shallow_water', 0, 1],
      ['gpu_source_injection', 2, 3],
      ['gpu_render', 4, 5],
    ]);
  }

  getGpuMetric(label: string): number {
    return this.gpuTimestamps?.results.get(label) ?? 0;
  }

  // --- Structured logging ---

  setLogEnabled(enabled: boolean): void { this.logEnabled = enabled; }

  private maybeLog(): void {
    if (!this.logEnabled) return;
    const now = performance.now();
    if (now - this.lastLogTime < LOG_INTERVAL_MS) return;
    this.lastLogTime = now;

    const lines = [
      `[Telemetry] ${this.fps} fps`,
      `  frame: ${this.frameTime.avg.toFixed(2)}ms avg, ${this.frameTime.max.toFixed(2)}ms max`,
      `  sim:   ${this.simTime.avg.toFixed(2)}ms avg (${this.simTickCount.avg.toFixed(1)} ticks/frame)`,
      `  unifm: ${this.uniformTime.avg.toFixed(2)}ms avg`,
      `  rendr: ${this.renderTime.avg.toFixed(2)}ms avg`,
    ];

    if (this.gpuTimestamps && this.gpuTimestamps.results.size > 0) {
      for (const [label, ms] of this.gpuTimestamps.results) {
        lines.push(`  gpu/${label}: ${ms.toFixed(3)}ms`);
      }
    }

    console.log(lines.join('\n'));
  }

  // --- Snapshot for UI overlay ---

  snapshot(): TelemetrySnapshot {
    return {
      fps: this.fps,
      frameTimeAvg: this.frameTime.avg,
      frameTimeMax: this.frameTime.max,
      simTimeAvg: this.simTime.avg,
      simTicksPerFrame: this.simTickCount.avg,
      uniformTimeAvg: this.uniformTime.avg,
      renderTimeAvg: this.renderTime.avg,
      gpuShallowWater: this.getGpuMetric('gpu_shallow_water'),
      gpuSourceInjection: this.getGpuMetric('gpu_source_injection'),
      gpuRender: this.getGpuMetric('gpu_render'),
      gpuSupported: this.gpuSupported,
    };
  }

  destroy(): void {
    this.gpuTimestamps?.destroy();
  }
}

export interface TelemetrySnapshot {
  readonly fps: number;
  readonly frameTimeAvg: number;
  readonly frameTimeMax: number;
  readonly simTimeAvg: number;
  readonly simTicksPerFrame: number;
  readonly uniformTimeAvg: number;
  readonly renderTimeAvg: number;
  readonly gpuShallowWater: number;
  readonly gpuSourceInjection: number;
  readonly gpuRender: number;
  readonly gpuSupported: boolean;
}
