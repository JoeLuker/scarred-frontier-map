// Robust 32-bit integer hash for coordinate pairs
export const hash = (x: number, y: number, seed: number): number => {
  // Force inputs to 32-bit integers to handle negative coords safely
  let h = (seed | 0) ^ Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0; // Ensure unsigned positive result
};

// Per-octave seed stride for FBM decorrelation (small prime)
const FBM_SEED_STRIDE = 31;

/**
 * Hash normalized to [0, 1) using the full 32-bit range.
 * Replaces the lossy `hash() % N / N` pattern which discards most entropy.
 */
export const hashNorm = (x: number, y: number, seed: number): number =>
  hash(x, y, seed) / 4294967296; // 2^32

// Smoother noise function (Value Noise interpolation)
export const smoothNoise = (x: number, y: number, seed: number): number => {
  const floorX = Math.floor(x);
  const floorY = Math.floor(y);

  const bl = hashNorm(floorX, floorY, seed);
  const br = hashNorm(floorX + 1, floorY, seed);
  const tl = hashNorm(floorX, floorY + 1, seed);
  const tr = hashNorm(floorX + 1, floorY + 1, seed);

  const tX = x - floorX;
  const tY = y - floorY;
  const wX = tX * tX * (3 - 2 * tX);
  const wY = tY * tY * (3 - 2 * tY);

  const b = bl + wX * (br - bl);
  const t = tl + wX * (tr - tl);
  return b + wY * (t - b);
};

// Fractal Brownian Motion with per-octave seed decorrelation
export const fbm = (
  x: number,
  y: number,
  seed: number,
  octaves: number,
  persistence: number = 0.5,
  lacunarity: number = 2.0,
): number => {
  let total = 0;
  let amplitude = 1;
  let maxValue = 0;
  let freq = 1;

  for (let i = 0; i < octaves; i++) {
    total += smoothNoise(x * freq, y * freq, seed + i * FBM_SEED_STRIDE) * amplitude;
    maxValue += amplitude;
    amplitude *= persistence;
    freq *= lacunarity;
  }

  return total / maxValue;
};

