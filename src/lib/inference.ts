/**
 * The stored cosmology result for a map (Omega_m, S8, ...), produced offline by
 * `inference/run_inference.py` and read here as plain JSON. Nothing is trained or
 * inferred in the browser, and none of it goes through SpacetimeDB: it is static
 * per map. The viewer degrades cleanly: no file, a bad file, or a result computed
 * from a different map all mean "no cosmology card", never an error screen.
 */
import type { Manifest } from './manifest';

export interface Interval {
  median: number;
  lo68: number;
  hi68: number;
  lo95: number;
  hi95: number;
}

export interface Trust {
  nHeldout: number;
  /** Fraction of held-out simulations whose true S8 fell inside the 68% interval. */
  coverage68S8: number;
  /** Binomial 1-sigma uncertainty on that fraction. */
  binomial1sigma: number;
  outOfDistribution: boolean;
}

export interface Comparison {
  planck: { label: string; S8: number; err: number };
  des: { label: string; S8: number; errLo: number; errHi: number };
  tensionVsPlanckSigma: number;
  mcmc: { method: string; S8: number; differenceSigma: number } | null;
}

export interface Inference {
  method: string;
  data: string;
  /** Which map this was computed from; must match the loaded manifest. */
  map: { source: string; nLayers: number };
  /** True for toy/simulated observations: not a scientific result. */
  synthetic: boolean;
  S8: Interval;
  Omega_m: Interval;
  sigma8: Interval | null;
  nTrain: number | null;
  trust: Trust | null;
  comparison: Comparison;
  statement: string;
  caveats: string[];
  /** Known answer, present only for toy observations. */
  truth: { Omega_m: number; S8: number } | null;
  /** Downsampled posterior draws as [Omega_m, S8]. */
  samples: [number, number][];
}

export class InferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InferenceError';
  }
}

const MAX_SAMPLES = 5000;
const MAX_CAVEATS = 12;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

function num(v: unknown, label: string): number {
  if (!isNum(v)) throw new InferenceError(`${label} must be a finite number`);
  return v;
}

function interval(v: unknown, label: string): Interval {
  if (!isObj(v)) throw new InferenceError(`${label} must be an object`);
  const r: Interval = {
    median: num(v.median, `${label}.median`),
    lo68: num(v.lo68, `${label}.lo68`),
    hi68: num(v.hi68, `${label}.hi68`),
    lo95: num(v.lo95, `${label}.lo95`),
    hi95: num(v.hi95, `${label}.hi95`),
  };
  if (!(r.lo95 <= r.lo68 && r.lo68 <= r.median && r.median <= r.hi68 && r.hi68 <= r.hi95)) {
    throw new InferenceError(`${label} interval is not ordered`);
  }
  return r;
}

/** Validate untrusted JSON against the inference contract. Throws InferenceError. */
export function parseInference(input: unknown): Inference {
  if (!isObj(input)) throw new InferenceError('Inference result must be a JSON object');
  if (input.version !== 1) throw new InferenceError(`Unsupported inference version ${String(input.version)}`);
  if (!isStr(input.method)) throw new InferenceError('method is required');
  if (typeof input.synthetic !== 'boolean') throw new InferenceError('synthetic must be a boolean');
  if (!isStr(input.statement)) throw new InferenceError('statement is required');

  const map = input.map;
  if (!isObj(map) || !isStr(map.source) || !Number.isInteger(map.n_layers) || (map.n_layers as number) < 1) {
    throw new InferenceError('map must give the source and layer count it was computed from');
  }

  const S8 = interval(input.S8, 'S8');
  const Omega_m = interval(input.Omega_m, 'Omega_m');
  if (S8.median < 0.2 || S8.median > 1.5) throw new InferenceError('S8 median is implausible');
  if (Omega_m.median <= 0 || Omega_m.median >= 1) throw new InferenceError('Omega_m median is implausible');
  const sigma8 = input.sigma8 === undefined || input.sigma8 === null ? null : interval(input.sigma8, 'sigma8');

  const c = input.comparison;
  if (!isObj(c) || !isObj(c.planck) || !isObj(c.des_y3)) {
    throw new InferenceError('comparison must include planck and des_y3');
  }
  const mcmcIn = c.mcmc;
  let mcmc: Comparison['mcmc'] = null;
  if (isObj(mcmcIn)) {
    const m = interval(mcmcIn.S8, 'comparison.mcmc.S8');
    mcmc = {
      method: isStr(mcmcIn.method) ? mcmcIn.method : 'baseline',
      S8: m.median,
      differenceSigma: num(mcmcIn.difference_sigma, 'comparison.mcmc.difference_sigma'),
    };
  }
  const comparison: Comparison = {
    planck: {
      label: isStr(c.planck.label) ? c.planck.label : 'Planck 2018',
      S8: num(c.planck.S8, 'planck.S8'),
      err: num(c.planck.err, 'planck.err'),
    },
    des: {
      label: isStr(c.des_y3.label) ? c.des_y3.label : 'DES Y3',
      S8: num(c.des_y3.S8, 'des_y3.S8'),
      errLo: num(c.des_y3.err_lo, 'des_y3.err_lo'),
      errHi: num(c.des_y3.err_hi, 'des_y3.err_hi'),
    },
    tensionVsPlanckSigma: num(c.tension_vs_planck_sigma, 'tension_vs_planck_sigma'),
    mcmc,
  };

  let trust: Trust | null = null;
  if (input.trust !== undefined && input.trust !== null) {
    const t = input.trust;
    if (!isObj(t)) throw new InferenceError('trust must be an object');
    const n = num(t.n_heldout, 'trust.n_heldout');
    if (!Number.isInteger(n) || n < 1) throw new InferenceError('trust.n_heldout must be a positive integer');
    const cov = num(t.coverage_68_S8, 'trust.coverage_68_S8');
    if (cov < 0 || cov > 1) throw new InferenceError('trust.coverage_68_S8 must be within [0, 1]');
    trust = {
      nHeldout: n,
      coverage68S8: cov,
      binomial1sigma: num(t.binomial_1sigma_at_68, 'trust.binomial_1sigma_at_68'),
      outOfDistribution: t.out_of_distribution === true,
    };
  }

  let truth: Inference['truth'] = null;
  if (isObj(input.truth)) {
    truth = { Omega_m: num(input.truth.Omega_m, 'truth.Omega_m'), S8: num(input.truth.S8, 'truth.S8') };
  }

  const samplesIn = input.samples ?? [];
  if (!Array.isArray(samplesIn)) throw new InferenceError('samples must be an array');
  if (samplesIn.length > MAX_SAMPLES) throw new InferenceError(`Too many samples (max ${MAX_SAMPLES})`);
  const samples: [number, number][] = samplesIn.map((p, i) => {
    if (!Array.isArray(p) || p.length !== 2 || !isNum(p[0]) || !isNum(p[1])) {
      throw new InferenceError(`Sample ${i} must be an [Omega_m, S8] pair`);
    }
    return [p[0], p[1]];
  });

  const caveatsIn = Array.isArray(input.caveats) ? input.caveats : [];
  const training = isObj(input.training) ? input.training : {};

  return {
    method: input.method,
    data: isStr(input.data) ? input.data : '',
    map: { source: map.source, nLayers: map.n_layers as number },
    synthetic: input.synthetic,
    S8,
    Omega_m,
    sigma8,
    nTrain: isNum(training.n_train) ? training.n_train : null,
    trust,
    comparison,
    statement: input.statement,
    caveats: caveatsIn.filter(isStr).slice(0, MAX_CAVEATS),
    truth,
    samples,
  };
}

/** A result only describes the map it was computed from. */
export function matchesManifest(inf: Inference, m: Manifest): boolean {
  return inf.map.source === m.source && inf.map.nLayers === m.layers.length;
}

/**
 * Load the stored result the manifest points at. Never throws (except on abort):
 * a missing pointer, missing file, malformed file or mismatched map all give `null`,
 * so the rest of the viewer is unaffected.
 */
export async function loadInference(
  manifest: Manifest,
  signal?: AbortSignal,
  /** Where the map's data files are served (the manifest sits at the root; its files under `data/`). */
  base = `${import.meta.env.BASE_URL}data/`
): Promise<Inference | null> {
  if (!manifest.inference) return null;
  const url = `${base}${encodeURIComponent(manifest.inference)}`;
  try {
    const res = await fetch(url, { signal });
    if (!res.ok) return null;
    const inf = parseInference(await res.json());
    if (!matchesManifest(inf, manifest)) {
      console.warn(`${url} was computed from a different map (${inf.map.source}); ignoring it`);
      return null;
    }
    return inf;
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    console.warn(`Ignoring unusable inference result ${url}:`, e instanceof Error ? e.message : e);
    return null;
  }
}

/** Format a value with its asymmetric 68% interval, e.g. `0.760 +0.003 −0.002`. */
export function formatInterval(i: Interval, digits = 3): string {
  const up = (i.hi68 - i.median).toFixed(digits);
  const down = (i.median - i.lo68).toFixed(digits);
  return `${i.median.toFixed(digits)} +${up} −${down}`;
}

export type CoverageVerdict = 'ok' | 'off';

/** Is held-out 68% coverage within 2 binomial sigma of 68%? */
export function coverageVerdict(t: Trust): CoverageVerdict {
  return Math.abs(t.coverage68S8 - 0.68) <= 2 * t.binomial1sigma ? 'ok' : 'off';
}
