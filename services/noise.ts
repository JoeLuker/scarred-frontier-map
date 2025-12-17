
// Robust 32-bit integer hash for coordinate pairs
export const hash = (x: number, y: number, seed: number): number => {
    // Force inputs to 32-bit integers to handle negative coords safely
    let h = (seed | 0) ^ Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return (h ^ (h >>> 16)) >>> 0; // Ensure unsigned positive result
};

// Smoother noise function (Value Noise interpolation)
export const smoothNoise = (x: number, y: number, seed: number): number => {
    const floorX = Math.floor(x);
    const floorY = Math.floor(y);
    
    // Corners
    const s = seed;
    const bl = (hash(floorX, floorY, s) % 1000) / 1000;
    const br = (hash(floorX + 1, floorY, s) % 1000) / 1000;
    const tl = (hash(floorX, floorY + 1, s) % 1000) / 1000;
    const tr = (hash(floorX + 1, floorY + 1, s) % 1000) / 1000;

    // Interpolation weights (Smoothstep)
    const tX = x - floorX;
    const tY = y - floorY;
    const wX = tX * tX * (3 - 2 * tX);
    const wY = tY * tY * (3 - 2 * tY);

    // Bilinear Interpolation
    const b = bl + wX * (br - bl);
    const t = tl + wX * (tr - tl);
    return b + wY * (t - b);
};

// Fractal Brownian Motion
export const fbm = (x: number, y: number, seed: number, octaves: number, persistence: number = 0.5, lacunarity: number = 2.0): number => {
    let total = 0;
    let amplitude = 1;
    let maxValue = 0;
    let freq = 1;

    for (let i = 0; i < octaves; i++) {
        total += smoothNoise(x * freq, y * freq, seed) * amplitude;
        maxValue += amplitude;
        amplitude *= persistence;
        freq *= lacunarity;
    }

    return total / maxValue;
};

// Domain Warping
export const domainWarp = (x: number, y: number, seed: number): number => {
    const qx = fbm(x + 0.0, y + 0.0, seed, 2);
    const qy = fbm(x + 5.2, y + 1.3, seed, 2);

    const rx = fbm(x + 4 * qx + 1.7, y + 4 * qy + 9.2, seed, 2);
    const ry = fbm(x + 4 * qx + 8.3, y + 4 * qy + 2.8, seed, 2);

    return fbm(x + 4 * rx, y + 4 * ry, seed, 4); 
};
