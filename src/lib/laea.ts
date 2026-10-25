/**
 * Lambert azimuthal equal-area projection used by the DES cosmic-web poster
 * (des_map/make_filament_map.py). Same conventions as the Python side: east to the
 * LEFT (x grows westward), north up, image row 0 = top.
 */

export interface LaeaProjection {
  ra0: number;
  dec0: number;
  /** [x0, x1, y0, y1] in projection-plane units. */
  extent: [number, number, number, number];
}

const D2R = Math.PI / 180;

export function laeaForward(p: LaeaProjection, ra: number, dec: number): { x: number; y: number } {
  const phi = dec * D2R;
  const dl = (ra - p.ra0) * D2R;
  const phi0 = p.dec0 * D2R;
  const cosc = Math.sin(phi0) * Math.sin(phi) + Math.cos(phi0) * Math.cos(phi) * Math.cos(dl);
  const k = Math.sqrt(2 / Math.max(1 + cosc, 1e-12));
  return {
    x: -k * Math.cos(phi) * Math.sin(dl),
    y: k * (Math.cos(phi0) * Math.sin(phi) - Math.sin(phi0) * Math.cos(phi) * Math.cos(dl)),
  };
}

export function laeaInverse(p: LaeaProjection, x: number, y: number): { ra: number; dec: number } {
  const phi0 = p.dec0 * D2R;
  const rho = Math.hypot(x, y);
  if (rho === 0) return { ra: ((p.ra0 % 360) + 360) % 360, dec: p.dec0 };
  const c = 2 * Math.asin(Math.min(rho / 2, 1));
  const dec = Math.asin(Math.cos(c) * Math.sin(phi0) + (y * Math.sin(c) * Math.cos(phi0)) / rho);
  const ra = p.ra0 * D2R - Math.atan2(x * Math.sin(c), rho * Math.cos(phi0) * Math.cos(c) - y * Math.sin(phi0) * Math.sin(c));
  return { ra: (((ra / D2R) % 360) + 360) % 360, dec: dec / D2R };
}

/** Sky → image pixel (column, row) for an image of `width` × `height` covering `extent`. */
export function skyToPixel(p: LaeaProjection, width: number, height: number, ra: number, dec: number) {
  const { x, y } = laeaForward(p, ra, dec);
  const [x0, x1, y0, y1] = p.extent;
  return { col: ((x - x0) / (x1 - x0)) * (width - 1), row: ((y1 - y) / (y1 - y0)) * (height - 1) };
}

export function pixelToSky(p: LaeaProjection, width: number, height: number, col: number, row: number) {
  const [x0, x1, y0, y1] = p.extent;
  return laeaInverse(p, x0 + (col / (width - 1)) * (x1 - x0), y1 - (row / (height - 1)) * (y1 - y0));
}
