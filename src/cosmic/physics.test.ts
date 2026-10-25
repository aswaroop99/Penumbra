import { describe, expect, it } from 'vitest';
import {
  ageGyr,
  displacementField,
  fft3,
  growth,
  lookbackGyr,
  mulberry32,
  sigma8From,
  whiteNoiseK,
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
