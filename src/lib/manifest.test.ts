import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ManifestError, manifestVersion, parseManifest } from './manifest';

const real = JSON.parse(readFileSync(new URL('../../data/manifest.json', import.meta.url), 'utf8'));

function minimal() {
  return {
    bounds: { ra_min: -65, ra_max: 105, dec_min: -70, dec_max: 10 },
    layers: [
      { name: 'a', png: 'a.png', raw: 'a.bin', shape: [10, 20], vmin: -1, vmax: 1, sigma: 0.1 },
    ],
    peaks: [{ ra: 1, dec: -2, kappa: 0.1, snr: 5, bin: 0 }],
  };
}

describe('parseManifest', () => {
  it('accepts the shipped manifest.json', () => {
    const m = parseManifest(real);
    expect(m.layers).toHaveLength(4);
    expect(m.layers[0].shape).toEqual([1129, 2400]);
    expect(m.peaks.length).toBeGreaterThan(0);
    for (const p of m.peaks) expect(p.bin).toBeLessThan(m.layers.length);
  });

  it('rejects non-objects and missing bounds', () => {
    expect(() => parseManifest(null)).toThrow(ManifestError);
    expect(() => parseManifest({ ...minimal(), bounds: undefined })).toThrow(/bounds/);
  });

  it('rejects inverted or oversized bounds', () => {
    const m = minimal();
    m.bounds.ra_max = -100;
    expect(() => parseManifest(m)).toThrow(/ra_max/);
    const m2 = minimal();
    m2.bounds.dec_max = 95;
    expect(() => parseManifest(m2)).toThrow(/Declination/);
    const m3 = minimal();
    m3.bounds.ra_min = -400;
    expect(() => parseManifest(m3)).toThrow(/360/);
  });

  it('rejects empty layers and bad shapes', () => {
    expect(() => parseManifest({ ...minimal(), layers: [] })).toThrow(/layer/);
    const m = minimal();
    (m.layers[0] as { shape: number[] }).shape = [0, 5];
    expect(() => parseManifest(m)).toThrow(/shape/);
  });

  it('rejects file names that escape the data directory', () => {
    const m = minimal();
    m.layers[0].png = '../secret.png';
    expect(() => parseManifest(m)).toThrow(/plain file name/);
    const m2 = minimal();
    m2.layers[0].raw = 'sub/dir.bin';
    expect(() => parseManifest(m2)).toThrow(/plain file name/);
  });

  it('keeps an optional inference pointer and drops an unsafe one', () => {
    expect(parseManifest({ ...minimal(), inference: 'inference.json' }).inference).toBe('inference.json');
    expect(parseManifest(minimal()).inference).toBeUndefined();
    expect(parseManifest({ ...minimal(), inference: '../x.json' }).inference).toBeUndefined();
    expect(parseManifest({ ...minimal(), inference: 'a/b.json' }).inference).toBeUndefined();
  });

  it('rejects peaks pointing at missing layers', () => {
    const m = minimal();
    m.peaks[0].bin = 3;
    expect(() => parseManifest(m)).toThrow(/unknown layer/);
  });
});

describe('manifestVersion', () => {
  it('is stable and short enough for the database', () => {
    const a = manifestVersion(parseManifest(real));
    const b = manifestVersion(parseManifest(JSON.parse(JSON.stringify(real))));
    expect(a).toBe(b);
    expect(a.length).toBeLessThanOrEqual(64);
  });

  it('ignores the inference pointer, so existing rooms stay valid', () => {
    const plain = parseManifest(minimal());
    const pointed = parseManifest({ ...minimal(), inference: 'inference.json' });
    expect(manifestVersion(pointed)).toBe(manifestVersion(plain));
  });

  it('changes when geometry changes', () => {
    const base = parseManifest(minimal());
    const moved = parseManifest({
      ...minimal(),
      bounds: { ra_min: -64, ra_max: 105, dec_min: -70, dec_max: 10 },
    });
    expect(manifestVersion(moved)).not.toBe(manifestVersion(base));
  });
});
