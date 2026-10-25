import { describe, expect, it } from 'vitest';
import type { Bounds } from './manifest';
import {
  f16ToNumber,
  gridFromBuffer,
  isInFootprint,
  normalizeRa,
  planeSize,
  planeToSky,
  sampleGrid,
  skyToPlane,
  skyToUV,
  unwrapRa,
  uvInside,
  uvToSky,
  wrapDeltaRa,
} from './sky';

const B: Bounds = { ra_min: -65, ra_max: 105, dec_min: -70, dec_max: 10 };

describe('RA wrapping', () => {
  it('normalizes into [0, 360)', () => {
    expect(normalizeRa(-65)).toBe(295);
    expect(normalizeRa(360)).toBe(0);
    expect(normalizeRa(725)).toBe(5);
    expect(normalizeRa(-0)).toBe(0);
  });

  it('computes the shortest signed delta', () => {
    expect(wrapDeltaRa(359, 1)).toBe(-2);
    expect(wrapDeltaRa(1, 359)).toBe(2);
    expect(wrapDeltaRa(180, 0)).toBe(180);
  });

  it('maps 0–360 RA into the (possibly negative) bounds branch', () => {
    expect(unwrapRa(316.0547, B)).toBeCloseTo(316.0547 - 360, 6); // peak near the west edge
    expect(unwrapRa(4.1123, B)).toBeCloseTo(4.1123, 6);
    expect(unwrapRa(-65 + 360, B)).toBeCloseTo(-65, 6);
  });
});

describe('sky ↔ uv (east-left)', () => {
  it('puts ra_max on the left and dec_max on the top', () => {
    expect(skyToUV(B, 105, 10)).toEqual({ u: 0, v: 0 });
    expect(skyToUV(B, -65, -70)).toEqual({ u: 1, v: 1 });
  });

  it('treats RA 295° and -65° as the same point', () => {
    const a = skyToUV(B, 295, -30);
    const b = skyToUV(B, -65, -30);
    expect(a.u).toBeCloseTo(b.u, 9);
    expect(a.u).toBeCloseTo(1, 9);
  });

  it('higher RA is further left', () => {
    expect(skyToUV(B, 60, -30).u).toBeLessThan(skyToUV(B, 20, -30).u);
  });

  it('round-trips and returns canonical RA', () => {
    for (const [ra, dec] of [
      [4.1123, -54.4369],
      [316.0547, -29.2277],
      [93.9551, -32.6198],
      [0, 0],
    ]) {
      const uv = skyToUV(B, ra, dec);
      const back = uvToSky(B, uv.u, uv.v);
      expect(back.ra).toBeCloseTo(normalizeRa(ra), 9);
      expect(back.dec).toBeCloseTo(dec, 9);
    }
  });

  it('flags points outside the map', () => {
    expect(uvInside(skyToUV(B, 150, -30))).toBe(false); // ra beyond ra_max
    expect(uvInside(skyToUV(B, 20, 40))).toBe(false); // dec above dec_max
    expect(uvInside(skyToUV(B, 20, -30))).toBe(true);
  });
});

describe('sky ↔ plane', () => {
  const { width, height } = planeSize(B);

  it('sizes the plane from the bounds', () => {
    expect(width).toBeCloseTo(17, 9);
    expect(height).toBeCloseTo(8, 9);
  });

  it('puts the map centre at the origin and east to the left (−x)', () => {
    const c = skyToPlane(B, 20, -30);
    expect(c.x).toBeCloseTo(0, 9);
    expect(c.y).toBeCloseTo(0, 9);
    expect(skyToPlane(B, 105, -30).x).toBeCloseTo(-width / 2, 9);
    expect(skyToPlane(B, -65, -30).x).toBeCloseTo(width / 2, 9);
    expect(skyToPlane(B, 20, 10).y).toBeCloseTo(height / 2, 9);
    expect(skyToPlane(B, 20, -70).y).toBeCloseTo(-height / 2, 9);
  });

  it('round-trips plane coordinates', () => {
    const p = skyToPlane(B, 316.0547, -29.2277);
    const s = planeToSky(B, p.x, p.y);
    expect(s.ra).toBeCloseTo(316.0547, 6);
    expect(s.dec).toBeCloseTo(-29.2277, 6);
  });
});

describe('float16 + masked footprint', () => {
  it('decodes representative half floats', () => {
    expect(f16ToNumber(0x0000)).toBe(0);
    expect(f16ToNumber(0x3c00)).toBe(1);
    expect(f16ToNumber(0xc000)).toBe(-2);
    expect(f16ToNumber(0x3555)).toBeCloseTo(1 / 3, 3);
    expect(f16ToNumber(0x7e00)).toBeNaN();
    expect(f16ToNumber(0x7c00)).toBe(Infinity);
    expect(f16ToNumber(0x0001)).toBeCloseTo(2 ** -24, 12); // subnormal
  });

  // 2 rows × 4 cols; left half (cols 0-1) valid=1.0, right half masked (NaN)
  const NAN = 0x7e00;
  const ONE = 0x3c00;
  const grid = (() => {
    const buf = new Uint16Array([ONE, ONE, NAN, NAN, ONE, ONE, NAN, NAN]);
    return gridFromBuffer(buf.buffer, [2, 4]);
  })();
  const b: Bounds = { ra_min: 0, ra_max: 40, dec_min: 0, dec_max: 20 };

  it('rejects buffers of the wrong size', () => {
    expect(() => gridFromBuffer(new ArrayBuffer(6), [2, 4])).toThrow(/expected 16/);
  });

  it('samples valid and masked pixels', () => {
    expect(sampleGrid(grid, 0.1, 0.1)).toBe(1);
    expect(sampleGrid(grid, 0.9, 0.1)).toBeNaN();
    expect(sampleGrid(grid, 1, 1)).toBeNaN(); // last pixel, clamped, masked
    expect(sampleGrid(grid, 1.2, 0.5)).toBeNaN(); // outside image
  });

  it('treats masked pixels as outside the footprint', () => {
    // column 0 is ra_max (east-left): ra=35 is on the valid left half, ra=5 on the masked right half
    expect(isInFootprint(grid, b, 35, 10)).toBe(true);
    expect(isInFootprint(grid, b, 5, 10)).toBe(false);
    expect(isInFootprint(grid, b, 100, 10)).toBe(false);
  });
});
