/**
 * Loader for our rebuild of the Hubble COSMOS 3D mass map (written by prep/cosmos_3d.py
 * into data/cosmos/). Values are lens-detection significance in sigma.
 *
 *   cosmos_3d.json           metadata (shape [ny, nx, nd], bounds, z range, peaks)
 *   cosmos_3d.f32.bin        float32 grid, index = depth + nd * (x + nx * y)
 *   cosmos_3d_faint.f32.bin  optional low-confidence "haze" grid, same layout
 */

export interface CosmosPeak {
  ra: number;
  dec: number;
  z: number;
  value: number;
}

export interface CosmosMeta {
  source: string;
  sourceUrl: string;
  nGalaxies: number;
  /** [ny, nx, nd]: declination rows, right-ascension columns, depth (redshift) planes. */
  shape: [number, number, number];
  zNear: number;
  zFar: number;
  bounds: { raMin: number; raMax: number; decMin: number; decMax: number };
  widthArcmin: number;
  faintFile: string | null;
  /** Strongest first. */
  peaks: CosmosPeak[];
}

export interface Cosmos3d {
  meta: CosmosMeta;
  clumps: Float32Array;
  /** Null when the prep run didn't write the haze layer. */
  faint: Float32Array | null;
}

export class CosmosError extends Error {}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isPosInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;
// Only plain file names, so metadata can't point the loader outside data/cosmos/.
const SAFE_FILE = /^[\w.-]+\.f32\.bin$/;

export function parseCosmosMeta(raw: unknown): CosmosMeta {
  if (!isObj(raw)) throw new CosmosError('COSMOS metadata is not an object');
  const { shape, bounds, peaks } = raw;
  if (!Array.isArray(shape) || shape.length !== 3 || !shape.every(isPosInt)) {
    throw new CosmosError('COSMOS shape must be three positive integers [ny, nx, nd]');
  }
  if (!isNum(raw.z_near) || !isNum(raw.z_far) || !(raw.z_far > raw.z_near)) {
    throw new CosmosError('COSMOS z_near/z_far must be numbers with z_far > z_near');
  }
  if (
    !isObj(bounds) ||
    !isNum(bounds.ra_min) ||
    !isNum(bounds.ra_max) ||
    !isNum(bounds.dec_min) ||
    !isNum(bounds.dec_max) ||
    !(bounds.ra_max > bounds.ra_min) ||
    !(bounds.dec_max > bounds.dec_min)
  ) {
    throw new CosmosError('COSMOS bounds are missing or inverted');
  }
  if (!Array.isArray(peaks)) throw new CosmosError('COSMOS peaks must be a list');
  const parsedPeaks = peaks.map((p, i) => {
    if (!isObj(p) || !isNum(p.ra) || !isNum(p.dec) || !isNum(p.z) || !isNum(p.value)) {
      throw new CosmosError(`COSMOS peak ${i} needs numeric ra/dec/z/value`);
    }
    return { ra: p.ra, dec: p.dec, z: p.z, value: p.value };
  });
  parsedPeaks.sort((a, b) => b.value - a.value);
  const faint = raw.faint_file;
  if (faint != null && (typeof faint !== 'string' || !SAFE_FILE.test(faint))) {
    throw new CosmosError('COSMOS faint_file must be a plain *.f32.bin file name');
  }
  return {
    source: typeof raw.source === 'string' ? raw.source : 'COSMOS',
    sourceUrl: typeof raw.source_url === 'string' && /^https:\/\//.test(raw.source_url) ? raw.source_url : '',
    nGalaxies: isNum(raw.n_galaxies) ? raw.n_galaxies : 0,
    shape: shape as [number, number, number],
    zNear: raw.z_near,
    zFar: raw.z_far,
    bounds: { raMin: bounds.ra_min, raMax: bounds.ra_max, decMin: bounds.dec_min, decMax: bounds.dec_max },
    widthArcmin: isNum(raw.width_arcmin) ? raw.width_arcmin : (bounds.ra_max - bounds.ra_min) * 60,
    faintFile: typeof faint === 'string' ? faint : null,
    peaks: parsedPeaks,
  };
}

export const gridLength = (m: CosmosMeta) => m.shape[0] * m.shape[1] * m.shape[2];

/** Value at declination row y, RA column x, depth plane d. */
export function cosmosIndex(m: CosmosMeta, y: number, x: number, d: number): number {
  const [, nx, nd] = m.shape;
  return d + nd * (x + nx * y);
}

function toGrid(buf: ArrayBuffer, m: CosmosMeta, what: string): Float32Array {
  if (buf.byteLength !== gridLength(m) * 4) {
    throw new CosmosError(`${what} has ${buf.byteLength} bytes; expected ${gridLength(m) * 4} for shape ${m.shape.join('×')}`);
  }
  return new Float32Array(buf);
}

/** Load the COSMOS grids from `${root}data/cosmos/`. The haze layer is optional. */
export async function loadCosmos3d(root: string, signal?: AbortSignal): Promise<Cosmos3d> {
  const base = `${root}data/cosmos/`;
  const get = async (name: string) => {
    const res = await fetch(base + name, { signal, cache: 'no-cache' });
    if (!res.ok) throw new CosmosError(`${name}: HTTP ${res.status}`);
    return res;
  };
  const meta = parseCosmosMeta(await (await get('cosmos_3d.json')).json());
  const clumps = toGrid(await (await get('cosmos_3d.f32.bin')).arrayBuffer(), meta, 'cosmos_3d.f32.bin');
  let faint: Float32Array | null = null;
  if (meta.faintFile) {
    try {
      faint = toGrid(await (await get(meta.faintFile)).arrayBuffer(), meta, meta.faintFile);
    } catch (e) {
      if (signal?.aborted) throw e;
      console.warn('COSMOS haze layer unavailable; rerun prep/cosmos_3d.py', e);
    }
  }
  return { meta, clumps, faint };
}
