import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  coverageVerdict,
  formatInterval,
  InferenceError,
  loadInference,
  matchesManifest,
  parseInference,
} from './inference';
import { parseManifest } from './manifest';

const readJson = (rel: string) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));
const realInference = readJson('../../data/inference.json');
const realManifest = parseManifest(readJson('../../data/manifest.json'));

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

function interval(median: number, d68: number, d95: number) {
  return { median, lo68: median - d68, hi68: median + d68, lo95: median - d95, hi95: median + d95 };
}

function minimal() {
  return {
    version: 1,
    method: 'sbi-NPE x1',
    data: 'observed map',
    map: { source: 'toy', n_layers: 1 },
    synthetic: true,
    S8: interval(0.76, 0.01, 0.02),
    Omega_m: interval(0.3, 0.02, 0.04),
    comparison: {
      planck: { label: 'Planck', S8: 0.832, err: 0.013 },
      des_y3: { label: 'DES', S8: 0.759, err_lo: 0.023, err_hi: 0.025 },
      tension_vs_planck_sigma: 4.1,
    },
    statement: 'S8 = 0.760',
  };
}

describe('parseInference', () => {
  it('accepts the shipped inference.json and binds it to the shipped manifest', () => {
    const inf = parseInference(realInference);
    expect(inf.S8.median).toBeGreaterThan(0.6);
    expect(inf.Omega_m.median).toBeGreaterThan(0.1);
    expect(inf.samples.length).toBeGreaterThan(0);
    expect(matchesManifest(inf, realManifest)).toBe(true);
    expect(realManifest.inference).toBe('inference.json');
  });

  it('accepts a minimal result and defaults the optional parts', () => {
    const inf = parseInference(minimal());
    expect(inf.sigma8).toBeNull();
    expect(inf.trust).toBeNull();
    expect(inf.truth).toBeNull();
    expect(inf.samples).toEqual([]);
    expect(inf.caveats).toEqual([]);
    expect(inf.comparison.mcmc).toBeNull();
  });

  it('rejects non-objects and unsupported versions', () => {
    expect(() => parseInference(null)).toThrow(InferenceError);
    expect(() => parseInference([])).toThrow(InferenceError);
    expect(() => parseInference({ ...minimal(), version: 2 })).toThrow(/version/);
  });

  it('rejects incomplete results', () => {
    for (const key of ['method', 'synthetic', 'statement', 'map', 'S8', 'Omega_m', 'comparison'] as const) {
      const m: Record<string, unknown> = minimal();
      delete m[key];
      expect(() => parseInference(m), key).toThrow(InferenceError);
    }
    const noPlanck: Record<string, unknown> = minimal();
    noPlanck.comparison = { des_y3: (minimal().comparison as Record<string, unknown>).des_y3 };
    expect(() => parseInference(noPlanck)).toThrow(/planck/);
  });

  it('rejects unordered, non-finite and implausible values', () => {
    const swapped = minimal();
    swapped.S8 = { ...swapped.S8, lo68: 0.9 };
    expect(() => parseInference(swapped)).toThrow(/not ordered/);

    const nan = minimal();
    nan.Omega_m = { ...nan.Omega_m, median: Number.NaN };
    expect(() => parseInference(JSON.parse(JSON.stringify(nan)))).toThrow(InferenceError);

    const silly = minimal();
    silly.S8 = interval(3, 0.01, 0.02);
    expect(() => parseInference(silly)).toThrow(/implausible/);

    const sigma = { ...minimal(), sigma8: { median: 1, lo68: 2, hi68: 3, lo95: 0, hi95: 4 } };
    expect(() => parseInference(sigma)).toThrow(/sigma8/);
  });

  it('rejects malformed samples and caps their number', () => {
    expect(() => parseInference({ ...minimal(), samples: [[0.3]] })).toThrow(/Sample 0/);
    expect(() => parseInference({ ...minimal(), samples: [[0.3, 'x']] })).toThrow(/Sample 0/);
    expect(() => parseInference({ ...minimal(), samples: 'nope' })).toThrow(/samples/);
    const many = Array.from({ length: 5001 }, () => [0.3, 0.76]);
    expect(() => parseInference({ ...minimal(), samples: many })).toThrow(/Too many/);
  });

  it('validates the trust block when present', () => {
    const base = { n_heldout: 68, coverage_68_S8: 0.62, binomial_1sigma_at_68: 0.057 };
    expect(parseInference({ ...minimal(), trust: base }).trust?.nHeldout).toBe(68);
    expect(() => parseInference({ ...minimal(), trust: { ...base, n_heldout: 0 } })).toThrow(/n_heldout/);
    expect(() => parseInference({ ...minimal(), trust: { ...base, coverage_68_S8: 1.4 } })).toThrow(/coverage/);
    expect(() => parseInference({ ...minimal(), trust: 5 })).toThrow(/trust/);
  });
});

describe('matchesManifest', () => {
  it('requires the same source and layer count', () => {
    const inf = parseInference(realInference);
    const other = clone(realManifest);
    other.source = 'DES Y3 real';
    expect(matchesManifest(inf, other)).toBe(false);
    const fewer = clone(realManifest);
    fewer.layers = fewer.layers.slice(0, 2);
    expect(matchesManifest(inf, fewer)).toBe(false);
  });
});

describe('loadInference', () => {
  afterEach(() => vi.unstubAllGlobals());

  const withPointer = () => ({ ...clone(realManifest), inference: 'inference.json' });
  const stubFetch = (res: Partial<Response> | Error) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        if (res instanceof Error) throw res;
        return res as Response;
      })
    );

  it('returns null without fetching when the manifest has no pointer', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    const m = clone(realManifest);
    delete m.inference;
    expect(await loadInference(m, undefined, '/')).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  it('loads and validates a good result', async () => {
    stubFetch({ ok: true, json: async () => realInference });
    const inf = await loadInference(withPointer(), undefined, '/data/');
    expect(inf?.S8.median).toBeCloseTo(realInference.S8.median, 6);
  });

  it('fetches from the data/ directory, next to the layer files', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url);
        return { ok: true, json: async () => realInference } as Response;
      })
    );
    await loadInference(withPointer());
    // The dev/preview server only serves /manifest.json and /data/*; anything else falls through to index.html.
    expect(urls).toHaveLength(1);
    expect(urls[0]).toMatch(/\/data\/inference\.json$/);
  });

  it('degrades to null on a missing file, bad JSON, a bad shape or a network error', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubFetch({ ok: false, status: 404 });
    expect(await loadInference(withPointer(), undefined, '/')).toBeNull();
    stubFetch({
      ok: true,
      json: async () => {
        throw new SyntaxError('bad json');
      },
    });
    expect(await loadInference(withPointer(), undefined, '/')).toBeNull();
    stubFetch({ ok: true, json: async () => ({ version: 1 }) });
    expect(await loadInference(withPointer(), undefined, '/')).toBeNull();
    stubFetch(new TypeError('network down'));
    expect(await loadInference(withPointer(), undefined, '/')).toBeNull();
    warn.mockRestore();
  });

  it('ignores a result computed from a different map', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stale = clone(realInference);
    stale.map.source = 'some other map';
    stubFetch({ ok: true, json: async () => stale });
    expect(await loadInference(withPointer(), undefined, '/')).toBeNull();
    warn.mockRestore();
  });

  it('lets an abort propagate', async () => {
    stubFetch(new DOMException('aborted', 'AbortError'));
    await expect(loadInference(withPointer(), undefined, '/')).rejects.toThrow(/aborted/);
  });
});

describe('formatting helpers', () => {
  it('formats an asymmetric interval', () => {
    expect(formatInterval({ median: 0.76, lo68: 0.758, hi68: 0.763, lo95: 0.75, hi95: 0.77 })).toBe(
      '0.760 +0.003 −0.002'
    );
  });

  it('flags coverage more than two binomial sigma from 68%', () => {
    const t = { nHeldout: 68, coverage68S8: 0.62, binomial1sigma: 0.057, outOfDistribution: false };
    expect(coverageVerdict(t)).toBe('ok');
    expect(coverageVerdict({ ...t, coverage68S8: 0.45 })).toBe('off');
  });
});
