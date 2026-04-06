/**
 * CPU mesh builder for volcanic plume geometry above lava pools.
 *
 * One plume per Fire overlay with active lava. Each plume is composed of
 * concentric shells — narrow at the vent, billowing wide at the top —
 * creating a volcanic smoke column effect.
 *
 * 8-float tornado vertex layout (reused for plumes):
 *   [center_x, center_z, world_y, local_angle, local_radius, height_frac, twist_speed, opacity_base]
 *
 * VS applies time-based lazy rotation and billowing noise at runtime.
 */

import { TORNADO_VERTEX_STRIDE } from './types';
import { PLANAR } from '../core/constants';
import type { MeshBuffers } from './terrain-mesh';

const P = PLANAR.PLUME;
const TWO_PI = Math.PI * 2;

// Concentric shells: outer shell thinner for volumetric depth,
// inner shell more opaque for dense smoke core.
const SHELLS = [
  { radiusFrac: 1.0,  opacity: 0.22, twistMul: 1.0 },
  { radiusFrac: 0.45, opacity: 0.35, twistMul: 0.6 },
] as const;

export interface PlumeDescriptor {
  readonly centerX: number;
  readonly centerZ: number;
  readonly baseY: number;       // lava surface Y (bottom of plume)
  readonly baseRadius: number;  // world-space radius derived from lava pool footprint
  readonly volcanism: number;   // 0-1, scales height + density
}

export function buildPlumeMesh(
  descriptors: readonly PlumeDescriptor[],
  heightScale: number,
): MeshBuffers | null {
  if (descriptors.length === 0) return null;

  const RINGS = P.RINGS;
  const SEGS = P.SEGMENTS;
  const shellCount = SHELLS.length;
  const vertsPerShell = RINGS * SEGS;
  const indicesPerShell = (RINGS - 1) * SEGS * 6;
  const vertsPerPlume = vertsPerShell * shellCount;
  const indicesPerPlume = indicesPerShell * shellCount;
  const totalVerts = descriptors.length * vertsPerPlume;
  const totalIndices = descriptors.length * indicesPerPlume;

  const S = TORNADO_VERTEX_STRIDE;
  const vertices = new Float32Array(totalVerts * S);
  const indices = new Uint32Array(totalIndices);

  let vertOff = 0;
  let idxOff = 0;

  for (let pi = 0; pi < descriptors.length; pi++) {
    const d = descriptors[pi]!;
    const plumeHeight = d.baseRadius * P.HEIGHT_FACTOR * d.volcanism;
    const topY = d.baseY + plumeHeight;

    for (let si = 0; si < shellCount; si++) {
      const shell = SHELLS[si]!;
      const shellRadius = d.baseRadius * shell.radiusFrac;
      const shellTwist = P.TWIST_SPEED * shell.twistMul;
      const shellOpacity = shell.opacity * (0.5 + d.volcanism * 0.5);
      const baseVert = vertOff;

      // Write vertices: RINGS × SEGS
      for (let ring = 0; ring < RINGS; ring++) {
        const hf = ring / (RINGS - 1);
        // Inverted profile: narrow vent at base → billow at top
        const profile = 0.15 + hf * 0.85;
        const y = d.baseY + (topY - d.baseY) * hf;

        for (let seg = 0; seg < SEGS; seg++) {
          const angle = (seg / SEGS) * TWO_PI;
          const vo = vertOff * S;

          vertices[vo]     = d.centerX;
          vertices[vo + 1] = d.centerZ;
          vertices[vo + 2] = y;
          vertices[vo + 3] = angle;
          vertices[vo + 4] = shellRadius * profile;
          vertices[vo + 5] = hf;
          vertices[vo + 6] = shellTwist;
          vertices[vo + 7] = shellOpacity;

          vertOff++;
        }
      }

      // Write indices: quads between adjacent rings
      for (let ring = 0; ring < RINGS - 1; ring++) {
        for (let seg = 0; seg < SEGS; seg++) {
          const i0 = baseVert + ring * SEGS + seg;
          const i1 = baseVert + ring * SEGS + (seg + 1) % SEGS;
          const i2 = baseVert + (ring + 1) * SEGS + seg;
          const i3 = baseVert + (ring + 1) * SEGS + (seg + 1) % SEGS;

          indices[idxOff]     = i0;
          indices[idxOff + 1] = i2;
          indices[idxOff + 2] = i1;
          indices[idxOff + 3] = i1;
          indices[idxOff + 4] = i2;
          indices[idxOff + 5] = i3;

          idxOff += 6;
        }
      }
    }
  }

  return {
    vertices,
    indices,
    vertexCount: totalVerts,
    indexCount: totalIndices,
  };
}
