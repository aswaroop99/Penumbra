/**
 * Cosmology + Zel'dovich-approximation helpers behind the cosmic-web views.
 * Pure functions only (no DOM / three.js) so they can be unit-tested.
 * Flat ΛCDM, h = 0.674.
 */

export const H = 0.674;
const HUBBLE_TIME_GYR = 977.8 / (100 * H);

/** Age of the universe at redshift z, in Gyr. */
export function ageGyr(z: number, om: number): number {
  const ol = 1 - om;
  return (
    ((2 / (3 * Math.sqrt(ol))) * HUBBLE_TIME_GYR) *
    Math.asinh(Math.sqrt(ol / om) * Math.pow(1 + z, -1.5))
  );
}

export const lookbackGyr = (z: number, om: number): number => ageGyr(0, om) - ageGyr(z, om);

/** Linear growth factor with D(0) = 1 (Carroll, Press & Turner 1992). */
export function growth(z: number, om: number): number {
  const g = (zz: number) => {
    const a3 = Math.pow(1 + zz, 3);
    const e2 = om * a3 + (1 - om);
    const omz = (om * a3) / e2;
    const olz = (1 - om) / e2;
    return (2.5 * omz) / (Math.pow(omz, 4 / 7) - olz + (1 + omz / 2) * (1 + olz / 70));
  };
  return g(z) / (g(0) * (1 + z));
}

/** BBKS transfer function, k in h/Mpc. */
export function transferBBKS(k: number, om: number): number {
  const q = k / (om * H);
  return (
    (Math.log(1 + 2.34 * q) / (2.34 * q)) *
    Math.pow(1 + 3.89 * q + Math.pow(16.1 * q, 2) + Math.pow(5.46 * q, 3) + Math.pow(6.71 * q, 4), -0.25)
  );
}

const tophat = (x: number): number =>
  x < 1e-4 ? 1 : (3 * (Math.sin(x) - x * Math.cos(x))) / (x * x * x);

/** S8 → σ8 at the given Ωm (S8 = σ8 √(Ωm / 0.3)). */
export const sigma8From = (s8: number, om: number): number => s8 / Math.sqrt(om / 0.3);

// ---------------------------------------------------------------------------
// FFT (radix-2, any power-of-two length)
// ---------------------------------------------------------------------------

type Fft1 = (re: Float64Array, im: Float64Array, inverse: boolean) => void;
const fftCache = new Map<number, Fft1>();

function getFFT(n: number): Fft1 {
  const cached = fftCache.get(n);
  if (cached) return cached;
  const levels = Math.log2(n) | 0;
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < levels; b++) r |= ((i >> b) & 1) << (levels - 1 - b);
    rev[i] = r;
  }
  const cs = new Float64Array(n / 2);
  const sn = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cs[i] = Math.cos((2 * Math.PI * i) / n);
    sn[i] = Math.sin((2 * Math.PI * i) / n);
  }
  const f: Fft1 = (re, im, inv) => {
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i];
        re[i] = re[j];
        re[j] = t;
        t = im[i];
        im[i] = im[j];
        im[j] = t;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const a = i + j;
          const b = a + half;
          const c = cs[k];
          const s = inv ? sn[k] : -sn[k];
          const tr = re[b] * c - im[b] * s;
          const ti = re[b] * s + im[b] * c;
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }
  };
  fftCache.set(n, f);
  return f;
}

export type Vec3 = readonly [number, number, number];

/** In-place 3D FFT of a grid stored x-fastest. The inverse transform is normalised. */
export function fft3(re: Float64Array, im: Float64Array, [nx, ny, nz]: Vec3, inverse: boolean): void {
  const N = nx * ny * nz;
  for (const [n, stride] of [
    [nx, 1],
    [ny, nx],
    [nz, nx * ny],
  ] as const) {
    const f = getFFT(n);
    const lr = new Float64Array(n);
    const li = new Float64Array(n);
    for (let s = 0; s < N; s++) {
      if (Math.floor(s / stride) % n !== 0) continue; // only the start of each line
      for (let k = 0; k < n; k++) {
        lr[k] = re[s + k * stride];
        li[k] = im[s + k * stride];
      }
      f(lr, li, inverse);
      for (let k = 0; k < n; k++) {
        re[s + k * stride] = lr[k];
        im[s + k * stride] = li[k];
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < N; i++) {
      re[i] /= N;
      im[i] /= N;
    }
  }
}

/** Calls fn(i, kx, ky, kz, k²) for every Fourier mode of the grid. */
export function forEachMode(
  [nx, ny, nz]: Vec3,
  [Lx, Ly, Lz]: Vec3,
  fn: (i: number, kx: number, ky: number, kz: number, k2: number) => void
): void {
  for (let z = 0; z < nz; z++) {
    const kz = ((2 * Math.PI) / Lz) * (z <= nz / 2 ? z : z - nz);
    for (let y = 0; y < ny; y++) {
      const ky = ((2 * Math.PI) / Ly) * (y <= ny / 2 ? y : y - ny);
      for (let x = 0; x < nx; x++) {
        const kx = ((2 * Math.PI) / Lx) * (x <= nx / 2 ? x : x - nx);
        fn(x + nx * (y + ny * z), kx, ky, kz, kx * kx + ky * ky + kz * kz);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Zel'dovich approximation: initial Gaussian field → displacement field
// ---------------------------------------------------------------------------

/** Small, fast, seedable PRNG. Same seed ⇒ same universe for everyone in a room. */
export function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface KField {
  re: Float64Array;
  im: Float64Array;
}

/** Fourier transform of unit white noise on the grid. */
export function whiteNoiseK(dims: Vec3, seed: number): KField {
  const N = dims[0] * dims[1] * dims[2];
  const rnd = mulberry32(seed);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    re[i] = Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  }
  fft3(re, im, dims, false);
  return { re, im };
}

export interface DisplacementParams {
  om: number;
  sigma8: number;
  /** Gaussian smoothing ("truncated Zel'dovich") that keeps the web sharp instead of smeared. */
  Rs: number;
}

/**
 * Displacement field Ψ (Mpc/h) at z = 0, normalised so the linear field has the requested σ8.
 * Returns one Float32Array per axis.
 */
export function displacementField(
  noise: KField,
  dims: Vec3,
  L: Vec3,
  { om, sigma8, Rs }: DisplacementParams
): [Float32Array, Float32Array, Float32Array] {
  const N = dims[0] * dims[1] * dims[2];
  const r8: [Float64Array, Float64Array] = [new Float64Array(N), new Float64Array(N)];
  const ps = [0, 1, 2].map(
    () => [new Float64Array(N), new Float64Array(N)] as [Float64Array, Float64Array]
  );
  const nyq = dims.map((n, a) => (Math.PI * n) / L[a]);
  forEachMode(dims, L, (i, kx, ky, kz, k2) => {
    if (k2 === 0) return;
    const k = Math.sqrt(k2);
    const T = transferBBKS(k, om);
    const amp = Math.sqrt(Math.pow(k, 0.965)) * T;
    const w8 = tophat(8 * k);
    r8[0][i] = noise.re[i] * amp * w8;
    r8[1][i] = noise.im[i] * amp * w8;
    const g = (amp * Math.exp(-0.5 * k2 * Rs * Rs)) / k2;
    const dr = noise.re[i] * g;
    const di = noise.im[i] * g;
    [kx, ky, kz].forEach((ka, a) => {
      if (Math.abs(Math.abs(ka) - nyq[a]) < 1e-9) return; // drop the Nyquist plane: keeps Ψ real
      ps[a][0][i] = -ka * di; // Ψ_k = i k δ_k / k²
      ps[a][1][i] = ka * dr;
    });
  });
  fft3(r8[0], r8[1], dims, true);
  let ss = 0;
  for (let i = 0; i < N; i++) ss += r8[0][i] * r8[0][i];
  const scale = sigma8 / Math.sqrt(ss / N);
  const out = ps.map(([re, im]) => {
    fft3(re, im, dims, true);
    const f = new Float32Array(N);
    for (let i = 0; i < N; i++) f[i] = re[i] * scale;
    return f;
  });
  return out as [Float32Array, Float32Array, Float32Array];
}
