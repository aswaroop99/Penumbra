import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { laeaForward, laeaInverse, pixelToSky, skyToPixel, type LaeaProjection } from './laea';

const P: LaeaProjection = { ra0: 30, dec0: -40, extent: [-1, 1, -1, 1] };

describe('Lambert azimuthal equal-area', () => {
  it('puts the centre at the origin', () => {
    const { x, y } = laeaForward(P, 30, -40);
    expect(x).toBeCloseTo(0, 12);
    expect(y).toBeCloseTo(0, 12);
  });

  it('puts east on the left and north up', () => {
    expect(laeaForward(P, 40, -40).x).toBeLessThan(0);
    expect(laeaForward(P, 20, -40).x).toBeGreaterThan(0);
    expect(laeaForward(P, 30, -30).y).toBeGreaterThan(0);
  });

  it('round-trips sky → plane → sky', () => {
    for (const [ra, dec] of [
      [300, -60],
      [0.5, 2],
      [95, -20],
      [30, -40],
    ]) {
      const { x, y } = laeaForward(P, ra, dec);
      const back = laeaInverse(P, x, y);
      expect(back.ra).toBeCloseTo(ra, 8);
      expect(back.dec).toBeCloseTo(dec, 8);
    }
  });

  it('matches the pixel positions the Python exporter wrote for its peaks', () => {
    const meta = JSON.parse(readFileSync(new URL('../../data/web_des.json', import.meta.url), 'utf8'));
    const [h, w] = meta.shape;
    for (const pk of meta.peaks.slice(0, 10)) {
      const { col, row } = skyToPixel(meta.projection, w, h, pk.ra, pk.dec);
      expect(Math.abs(col - pk.px[0])).toBeLessThan(1);
      expect(Math.abs(row - pk.px[1])).toBeLessThan(1);
      const sky = pixelToSky(meta.projection, w, h, pk.px[0], pk.px[1]);
      expect(sky.dec).toBeCloseTo(pk.dec, 2);
    }
  });
});
