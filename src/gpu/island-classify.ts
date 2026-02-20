/**
 * GPU compute pipeline for island classification, solid-quad filtering,
 * and Jump Flood Algorithm (JFA) distance field.
 *
 * Replaces inline VS noise classification with a precomputed texture:
 *   R = is_solid (0 or 1, solid-quad filtered)
 *   G = norm_dist (0 = boundary, 1 = deep center, Euclidean via JFA)
 *
 * Pipeline (12 dispatches, zero CPU readback):
 *   1. Classify:     hex_state_tex → classify_buf (per-vertex 0/1)
 *   2. Filter+Seed:  classify_buf → filter_buf + jfa_buf_A (solid-quad + JFA seeds)
 *   3. JFA Steps:    9 passes, ping-pong jfa_buf_A ↔ jfa_buf_B
 *   4. Output:       filter_buf + jfa_result → output texture (rgba8unorm)
 */

import { createRenderNoiseWGSL } from './render-noise.wgsl';
import { PLANAR } from '../core/config';
import type { TerrainGridData } from './terrain-mesh';

const WG = 16; // workgroup size (16×16 = 256 threads)

// --- WGSL: shared config struct ---

const CONFIG_WGSL = /* wgsl */ `
struct IslandConfig {
  origin_x: f32,
  origin_z: f32,
  spacing: f32,
  cols: u32,
  rows: u32,
  hex_size: f32,
  grid_radius: f32,
  max_dist: f32,
  jfa_step: u32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
}
`;

// --- WGSL: Pass 1 — Classify ---
// Evaluates same noise + threshold as VS Air branch at each grid vertex.

function createClassifyWGSL(): string {
  return CONFIG_WGSL + /* wgsl */ `

@group(0) @binding(0) var hex_state_tex: texture_2d<f32>;
@group(0) @binding(1) var<uniform> cfg: IslandConfig;
@group(0) @binding(2) var<storage, read_write> classify_buf: array<f32>;

` + createRenderNoiseWGSL() + /* wgsl */ `

@compute @workgroup_size(${WG}, ${WG})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let col = gid.x;
  let row = gid.y;
  if (col >= cfg.cols || row >= cfg.rows) { return; }

  let x = cfg.origin_x + f32(col) * cfg.spacing;
  let z = cfg.origin_z + f32(row) * cfg.spacing;
  let idx = row * cfg.cols + col;
  let pos = vec2f(x, z);

  let hex = pixel_to_hex(x, z, cfg.hex_size);
  let state = lookup_hex_state(hex.qr, cfg.grid_radius);
  let packed_g = decode_packed_g(state.g);

  // Store continuous noise value (0-1) for boundary interpolation.
  // 0.0 = non-Air vertex, >0.5 = solid (floating), <0.5 = Air but below threshold.
  var noise_val: f32 = 0.0;
  if (packed_g.plane_type == 4u) {
    let pi = state.b;
    let frag = packed_g.fragmentation;

    if (frag < 0.01) {
      // No fragmentation — entire Air area is one solid island.
      noise_val = 1.0;
    } else {

    let base_freq = AIR_BASE_FREQ * pow(AIR_FRAG_EXPONENT, frag);
    let detail_freq = base_freq * AIR_DETAIL_FREQ_MUL;
    let detail_w = AIR_CHUNK_BLEND_DETAIL * frag;
    let fbm_w = 1.0 - detail_w;
    // Domain-warped fBM eliminates lattice straight-line artifacts.
    let chunk = warped_fbm3(pos * base_freq) * fbm_w
              + value_noise(pos * detail_freq) * detail_w;
    let edge_onset = saturate(pi / AIR_EDGE_ONSET);
    let threshold = mix(AIR_THRESHOLD_HIGH, AIR_COVERAGE_THRESHOLD, edge_onset);
    noise_val = smoothstep(
      threshold - AIR_SMOOTHSTEP_WIDTH,
      threshold + AIR_SMOOTHSTEP_WIDTH,
      chunk,
    );

    } // end frag > 0
  }

  classify_buf[idx] = noise_val;
}
`;
}

// --- WGSL: Pass 2 — Solid-Quad Filter + JFA Seed ---
// Vertex is "solid" if it belongs to at least one quad with all 4 corners floating.
// Non-solid vertices become JFA seeds; solid vertices initialize as no-seed.

const FILTER_SEED_WGSL = CONFIG_WGSL + /* wgsl */ `

@group(0) @binding(0) var<storage, read> classify_buf: array<f32>;
@group(0) @binding(1) var<uniform> cfg: IslandConfig;
@group(0) @binding(2) var<storage, read_write> filter_buf: array<u32>;
@group(0) @binding(3) var<storage, read_write> jfa_buf: array<vec2i>;

fn read_cls(col: u32, row: u32) -> bool {
  return classify_buf[row * cfg.cols + col] > 0.5;
}

@compute @workgroup_size(${WG}, ${WG})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let col = gid.x;
  let row = gid.y;
  if (col >= cfg.cols || row >= cfg.rows) { return; }

  let idx = row * cfg.cols + col;
  let self_floating = classify_buf[idx] > 0.5;

  // Non-floating vertices are never solid — mark as seed for JFA.
  if (!self_floating) {
    filter_buf[idx] = 0u;
    jfa_buf[idx] = vec2i(i32(col), i32(row));
    return;
  }

  // Check 4 adjacent quads. Self is already floating, so check the other 3 corners.
  var any_solid_quad = false;

  // Upper-left quad: (col-1,row-1), (col,row-1), (col-1,row), (col,row)
  if (col > 0u && row > 0u) {
    if (read_cls(col - 1u, row - 1u)
     && read_cls(col, row - 1u)
     && read_cls(col - 1u, row)) {
      any_solid_quad = true;
    }
  }

  // Upper-right quad: (col,row-1), (col+1,row-1), (col,row), (col+1,row)
  if (!any_solid_quad && col + 1u < cfg.cols && row > 0u) {
    if (read_cls(col, row - 1u)
     && read_cls(col + 1u, row - 1u)
     && read_cls(col + 1u, row)) {
      any_solid_quad = true;
    }
  }

  // Lower-left quad: (col-1,row), (col,row), (col-1,row+1), (col,row+1)
  if (!any_solid_quad && col > 0u && row + 1u < cfg.rows) {
    if (read_cls(col - 1u, row)
     && read_cls(col - 1u, row + 1u)
     && read_cls(col, row + 1u)) {
      any_solid_quad = true;
    }
  }

  // Lower-right quad: (col,row), (col+1,row), (col,row+1), (col+1,row+1)
  if (!any_solid_quad && col + 1u < cfg.cols && row + 1u < cfg.rows) {
    if (read_cls(col + 1u, row)
     && read_cls(col, row + 1u)
     && read_cls(col + 1u, row + 1u)) {
      any_solid_quad = true;
    }
  }

  if (any_solid_quad) {
    filter_buf[idx] = 1u;
    jfa_buf[idx] = vec2i(-1, -1); // Solid interior: no seed
  } else {
    filter_buf[idx] = 0u;
    jfa_buf[idx] = vec2i(i32(col), i32(row)); // Filtered out: becomes seed
  }
}
`;

// --- WGSL: Pass 3 — JFA Step ---
// Standard Jump Flood Algorithm pass. Checks 9 neighbors at ±step offset.

const JFA_STEP_WGSL = CONFIG_WGSL + /* wgsl */ `

@group(0) @binding(0) var<storage, read> jfa_src: array<vec2i>;
@group(0) @binding(1) var<uniform> cfg: IslandConfig;
@group(0) @binding(2) var<storage, read_write> jfa_dst: array<vec2i>;

@compute @workgroup_size(${WG}, ${WG})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let col = i32(gid.x);
  let row = i32(gid.y);
  let cols = i32(cfg.cols);
  let rows = i32(cfg.rows);
  if (col >= cols || row >= rows) { return; }

  let idx = row * cols + col;
  let s = i32(cfg.jfa_step);
  var best = jfa_src[idx];
  var best_d2 = 2147483647.0;
  if (best.x >= 0) {
    let dx = f32(col - best.x);
    let dy = f32(row - best.y);
    best_d2 = dx * dx + dy * dy;
  }

  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      let nx = col + dx * s;
      let ny = row + dy * s;
      if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) { continue; }
      let seed = jfa_src[ny * cols + nx];
      if (seed.x < 0) { continue; }
      let sdx = f32(col - seed.x);
      let sdy = f32(row - seed.y);
      let d2 = sdx * sdx + sdy * sdy;
      if (d2 < best_d2) {
        best_d2 = d2;
        best = seed;
      }
    }
  }

  jfa_dst[idx] = best;
}
`;

// --- WGSL: Pass 4 — Output ---
// Reads filter + JFA result, writes rgba8unorm texture.

const OUTPUT_WGSL = CONFIG_WGSL + /* wgsl */ `

@group(0) @binding(0) var<storage, read> filter_buf: array<u32>;
@group(0) @binding(1) var<uniform> cfg: IslandConfig;
@group(0) @binding(2) var<storage, read> jfa_result: array<vec2i>;
@group(0) @binding(3) var output_tex: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(4) var<storage, read> classify_buf: array<f32>;

@compute @workgroup_size(${WG}, ${WG})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let col = gid.x;
  let row = gid.y;
  if (col >= cfg.cols || row >= cfg.rows) { return; }

  let idx = row * cfg.cols + col;
  let is_solid = f32(filter_buf[idx]);

  var norm_dist = 0.0;
  if (filter_buf[idx] == 1u) {
    let seed = jfa_result[idx];
    if (seed.x >= 0) {
      let dx = f32(i32(col) - seed.x);
      let dy = f32(i32(row) - seed.y);
      norm_dist = min(sqrt(dx * dx + dy * dy) / cfg.max_dist, 1.0);
    }
  }

  // B channel = continuous noise value for boundary interpolation (marching-squares).
  let noise_val = classify_buf[idx];

  textureStore(output_tex, vec2i(i32(col), i32(row)), vec4f(is_solid, norm_dist, noise_val, 1.0));
}
`;

// --- IslandClassify class ---

export class IslandClassify {
  private device: GPUDevice;

  // Pipelines
  private classifyPipeline: GPUComputePipeline;
  private filterSeedPipeline: GPUComputePipeline;
  private jfaStepPipeline: GPUComputePipeline;
  private outputPipeline: GPUComputePipeline;

  // Bind groups
  private classifyBG: GPUBindGroup;
  private filterSeedBG: GPUBindGroup;
  private jfaStepBG_AB: GPUBindGroup; // A→B
  private jfaStepBG_BA: GPUBindGroup; // B→A
  private outputBG: GPUBindGroup;

  // Buffers
  private configBuf: GPUBuffer;
  private classifyBuf: GPUBuffer;
  private filterBuf: GPUBuffer;
  private jfaBufA: GPUBuffer;
  private jfaBufB: GPUBuffer;
  private stepStagingBuf: GPUBuffer;

  // Output + readback
  private _texture: GPUTexture;
  private stagingBuf: GPUBuffer;
  private stagingBytesPerRow: number;

  // Grid info
  private cols: number;
  private rows: number;
  private jfaSteps: number[];

  get texture(): GPUTexture { return this._texture; }

  private constructor(
    device: GPUDevice,
    classifyPipeline: GPUComputePipeline,
    filterSeedPipeline: GPUComputePipeline,
    jfaStepPipeline: GPUComputePipeline,
    outputPipeline: GPUComputePipeline,
    classifyBG: GPUBindGroup,
    filterSeedBG: GPUBindGroup,
    jfaStepBG_AB: GPUBindGroup,
    jfaStepBG_BA: GPUBindGroup,
    outputBG: GPUBindGroup,
    configBuf: GPUBuffer,
    classifyBuf: GPUBuffer,
    filterBuf: GPUBuffer,
    jfaBufA: GPUBuffer,
    jfaBufB: GPUBuffer,
    stepStagingBuf: GPUBuffer,
    texture: GPUTexture,
    stagingBuf: GPUBuffer,
    stagingBytesPerRow: number,
    cols: number,
    rows: number,
    jfaSteps: number[],
  ) {
    this.device = device;
    this.classifyPipeline = classifyPipeline;
    this.filterSeedPipeline = filterSeedPipeline;
    this.jfaStepPipeline = jfaStepPipeline;
    this.outputPipeline = outputPipeline;
    this.classifyBG = classifyBG;
    this.filterSeedBG = filterSeedBG;
    this.jfaStepBG_AB = jfaStepBG_AB;
    this.jfaStepBG_BA = jfaStepBG_BA;
    this.outputBG = outputBG;
    this.configBuf = configBuf;
    this.classifyBuf = classifyBuf;
    this.filterBuf = filterBuf;
    this.jfaBufA = jfaBufA;
    this.jfaBufB = jfaBufB;
    this.stepStagingBuf = stepStagingBuf;
    this._texture = texture;
    this.stagingBuf = stagingBuf;
    this.stagingBytesPerRow = stagingBytesPerRow;
    this.cols = cols;
    this.rows = rows;
    this.jfaSteps = jfaSteps;
  }

  static create(
    device: GPUDevice,
    grid: TerrainGridData,
    hexStateTex: GPUTexture,
    hexSize: number,
    gridRadius: number,
  ): IslandClassify {
    const { cols, rows, originX, originZ, spacing } = grid;
    const maxDist = PLANAR.AIR.UNDERSIDE_MAX_DIST;
    const totalVerts = cols * rows;

    // --- JFA step sizes ---
    const maxDim = Math.max(cols, rows);
    const numPasses = Math.ceil(Math.log2(maxDim));
    const jfaSteps: number[] = [];
    for (let i = numPasses - 1; i >= 0; i--) {
      jfaSteps.push(1 << i);
    }

    // --- Config buffer (48 bytes) ---
    const configData = new ArrayBuffer(48);
    const configF32 = new Float32Array(configData);
    const configU32 = new Uint32Array(configData);
    configF32[0] = originX;
    configF32[1] = originZ;
    configF32[2] = spacing;
    configU32[3] = cols;
    configU32[4] = rows;
    configF32[5] = hexSize;
    configF32[6] = gridRadius;
    configF32[7] = maxDist;
    configU32[8] = 0; // jfa_step (updated per JFA pass)

    const configBuf = device.createBuffer({
      size: 48,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(configBuf, 0, configData);

    // --- Step staging buffer (one u32 per JFA pass) ---
    const stepStagingBuf = device.createBuffer({
      size: jfaSteps.length * 4,
      usage: GPUBufferUsage.COPY_SRC,
      mappedAtCreation: true,
    });
    new Uint32Array(stepStagingBuf.getMappedRange()).set(jfaSteps);
    stepStagingBuf.unmap();

    // --- Storage buffers ---
    const classifyBuf = device.createBuffer({
      size: totalVerts * 4,
      usage: GPUBufferUsage.STORAGE,
    });
    const filterBuf = device.createBuffer({
      size: totalVerts * 4,
      usage: GPUBufferUsage.STORAGE,
    });
    const jfaBufA = device.createBuffer({
      size: totalVerts * 8, // vec2i = 8 bytes
      usage: GPUBufferUsage.STORAGE,
    });
    const jfaBufB = device.createBuffer({
      size: totalVerts * 8,
      usage: GPUBufferUsage.STORAGE,
    });

    // --- Output texture ---
    const texture = device.createTexture({
      size: [cols, rows],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
    });

    // --- Readback staging buffer ---
    // WebGPU requires bytesPerRow to be aligned to 256 bytes.
    const bytesPerRow = cols * 4; // rgba8unorm = 4 bytes/pixel
    const stagingBytesPerRow = Math.ceil(bytesPerRow / 256) * 256;
    const stagingBuf = device.createBuffer({
      size: stagingBytesPerRow * rows,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    // --- Compute pipelines ---
    const classifyModule = device.createShaderModule({ code: createClassifyWGSL() });
    const filterSeedModule = device.createShaderModule({ code: FILTER_SEED_WGSL });
    const jfaStepModule = device.createShaderModule({ code: JFA_STEP_WGSL });
    const outputModule = device.createShaderModule({ code: OUTPUT_WGSL });

    const classifyPipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: classifyModule, entryPoint: 'main' },
    });
    const filterSeedPipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: filterSeedModule, entryPoint: 'main' },
    });
    const jfaStepPipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: jfaStepModule, entryPoint: 'main' },
    });
    const outputPipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: outputModule, entryPoint: 'main' },
    });

    // --- Bind groups ---
    const classifyBG = device.createBindGroup({
      layout: classifyPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: hexStateTex.createView() },
        { binding: 1, resource: { buffer: configBuf } },
        { binding: 2, resource: { buffer: classifyBuf } },
      ],
    });

    const filterSeedBG = device.createBindGroup({
      layout: filterSeedPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: classifyBuf } },
        { binding: 1, resource: { buffer: configBuf } },
        { binding: 2, resource: { buffer: filterBuf } },
        { binding: 3, resource: { buffer: jfaBufA } },
      ],
    });

    const jfaStepBG_AB = device.createBindGroup({
      layout: jfaStepPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: jfaBufA } },
        { binding: 1, resource: { buffer: configBuf } },
        { binding: 2, resource: { buffer: jfaBufB } },
      ],
    });

    const jfaStepBG_BA = device.createBindGroup({
      layout: jfaStepPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: jfaBufB } },
        { binding: 1, resource: { buffer: configBuf } },
        { binding: 2, resource: { buffer: jfaBufA } },
      ],
    });

    // JFA result buffer: after N passes (starting A→B), result is in B if N is odd.
    const resultBuf = jfaSteps.length % 2 === 1 ? jfaBufB : jfaBufA;

    const outputBG = device.createBindGroup({
      layout: outputPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: filterBuf } },
        { binding: 1, resource: { buffer: configBuf } },
        { binding: 2, resource: { buffer: resultBuf } },
        { binding: 3, resource: texture.createView() },
        { binding: 4, resource: { buffer: classifyBuf } },
      ],
    });

    return new IslandClassify(
      device,
      classifyPipeline, filterSeedPipeline, jfaStepPipeline, outputPipeline,
      classifyBG, filterSeedBG, jfaStepBG_AB, jfaStepBG_BA, outputBG,
      configBuf, classifyBuf, filterBuf, jfaBufA, jfaBufB, stepStagingBuf,
      texture, stagingBuf, stagingBytesPerRow, cols, rows, jfaSteps,
    );
  }

  /** Run the full classify pipeline. Call after hex state texture data changes. */
  classify(): void {
    const { device, cols, rows, jfaSteps } = this;
    const wgX = Math.ceil(cols / WG);
    const wgY = Math.ceil(rows / WG);

    const encoder = device.createCommandEncoder();

    // Pass 1: Classify
    const p1 = encoder.beginComputePass();
    p1.setPipeline(this.classifyPipeline);
    p1.setBindGroup(0, this.classifyBG);
    p1.dispatchWorkgroups(wgX, wgY);
    p1.end();

    // Pass 2: Filter + JFA Seed
    const p2 = encoder.beginComputePass();
    p2.setPipeline(this.filterSeedPipeline);
    p2.setBindGroup(0, this.filterSeedBG);
    p2.dispatchWorkgroups(wgX, wgY);
    p2.end();

    // Passes 3..N+2: JFA Steps
    for (let i = 0; i < jfaSteps.length; i++) {
      // Update jfa_step field in config buffer (byte offset 32)
      encoder.copyBufferToBuffer(this.stepStagingBuf, i * 4, this.configBuf, 32, 4);

      const pass = encoder.beginComputePass();
      pass.setPipeline(this.jfaStepPipeline);
      pass.setBindGroup(0, i % 2 === 0 ? this.jfaStepBG_AB : this.jfaStepBG_BA);
      pass.dispatchWorkgroups(wgX, wgY);
      pass.end();
    }

    // Final pass: Output
    const pOut = encoder.beginComputePass();
    pOut.setPipeline(this.outputPipeline);
    pOut.setBindGroup(0, this.outputBG);
    pOut.dispatchWorkgroups(wgX, wgY);
    pOut.end();

    device.queue.submit([encoder.finish()]);
  }

  /**
   * Read back the classify output texture to CPU.
   * Returns per-vertex solid flag and normalized distance field.
   * Must be called AFTER classify() — reads the output texture.
   */
  async readback(): Promise<IslandReadbackData> {
    const { device, cols, rows, stagingBytesPerRow } = this;

    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer(
      { texture: this._texture },
      { buffer: this.stagingBuf, bytesPerRow: stagingBytesPerRow },
      [cols, rows],
    );
    device.queue.submit([encoder.finish()]);

    await this.stagingBuf.mapAsync(GPUMapMode.READ);
    const mapped = new Uint8Array(this.stagingBuf.getMappedRange());

    const total = cols * rows;
    const solid = new Uint8Array(total);
    const normDist = new Float32Array(total);
    const noiseVal = new Float32Array(total);

    // Extract R (is_solid), G (norm_dist), B (noise_val) from rgba8unorm rows,
    // accounting for row stride padding.
    for (let row = 0; row < rows; row++) {
      const rowOff = row * stagingBytesPerRow;
      for (let col = 0; col < cols; col++) {
        const idx = row * cols + col;
        const pixOff = rowOff + col * 4;
        solid[idx] = mapped[pixOff]! > 127 ? 1 : 0;         // R channel: is_solid
        normDist[idx] = mapped[pixOff + 1]! / 255;           // G channel: norm_dist (unorm)
        noiseVal[idx] = mapped[pixOff + 2]! / 255;           // B channel: continuous noise
      }
    }

    this.stagingBuf.unmap();
    return { solid, normDist, noiseVal, cols, rows };
  }

  destroy(): void {
    this.configBuf.destroy();
    this.classifyBuf.destroy();
    this.filterBuf.destroy();
    this.jfaBufA.destroy();
    this.jfaBufB.destroy();
    this.stepStagingBuf.destroy();
    this.stagingBuf.destroy();
    this._texture.destroy();
  }
}

/** Data returned from IslandClassify.readback() for CPU mesh construction. */
export interface IslandReadbackData {
  readonly solid: Uint8Array;       // 0 or 1 per grid vertex
  readonly normDist: Float32Array;  // 0 = boundary, 1 = deep center (JFA Euclidean)
  readonly noiseVal: Float32Array;  // continuous noise (0-1) for boundary interpolation
  readonly cols: number;
  readonly rows: number;
}
