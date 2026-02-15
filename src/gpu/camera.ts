// Orbital camera + matrix math for WebGPU (column-major, right-handed, Z ∈ [0,1])

type Vec3 = [number, number, number];

export interface OrbitalCamera {
  azimuth: number;     // horizontal rotation (radians, 0 = looking from +Z)
  elevation: number;   // vertical tilt (radians, 0 = horizontal, π/2 = top-down)
  distance: number;    // distance from target
  targetX: number;     // orbit center X (world)
  targetZ: number;     // orbit center Z (world)
}

// --- Matrix helpers (column-major Float32Array(16)) ---

function perspective(fov: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan(fov * 0.5);
  const rangeInv = 1 / (near - far);
  const out = new Float32Array(16);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = far * rangeInv;
  out[11] = -1;
  out[14] = near * far * rangeInv;
  return out;
}

function lookAt(eye: Vec3, target: Vec3, up: Vec3): Float32Array {
  // backward = normalize(eye - target)
  let bx = eye[0] - target[0], by = eye[1] - target[1], bz = eye[2] - target[2];
  const bLen = Math.sqrt(bx * bx + by * by + bz * bz);
  bx /= bLen; by /= bLen; bz /= bLen;

  // right = normalize(cross(up, backward))
  let rx = up[1] * bz - up[2] * by;
  let ry = up[2] * bx - up[0] * bz;
  let rz = up[0] * by - up[1] * bx;
  const rLen = Math.sqrt(rx * rx + ry * ry + rz * rz);
  rx /= rLen; ry /= rLen; rz /= rLen;

  // true up = cross(backward, right)
  const ux = by * rz - bz * ry;
  const uy = bz * rx - bx * rz;
  const uz = bx * ry - by * rx;

  const out = new Float32Array(16);
  out[0] = rx;  out[1] = ux;  out[2] = bx;  out[3] = 0;
  out[4] = ry;  out[5] = uy;  out[6] = by;  out[7] = 0;
  out[8] = rz;  out[9] = uz;  out[10] = bz; out[11] = 0;
  out[12] = -(rx * eye[0] + ry * eye[1] + rz * eye[2]);
  out[13] = -(ux * eye[0] + uy * eye[1] + uz * eye[2]);
  out[14] = -(bx * eye[0] + by * eye[1] + bz * eye[2]);
  out[15] = 1;
  return out;
}

function multiply(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      out[col * 4 + row] =
        a[0 * 4 + row]! * b[col * 4 + 0]! +
        a[1 * 4 + row]! * b[col * 4 + 1]! +
        a[2 * 4 + row]! * b[col * 4 + 2]! +
        a[3 * 4 + row]! * b[col * 4 + 3]!;
    }
  }
  return out;
}

// --- Public API ---

export function getEyePosition(cam: OrbitalCamera): Vec3 {
  const cosEl = Math.cos(cam.elevation);
  const sinEl = Math.sin(cam.elevation);
  return [
    cam.targetX + cam.distance * Math.sin(cam.azimuth) * cosEl,
    cam.distance * sinEl,
    cam.targetZ + cam.distance * Math.cos(cam.azimuth) * cosEl,
  ];
}

export function getViewProjection(
  cam: OrbitalCamera, fov: number, aspect: number, near: number, far: number,
): Float32Array {
  const eye = getEyePosition(cam);
  const target: Vec3 = [cam.targetX, 0, cam.targetZ];
  const view = lookAt(eye, target, [0, 1, 0]);
  const proj = perspective(fov, aspect, near, far);
  return multiply(proj, view);
}

/** Raycast from screen pixel to the Y=0 ground plane. Returns world (x, z) or null. */
export function screenToGround(
  mouseX: number, mouseY: number,
  screenW: number, screenH: number,
  cam: OrbitalCamera, fov: number, aspect: number,
): { x: number; z: number } | null {
  const ndcX = (2 * mouseX / screenW) - 1;
  const ndcY = 1 - (2 * mouseY / screenH);

  const cosEl = Math.cos(cam.elevation);
  const sinEl = Math.sin(cam.elevation);
  const cosAz = Math.cos(cam.azimuth);
  const sinAz = Math.sin(cam.azimuth);

  const eye = getEyePosition(cam);

  // Camera basis vectors (world space)
  const rx = cosAz, rz = -sinAz;                         // right (horizontal)
  const ux = -sinEl * sinAz, uy = cosEl, uz = -sinEl * cosAz;  // true up
  const bx = sinAz * cosEl, by = sinEl, bz = cosAz * cosEl;    // backward

  // Ray direction in camera local → world
  const halfTan = Math.tan(fov * 0.5);
  const rvX = ndcX * halfTan * aspect;
  const rvY = ndcY * halfTan;

  // world ray = right*rvX + up*rvY - backward*1
  const dirX = rx * rvX + ux * rvY - bx;
  const dirY = 0 * rvX + uy * rvY - by;
  const dirZ = rz * rvX + uz * rvY - bz;

  if (Math.abs(dirY) < 1e-6) return null;
  const t = -eye[1] / dirY;
  if (t < 0) return null;

  return { x: eye[0] + t * dirX, z: eye[2] + t * dirZ };
}

/** Project a 3D world point to screen pixel coordinates. */
export function worldToScreen(
  wx: number, wy: number, wz: number,
  viewProj: Float32Array, screenW: number, screenH: number,
): { x: number; y: number } | null {
  const cx = viewProj[0]! * wx + viewProj[4]! * wy + viewProj[8]! * wz + viewProj[12]!;
  const cy = viewProj[1]! * wx + viewProj[5]! * wy + viewProj[9]! * wz + viewProj[13]!;
  const cw = viewProj[3]! * wx + viewProj[7]! * wy + viewProj[11]! * wz + viewProj[15]!;
  if (cw <= 0) return null;
  return {
    x: (cx / cw + 1) * 0.5 * screenW,
    y: (1 - cy / cw) * 0.5 * screenH,
  };
}
