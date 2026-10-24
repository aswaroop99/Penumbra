export interface Bounds {
  ra_min: number;
  ra_max: number;
  dec_min: number;
  dec_max: number;
}

export interface LayerInfo {
  name: string;
  png: string;
  raw: string;
  /** [height, width] */
  shape: [number, number];
  vmin: number;
  vmax: number;
  sigma: number;
}

export interface Peak {
  ra: number;
  dec: number;
  kappa: number;
  snr: number;
  bin: number;
}

export interface Manifest {
  source: string;
  smoothing_arcmin: number;
  coord: string;
  bounds: Bounds;
  convention: string;
  layers: LayerInfo[];
  peaks: Peak[];
  note?: string;
}

export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManifestError';
  }
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** A file name only: no directories, no traversal. */
function safeFileName(v: unknown, label: string): string {
  if (!isStr(v) || /[\\/]/.test(v) || v.includes('..')) {
    throw new ManifestError(`${label} must be a plain file name`);
  }
  return v;
}

/** Validate untrusted JSON against the manifest contract. Throws ManifestError. */
export function parseManifest(input: unknown): Manifest {
  if (!isObj(input)) throw new ManifestError('Manifest must be a JSON object');

  const b = input.bounds;
  if (
    !isObj(b) ||
    !isNum(b.ra_min) ||
    !isNum(b.ra_max) ||
    !isNum(b.dec_min) ||
    !isNum(b.dec_max)
  ) {
    throw new ManifestError('Manifest bounds must have numeric ra_min/ra_max/dec_min/dec_max');
  }
  const bounds: Bounds = {
    ra_min: b.ra_min,
    ra_max: b.ra_max,
    dec_min: b.dec_min,
    dec_max: b.dec_max,
  };
  if (!(bounds.ra_max > bounds.ra_min)) throw new ManifestError('ra_max must exceed ra_min');
  if (!(bounds.dec_max > bounds.dec_min)) throw new ManifestError('dec_max must exceed dec_min');
  if (bounds.ra_max - bounds.ra_min >= 360) {
    throw new ManifestError('RA span must be less than 360 degrees');
  }
  if (bounds.dec_min < -90 || bounds.dec_max > 90) {
    throw new ManifestError('Declination bounds must lie within [-90, 90]');
  }

  if (!Array.isArray(input.layers) || input.layers.length === 0) {
    throw new ManifestError('Manifest must list at least one layer');
  }
  if (input.layers.length > 16) throw new ManifestError('Too many layers (max 16)');

  const layers: LayerInfo[] = input.layers.map((raw, i) => {
    if (!isObj(raw)) throw new ManifestError(`Layer ${i} must be an object`);
    const shape = raw.shape;
    if (
      !Array.isArray(shape) ||
      shape.length !== 2 ||
      !shape.every((n) => Number.isInteger(n) && n > 0)
    ) {
      throw new ManifestError(`Layer ${i} shape must be [height, width] positive integers`);
    }
    if (!isNum(raw.vmin) || !isNum(raw.vmax) || !isNum(raw.sigma)) {
      throw new ManifestError(`Layer ${i} needs numeric vmin/vmax/sigma`);
    }
    return {
      name: isStr(raw.name) ? raw.name : `bin ${i}`,
      png: safeFileName(raw.png, `Layer ${i} png`),
      raw: safeFileName(raw.raw, `Layer ${i} raw`),
      shape: [shape[0] as number, shape[1] as number],
      vmin: raw.vmin,
      vmax: raw.vmax,
      sigma: raw.sigma,
    };
  });

  const peaksIn = input.peaks ?? [];
  if (!Array.isArray(peaksIn)) throw new ManifestError('peaks must be an array');
  const peaks: Peak[] = [];
  for (const [i, p] of peaksIn.entries()) {
    if (!isObj(p) || !isNum(p.ra) || !isNum(p.dec) || !isNum(p.kappa) || !isNum(p.snr)) {
      throw new ManifestError(`Peak ${i} needs numeric ra/dec/kappa/snr`);
    }
    const bin = isNum(p.bin) ? p.bin : 0;
    if (!Number.isInteger(bin) || bin < 0 || bin >= layers.length) {
      throw new ManifestError(`Peak ${i} references unknown layer ${String(p.bin)}`);
    }
    peaks.push({ ra: p.ra, dec: p.dec, kappa: p.kappa, snr: p.snr, bin });
  }

  return {
    source: isStr(input.source) ? input.source : 'unknown',
    smoothing_arcmin: isNum(input.smoothing_arcmin) ? input.smoothing_arcmin : 0,
    coord: isStr(input.coord) ? input.coord : 'C',
    bounds,
    convention: isStr(input.convention) ? input.convention : '',
    layers,
    peaks,
    note: isStr(input.note) ? input.note : undefined,
  };
}

/** 53-bit string hash (cyrb53); stable across runs, not cryptographic. */
function hash53(str: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const n = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return n.toString(16).padStart(14, '0');
}

/**
 * Identifies the map geometry + data contract. Rooms and annotations carry this
 * so flags can never silently attach to an incompatible (e.g. regenerated real-data) map.
 */
export function manifestVersion(m: Manifest): string {
  const canonical = JSON.stringify({
    b: [m.bounds.ra_min, m.bounds.ra_max, m.bounds.dec_min, m.bounds.dec_max],
    l: m.layers.map((l) => [l.shape[0], l.shape[1], l.vmin, l.vmax]),
    p: m.peaks.map((p) => [p.ra, p.dec, p.bin]),
    s: m.source,
  });
  return `m1-${hash53(canonical)}`;
}

export async function loadManifest(
  url = `${import.meta.env.BASE_URL}manifest.json`,
  signal?: AbortSignal
): Promise<Manifest> {
  let res: Response;
  try {
    res = await fetch(url, { signal });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new ManifestError(`Could not reach ${url}`);
  }
  if (!res.ok) throw new ManifestError(`Could not load ${url} (HTTP ${res.status})`);
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new ManifestError(`${url} is not valid JSON`);
  }
  return parseManifest(json);
}
