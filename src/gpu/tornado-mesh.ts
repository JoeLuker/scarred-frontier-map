/**
 * CPU mesh builder for tornado vortex geometry beneath floating islands.
 *
 * One tornado per Air overlay, positioned at the overlay center. Each tornado
 * is composed of multiple concentric shells (nested tubes) at different radii
 * and twist speeds — layered transparency creates volumetric density rather
 * than a hollow funnel.
 *
 * 8-float tornado vertex layout:
 *   [center_x, center_z, world_y, local_angle, local_radius, height_frac, twist_speed, opacity_base]
 *
 * VS applies time-based twist rotation and wobble at runtime — zero mesh
 * rebuilds for animation.
 */

import { TORNADO_VERTEX_STRIDE } from './types';
import { PLANAR } from '../core/constants';
import type { MeshBuffers } from './terrain-mesh';

const T = PLANAR.TORNADO;
const TWO_PI = Math.PI * 2;

// Concentric shells: inner layers spin faster, are more opaque → volumetric depth.
// When the camera looks through the tornado, it sees multiple overlapping surfaces
// with different twist phases, reading as a dense column rather than a hollow cone.
const SHELLS = [
  { radiusFrac: 1.0,  opacity: 0.20, twistMul: 1.0 },
  { radiusFrac: 0.55, opacity: 0.28, twistMul: 1.35 },
  { radiusFrac: 0.18, opacity: 0.45, twistMul: 1.8 },
] as const;

export interface TornadoDescriptor {
  readonly centerX: number;
  readonly centerZ: number;
  readonly topY: number;         // island underside attachment Y
  readonly baseRadius: number;   // world-space outer radius
  readonly twistSpeed: number;   // base angular speed
}

export function buildTornadoMesh(
  descriptors: readonly TornadoDescriptor[],
  gougeY: number,
): MeshBuffers | null {
  if (descriptors.length === 0) return null;

  const RINGS = T.RINGS;
  const SEGS = T.SEGMENTS;
  const shellCount = SHELLS.length;
  const vertsPerShell = RINGS * SEGS;
  const indicesPerShell = (RINGS - 1) * SEGS * 6;
  const vertsPerTornado = vertsPerShell * shellCount;
  const indicesPerTornado = indicesPerShell * shellCount;
  const totalVerts = descriptors.length * vertsPerTornado;
  const totalIndices = descriptors.length * indicesPerTornado;

  const S = TORNADO_VERTEX_STRIDE;
  const vertices = new Float32Array(totalVerts * S);
  const indices = new Uint32Array(totalIndices);

  let vertOff = 0;
  let idxOff = 0;

  for (let ti = 0; ti < descriptors.length; ti++) {
    const d = descriptors[ti]!;

    for (let si = 0; si < shellCount; si++) {
      const shell = SHELLS[si]!;
      const shellRadius = d.baseRadius * shell.radiusFrac;
      const shellTwist = d.twistSpeed * shell.twistMul;
      const shellOpacity = shell.opacity;
      const baseVert = vertOff;

      // Write vertices: RINGS × SEGS
      for (let ring = 0; ring < RINGS; ring++) {
        const hf = ring / (RINGS - 1);
        const y = d.topY + (gougeY - d.topY) * hf;

        for (let seg = 0; seg < SEGS; seg++) {
          const angle = (seg / SEGS) * TWO_PI;
          const vo = vertOff * S;

          vertices[vo]     = d.centerX;
          vertices[vo + 1] = d.centerZ;
          vertices[vo + 2] = y;
          vertices[vo + 3] = angle;
          vertices[vo + 4] = shellRadius;
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
