/** Camera state in sky terms, so it can be shared between clients with different screens. */
export interface ViewState {
  /** Sky position the camera is centred on (ra in [0, 360)). */
  ra: number;
  dec: number;
  /** Camera distance from the look-at point, in world units. */
  zoom: number;
  /** Orbit azimuth (radians), 0 = looking straight on. */
  yaw: number;
  /** Orbit elevation (radians), 0 = looking straight on; positive tilts to look from above. */
  pitch: number;
}

export const MIN_ZOOM = 2.5;
export const MAX_ZOOM = 30;
export const MAX_YAW = 1.2;
export const MAX_PITCH = 1.0;
/** World-space gap between layers at spread = 1. */
export const LAYER_GAP = 1.0;
export const MAX_SPREAD = 3;
export const DEFAULT_SPREAD = 0.6;

export const DEFAULT_VIEW_ZOOM = 14;

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

export function layerZ(index: number, spread: number): number {
  return -index * spread * LAYER_GAP;
}
