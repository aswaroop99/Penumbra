import { describe, expect, it } from 'vitest';
import {
  ageGyr,
  displacementField,
  fft3,
  growth,
  linearSigmaR,
  lookbackGyr,
  mulberry32,
  seedDisplacement,
  sigma8From,
  whiteNoiseK,
  type Seed,
  type Vec3,
} from './physics';

describe('cosmology', () => {
  it('puts the age of the universe near 13.8 Gyr for Planck parameters', () => {
    expect(ageGyr(0, 0.315)).toBeGreaterThan(13.5);
    expect(ageGyr(0, 0.315)).toBeLessThan(14.1);
  });

  it('has zero lookback today and more further out', () => {
    expect(lookbackGyr(0, 0.315)).toBeCloseTo(0, 9);
    expect(lookbackGyr(1, 0.315)).toBeGreaterThan(lookbackGyr(0.5, 0.315));
  });

  it('normalises the growth factor to 1 today and shrinks toward the past', () => {
    expect(growth(0, 0.315)).toBeCloseTo(1, 9);
    expect(growth(1, 0.315)).toBeLessThan(1);
    expect(growth(10, 0.315)).toBeLessThan(growth(1, 0.315));
  });

  it('converts S8 to sigma8', () => {
    expect(sigma8From(0.8, 0.3)).toBeCloseTo(0.8, 12);
    expect(sigma8From(0.8, 0.4)).toBeLessThan(0.8);
  });
});

describe('FFT', () => {
  it('inverts itself on a non-cubic grid', () => {
    const dims: Vec3 = [8, 4, 4];
    const N = 128;
    const rnd = mulberry32(1);
    const re = Float64Array.from({ length: N }, () => rnd());
    const orig = Float64Array.from(re);
    const im = new Float64Array(N);
    fft3(re, im, dims, false);
    fft3(re, im, dims, true);
    for (let i = 0; i < N; i++) {
      expect(re[i]).toBeCloseTo(orig[i], 9);
      expect(im[i]).toBeCloseTo(0, 9);
    }
  });
});

describe('Zel\u2019dovich field', () => {
  const dims: Vec3 = [16, 16, 16];
  const L: Vec3 = [80, 80, 80];

  it('is deterministic per seed and differs between seeds', () => {
    const a = whiteNoiseK(dims, 7);
    const b = whiteNoiseK(dims, 7);
    const c = whiteNoiseK(dims, 11);
    expect(Array.from(a.re.slice(0, 8))).toEqual(Array.from(b.re.slice(0, 8)));
    expect(Array.from(a.re.slice(0, 8))).not.toEqual(Array.from(c.re.slice(0, 8)));
  });

  it('displaces more when sigma8 is larger', () => {
    const noise = whiteNoiseK(dims, 7);
    const rms = (s8: number) => {
      const [x] = displacementField(noise, dims, L, { om: 0.315, sigma8: s8, Rs: 3 });
      return Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);
    };
    expect(rms(1.0)).toBeGreaterThan(rms(0.6));
    expect(rms(0.8)).toBeGreaterThan(0);
  });
});

describe('planted seeds', () => {
  const NG = 32;
  const dims: Vec3 = [NG, NG, NG];
  const Lb = 160;
  const L: Vec3 = [Lb, Lb, Lb];
  const cell = Lb / NG;
  const at = (x: number, y: number, z: number) => x + NG * (y + NG * z);
  const pos = (i: number) => (i + 0.5) * cell - Lb / 2;
  const seed = (over: Partial<Seed> = {}): Seed => ({ x: 0, y: 0, z: 0, R: 8, A: 1, ...over });

  it('gives zero displacement without seeds', () => {
    for (const f of seedDisplacement([], dims, L, 3)) expect(f.every((v) => v === 0)).toBe(true);
  });

  // Probe points a few cells from a seed at the centre, in several directions.
  const probes: [number, number, number][] = [
    [NG / 2 + 4, NG / 2, NG / 2],
    [NG / 2 - 5, NG / 2 + 2, NG / 2],
    [NG / 2, NG / 2 - 3, NG / 2 + 4],
  ];
  const pull = (psi: Float32Array[], s: Seed, [x, y, z]: [number, number, number]) => {
    const i = at(x, y, z);
    return psi[0][i] * (s.x - pos(x)) + psi[1][i] * (s.y - pos(y)) + psi[2][i] * (s.z - pos(z));
  };

  it('pulls matter toward a peak and pushes it away from a void', () => {
    const s = seed({ x: pos(NG / 2), y: pos(NG / 2), z: pos(NG / 2) });
    const peak = seedDisplacement([s], dims, L, 3);
    const voidS = { ...s, A: -1 };
    const vd = seedDisplacement([voidS], dims, L, 3);
    for (const p of probes) {
      expect(pull(peak, s, p)).toBeGreaterThan(0);
      expect(pull(vd, voidS, p)).toBeLessThan(0);
    }
  });

  it('is linear in the seed amplitude', () => {
    const a = seedDisplacement([seed({ A: 1.3 })], dims, L, 3);
    const b = seedDisplacement([seed({ A: 2.6 })], dims, L, 3);
    for (let a3 = 0; a3 < 3; a3++)
      for (let i = 0; i < a[a3].length; i += 97) expect(b[a3][i]).toBeCloseTo(2 * a[a3][i], 6);
  });

  it('wraps periodically across the box edge', () => {
    // A seed on the x boundary must give the centred seed's field shifted by half a box.
    const mid = seedDisplacement([seed({ x: 0 })], dims, L, 3);
    const edge = seedDisplacement([seed({ x: Lb / 2 })], dims, L, 3);
    for (let a3 = 0; a3 < 3; a3++)
      for (let z = 0; z < NG; z += 3)
        for (let y = 0; y < NG; y += 3)
          for (let x = 0; x < NG; x++)
            expect(edge[a3][at(x, y, z)]).toBeCloseTo(mid[a3][at((x + NG / 2) % NG, y, z)], 5);
    // Either side of the boundary, matter falls toward it: +x just inside +L/2, −x just inside −L/2.
    const y = NG / 2;
    expect(edge[0][at(NG - 1, y, y)]).toBeGreaterThan(0);
    expect(edge[0][at(0, y, y)]).toBeLessThan(0);
  });

  it('has larger linear rms on smaller smoothing scales', () => {
    const noise = whiteNoiseK(dims, 7);
    const sig = (R: number) => linearSigmaR(noise, dims, L, { om: 0.3, sigma8: 0.76 }, R);
    expect(sig(4)).toBeGreaterThan(sig(8));
    expect(sig(8)).toBeGreaterThan(sig(16));
    expect(sig(8)).toBeGreaterThan(0.3);
    expect(sig(8)).toBeLessThan(2);
  });
});
