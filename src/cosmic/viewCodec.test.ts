import { describe, expect, it } from 'vitest';
import {
  camToOffset,
  decodeView,
  encodeView,
  offsetToCam,
  sameView,
  tabLabel,
  UNIVERSE_SEEDS,
  type CosmicView,
} from './viewCodec';

const cam = { az: 0.7, el: 0.3, dist: 12 };

describe('viewCodec', () => {
  it('round-trips every tab', () => {
    const views: CosmicView[] = [
      { tab: 'sim', cam, s8: 0.82, om: 0.3, time: 0.4, universe: 3 },
      { tab: 'box', cam, s8: 0.7, om: 0.25, volume: 0.1 },
      { tab: 'slices', cam, ra: 150.5, dec: -20.25, gap: 3.2 },
    ];
    for (const v of views) expect(decodeView(encodeView(v))).toEqual(v);
  });

  it('keeps every encoded value inside what the backend accepts', () => {
    const v = encodeView({ tab: 'sim', cam, s8: 1, om: 0.45, time: 1, universe: UNIVERSE_SEEDS.length - 1 });
    expect(v.activeLayer).toBeLessThan(16); // MAX_LAYERS in the SpacetimeDB module
    expect(v.dec).toBeGreaterThanOrEqual(-90);
    expect(v.dec).toBeLessThanOrEqual(90);
    expect(v.ra).toBeGreaterThanOrEqual(-360);
    expect(v.ra).toBeLessThanOrEqual(720);
  });

  it('clamps out-of-range input from other clients', () => {
    const v = decodeView({ ra: 5, dec: 3, zoom: -1, yaw: 0, pitch: 9, activeLayer: 14, spread: 7 });
    expect(v.tab).toBe('slices');
    expect(v.cam.dist).toBeGreaterThan(0);
    expect(v.cam.el).toBeLessThan(Math.PI / 2);
    if (v.tab === 'slices') expect(v.gap).toBe(5);
    const sim = decodeView({ ra: 5, dec: 3, zoom: 1, yaw: 0, pitch: 0, activeLayer: 15, spread: -2 });
    expect(sim).toMatchObject({ tab: 'sim', s8: 1, om: 0.45, time: 0, universe: UNIVERSE_SEEDS.length - 1 });
  });

  it('names a participant\u2019s tab', () => {
    expect(tabLabel(0)).toBe('Simulate');
    expect(tabLabel(4)).toBe('3D map');
    expect(tabLabel(2)).toBe('Survey slices');
  });

  it('detects meaningful change only', () => {
    const a = encodeView({ tab: 'box', cam, s8: 0.8, om: 0.3, volume: 0.07 });
    expect(sameView(a, { ...a, yaw: a.yaw + 0.0001 })).toBe(true);
    expect(sameView(a, { ...a, yaw: a.yaw + 0.05 })).toBe(false);
    expect(sameView(a, { ...a, activeLayer: 0 })).toBe(false);
  });

  it('converts camera offsets both ways', () => {
    const [x, y, z] = camToOffset(cam);
    const back = offsetToCam(x, y, z);
    expect(back.az).toBeCloseTo(cam.az, 9);
    expect(back.el).toBeCloseTo(cam.el, 9);
    expect(back.dist).toBeCloseTo(cam.dist, 9);
  });
});
