import type { Bounds, LayerInfo } from './manifest';

/**
 * Coordinate helpers. Canonical sky coordinates are celestial (ra, dec) in degrees
 * plus a layer index (`bin`). The map is plate carrée with column 0 = ra_max
 * (east on the left, astronomical convention) and row 0 = dec_max.
 */

/** World units per degree on the rendered map plane. */
export const UNITS_PER_DEG = 0.1;

/** RA in [0, 360). */
export function normalizeRa(ra: number): number {
  const r = ra % 360;
  return r < 0 ? r + 360 : r === 0 ? 0 : r;
}

/** Smallest signed RA difference a - b in (-180, 180]. */
export function wrapDeltaRa(a: number, b: number): number {
  let d = (a - b) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/**
 * Express `ra` in the same branch as the map bounds (which may be negative,
 * e.g. [-65, 105]) by picking the representative within 180° of the map centre.
 */
export function unwrapRa(ra: number, b: Bounds): number {
  const center = (b.ra_min + b.ra_max) / 2;
  return center + wrapDeltaRa(ra, center);
}

export interface UV {
  /** 0 at the left edge (ra_max) → 1 at the right edge (ra_min). */
  u: number;
  /** 0 at the top edge (dec_max) → 1 at the bottom edge (dec_min). */
  v: number;
}

export function skyToUV(b: Bounds, ra: number, dec: number): UV {
  const r = unwrapRa(ra, b);
  return {
    u: (b.ra_max - r) / (b.ra_max - b.ra_min),
    v: (b.dec_max - dec) / (b.dec_max - b.dec_min),
  };
}

/** Inverse of skyToUV. Returned RA is canonical, in [0, 360). */
export function uvToSky(b: Bounds, u: number, v: number): { ra: number; dec: number } {
  return {
    ra: normalizeRa(b.ra_max - u * (b.ra_max - b.ra_min)),
    dec: b.dec_max - v * (b.dec_max - b.dec_min),
  };
}

export function uvInside({ u, v }: UV): boolean {
  return u >= 0 && u <= 1 && v >= 0 && v <= 1;
}

export function planeSize(b: Bounds, unitsPerDeg = UNITS_PER_DEG): { width: number; height: number } {
  return {
    width: (b.ra_max - b.ra_min) * unitsPerDeg,
    height: (b.dec_max - b.dec_min) * unitsPerDeg,
  };
}

/** Sky → plane-local (x right, y up), plane centred on the origin. East is left. */
export function skyToPlane(
  b: Bounds,
  ra: number,
  dec: number,
  unitsPerDeg = UNITS_PER_DEG
): { x: number; y: number } {
  const { width, height } = planeSize(b, unitsPerDeg);
  const { u, v } = skyToUV(b, ra, dec);
  return { x: (u - 0.5) * width, y: (0.5 - v) * height };
}

export function planeToSky(
  b: Bounds,
  x: number,
  y: number,
  unitsPerDeg = UNITS_PER_DEG
): { ra: number; dec: number } {
  const { width, height } = planeSize(b, unitsPerDeg);
  return uvToSky(b, x / width + 0.5, 0.5 - y / height);
}

// ---------------------------------------------------------------------------
// Raw float16 grids (row-major, height × width, NaN = outside the survey footprint)
// ---------------------------------------------------------------------------

/** Decode an IEEE-754 half float (bit pattern) to a JS number. */
export function f16ToNumber(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exp = (bits >> 10) & 0x1f;
  const frac = bits & 0x3ff;
  if (exp === 0) return sign * 2 ** -14 * (frac / 1024);
  if (exp === 0x1f) return frac ? NaN : sign * Infinity;
  return sign * 2 ** (exp - 15) * (1 + frac / 1024);
}

export interface RawGrid {
  height: number;
  width: number;
  data: Uint16Array;
}

export function gridFromBuffer(buf: ArrayBuffer, shape: [number, number]): RawGrid {
  const [height, width] = shape;
  if (buf.byteLength !== height * width * 2) {
    throw new Error(
      `Raw grid is ${buf.byteLength} bytes; expected ${height * width * 2} for ${height}×${width} float16`
    );
  }
  return { height, width, data: new Uint16Array(buf) };
}

/** κ at (u, v), or NaN if masked / outside the image. */
export function sampleGrid(grid: RawGrid, u: number, v: number): number {
  if (!(u >= 0 && u <= 1 && v >= 0 && v <= 1)) return NaN;
  const col = Math.min(grid.width - 1, Math.floor(u * grid.width));
  const row = Math.min(grid.height - 1, Math.floor(v * grid.height));
  return f16ToNumber(grid.data[row * grid.width + col]);
}

/** True when the sky position lies inside the layer's unmasked survey footprint. */
export function isInFootprint(grid: RawGrid, b: Bounds, ra: number, dec: number): boolean {
  const uv = skyToUV(b, ra, dec);
  return Number.isFinite(sampleGrid(grid, uv.u, uv.v));
}

export async function loadRawGrid(url: string, layer: LayerInfo, signal?: AbortSignal): Promise<RawGrid> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Could not load ${url} (HTTP ${res.status})`);
  return gridFromBuffer(await res.arrayBuffer(), layer.shape);
}

export function formatRa(ra: number): string {
  return `${normalizeRa(ra).toFixed(2)}°`;
}

export function formatDec(dec: number): string {
  return `${dec >= 0 ? '+' : '−'}${Math.abs(dec).toFixed(2)}°`;
}
