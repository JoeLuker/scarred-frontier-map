import { CAMERA } from '../../../core/constants';
import { type OrbitalCamera, getViewProjection } from '../../../core/camera';

export type { OrbitalCamera };

export interface CameraState extends OrbitalCamera {}

/**
 * Camera control system. Manages orbital camera state based on keyboard input.
 * Mouse/trackpad handling remains in the React layer (Phase 3).
 */
export class InputSystem {
  readonly name = 'InputSystem';

  /** Apply WASD/QE keyboard movement to camera state. */
  tickKeys(keysDown: Set<string>, camera: CameraState, dt: number): void {
    if (keysDown.size === 0) return;

    const speed = camera.distance * 0.012 * (dt / (1 / 60));
    const cosAz = Math.cos(camera.azimuth);
    const sinAz = Math.sin(camera.azimuth);

    let dx = 0;
    let dz = 0;
    if (keysDown.has('w')) { dx -= sinAz; dz -= cosAz; }
    if (keysDown.has('s')) { dx += sinAz; dz += cosAz; }
    if (keysDown.has('a')) { dx -= cosAz; dz += sinAz; }
    if (keysDown.has('d')) { dx += cosAz; dz -= sinAz; }

    camera.targetX += dx * speed;
    camera.targetZ += dz * speed;

    const rotSpeed = 0.03 * (dt / (1 / 60));
    if (keysDown.has('q')) { camera.azimuth -= rotSpeed; }
    if (keysDown.has('e')) { camera.azimuth += rotSpeed; }
  }

  /** Compute the view-projection matrix for the current camera + aspect ratio. */
  computeViewProjection(camera: CameraState, aspect: number): Float32Array {
    return getViewProjection(camera, CAMERA.FOV, aspect, CAMERA.NEAR, CAMERA.FAR);
  }
}
