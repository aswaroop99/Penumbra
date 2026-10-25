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

/** √P(k) shape (n_s = 0.965, BBKS transfer) that colours unit white noise into the linear field. */
const powerAmp = (k: number, om: number): number => Math.sqrt(Math.pow(k, 0.965)) * transferBBKS(k, om);

/** Real-space rms of noise × √P × W(k), via Parseval (no FFT needed). */
function linearRms(noise: KField, dims: Vec3, L: Vec3, om: number, W: (k: number) => number): number {
  const N = dims[0] * dims[1] * dims[2];
  let ss = 0;
  forEachMode(dims, L, (i, _kx, _ky, _kz, k2) => {
    if (k2 === 0) return;
    const k = Math.sqrt(k2);
    const a = powerAmp(k, om) * W(k);
    ss += (noise.re[i] * noise.re[i] + noise.im[i] * noise.im[i]) * a * a;
  });
  return Math.sqrt(ss) / N;
}

/** Factor that turns noise × √P into a linear field with the requested σ8 (8 Mpc/h top-hat). */
const sigma8Scale = (noise: KField, dims: Vec3, L: Vec3, om: number, sigma8: number): number =>
  sigma8 / linearRms(noise, dims, L, om, (k) => tophat(8 * k));

/**
 * rms of the σ8-normalised linear field (z = 0) smoothed with a Gaussian of radius R (Mpc/h).
 * Sets the scale of a "ν-sigma" seed.
 */
export function linearSigmaR(
  noise: KField,
  dims: Vec3,
  L: Vec3,
  { om, sigma8 }: { om: number; sigma8: number },
  R: number
): number {
  return (
    sigma8Scale(noise, dims, L, om, sigma8) *
    linearRms(noise, dims, L, om, (k) => Math.exp(-0.5 * k * k * R * R))
  );
}

/**
 * Zel'dovich displacement from a Fourier-space density field: Ψ_k = i k δ_k / k² · exp(−k²Rs²/2).
 * Drops k = 0 and the Nyquist planes (keeps Ψ real). Consumes dRe/dIm.
 */
function psiFromDelta(
  dRe: Float64Array,
  dIm: Float64Array,
  dims: Vec3,
  L: Vec3,
  Rs: number,
  scale: number
): [Float32Array, Float32Array, Float32Array] {
  const N = dims[0] * dims[1] * dims[2];
  const ps = [0, 1, 2].map(
    () => [new Float64Array(N), new Float64Array(N)] as [Float64Array, Float64Array]
  );
  const nyq = dims.map((n, a) => (Math.PI * n) / L[a]);
  forEachMode(dims, L, (i, kx, ky, kz, k2) => {
    if (k2 === 0) return;
    const g = Math.exp(-0.5 * k2 * Rs * Rs) / k2;
    const dr = dRe[i] * g;
    const di = dIm[i] * g;
    [kx, ky, kz].forEach((ka, a) => {
      if (Math.abs(Math.abs(ka) - nyq[a]) < 1e-9) return; // drop the Nyquist plane: keeps Ψ real
      ps[a][0][i] = -ka * di; // Ψ_k = i k δ_k / k²
      ps[a][1][i] = ka * dr;
    });
  });
  const out = ps.map(([re, im]) => {
    fft3(re, im, dims, true);
    const f = new Float32Array(N);
    for (let i = 0; i < N; i++) f[i] = re[i] * scale;
    return f;
  });
  return out as [Float32Array, Float32Array, Float32Array];
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
  const dRe = new Float64Array(N);
  const dIm = new Float64Array(N);
  forEachMode(dims, L, (i, _kx, _ky, _kz, k2) => {
    if (k2 === 0) return;
    const amp = powerAmp(Math.sqrt(k2), om);
    dRe[i] = noise.re[i] * amp;
    dIm[i] = noise.im[i] * amp;
  });
  return psiFromDelta(dRe, dIm, dims, L, Rs, sigma8Scale(noise, dims, L, om, sigma8));
}

/**
 * Amplitude of a seed of peak height ν (in units of σ_R). A Gaussian bump of width R, smoothed
 * on its own scale R, keeps 2^(−3/2) of its height; this makes it add ν σ_R to the R-smoothed field.
 */
export const seedAmplitude = (nu: number, sigmaR: number): number => 2 * Math.SQRT2 * nu * sigmaR;

/** A planted density bump: centre (box coordinates centred on 0, Mpc/h), Gaussian radius R, height A. */
export interface Seed {
  x: number;
  y: number;
  z: number;
  R: number;
  A: number;
}

/**
 * Extra displacement (Mpc/h, z = 0) from Gaussian bumps added to the linear density field:
 * δ_seed(x) = Σ A_i exp(−|x − x_i|² / 2R_i²), periodic (minimum-image distance).
 * Uses the same Zel'dovich operator and truncation as `displacementField`; add it after
 * the σ8 normalisation so a seed never rescales the rest of the universe.
 */
export function seedDisplacement(
  seeds: readonly Seed[],
  dims: Vec3,
  L: Vec3,
  Rs: number
): [Float32Array, Float32Array, Float32Array] {
  const [nx, ny, nz] = dims;
  const N = nx * ny * nz;
  if (seeds.length === 0) return [new Float32Array(N), new Float32Array(N), new Float32Array(N)];
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  // Grid samples sit at cell centres, matching how particles look up Ψ.
  const wrap = (d: number, La: number) => d - La * Math.round(d / La);
  for (const s of seeds) {
    const inv = 1 / (2 * s.R * s.R);
    const dx = Float64Array.from({ length: nx }, (_, x) => {
      const d = wrap(((x + 0.5) * L[0]) / nx - L[0] / 2 - s.x, L[0]);
      return Math.exp(-d * d * inv);
    });
    const dy = Float64Array.from({ length: ny }, (_, y) => {
      const d = wrap(((y + 0.5) * L[1]) / ny - L[1] / 2 - s.y, L[1]);
      return Math.exp(-d * d * inv);
    });
    const dz = Float64Array.from({ length: nz }, (_, z) => {
      const d = wrap(((z + 0.5) * L[2]) / nz - L[2] / 2 - s.z, L[2]);
      return Math.exp(-d * d * inv);
    });
    // The Gaussian is separable, so build it from three 1D profiles.
    for (let z = 0, i = 0; z < nz; z++)
      for (let y = 0; y < ny; y++) {
        const yz = s.A * dy[y] * dz[z];
        for (let x = 0; x < nx; x++, i++) re[i] += yz * dx[x];
      }
  }
  fft3(re, im, dims, false);
  return psiFromDelta(re, im, dims, L, Rs, 1);
}
