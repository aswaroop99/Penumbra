import type { SharedView } from '../collab/client';

/**
 * The SpacetimeDB module is unchanged, so a cosmic-web view is carried in the
 * existing `update_view` / `room_state` fields:
 *
 *   field        sim                 box                 slices
 *   ----------   -----------------   -----------------   ---------------------
 *   activeLayer  tab 0 + 3·universe  tab 1               tab 2
 *   ra           S8                  S8                  patch centre RA  (deg)
 *   dec          Ωm                  Ωm                  patch centre Dec (deg)
 *   spread       time (0..1)         clump volume        slice spacing
 *   yaw          camera azimuth      camera azimuth      camera azimuth     (rad)
 *   pitch        camera elevation    camera elevation    camera elevation   (rad)
 *   zoom         camera distance     camera distance     camera distance
 *
 * Camera angles/distance are relative to each view's orbit target, so panning
 * (which moves the target) is deliberately not shared.
 */

export type Tab = 'sim' | 'box' | 'slices';
export const TABS: readonly Tab[] = ['sim', 'box', 'slices'];
export const TAB_LABEL: Record<Tab, string> = {
  sim: 'Simulate',
  box: '3D map',
  slices: 'Survey slices',
};

/** Fixed seeds, so "next universe" is the same universe for everyone in the room. */
export const UNIVERSE_SEEDS = [7, 11, 23, 42, 101] as const;

export const LIMITS = {
  s8: [0.6, 1.0],
  om: [0.2, 0.45],
  time: [0, 1],
  volume: [0.02, 0.2],
  gap: [1.5, 5],
} as const;

export interface Cam {
  /** Azimuth around the orbit target, radians. */
  az: number;
  /** Elevation above the horizontal plane, radians. */
  el: number;
  /** Distance to the orbit target, world units. */
  dist: number;
}

export type CosmicView =
  | { tab: 'sim'; cam: Cam; s8: number; om: number; time: number; universe: number }
  | { tab: 'box'; cam: Cam; s8: number; om: number; volume: number }
  | { tab: 'slices'; cam: Cam; ra: number; dec: number; gap: number };

const clamp = (v: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, v));
const EL_MAX = Math.PI / 2 - 0.01;

export function encodeView(v: CosmicView): SharedView {
  const base = {
    yaw: v.cam.az,
    pitch: v.cam.el,
    zoom: v.cam.dist,
  };
  switch (v.tab) {
    case 'sim':
      return {
        ...base,
        ra: v.s8,
        dec: v.om,
        spread: v.time,
        activeLayer: TABS.indexOf('sim') + 3 * v.universe,
      };
    case 'box':
      return { ...base, ra: v.s8, dec: v.om, spread: v.volume, activeLayer: TABS.indexOf('box') };
    case 'slices':
      return { ...base, ra: v.ra, dec: v.dec, spread: v.gap, activeLayer: TABS.indexOf('slices') };
  }
}

/** Decode a shared view, clamping every value into what the UI supports. */
export function decodeView(s: SharedView): CosmicView {
  const tab = TABS[s.activeLayer % 3];
  const cam: Cam = {
    az: s.yaw,
    el: Math.min(EL_MAX, Math.max(-EL_MAX, s.pitch)),
    dist: Math.max(0.001, s.zoom),
  };
  switch (tab) {
    case 'sim':
      return {
        tab,
        cam,
        s8: clamp(s.ra, LIMITS.s8),
        om: clamp(s.dec, LIMITS.om),
        time: clamp(s.spread, LIMITS.time),
        universe: Math.min(UNIVERSE_SEEDS.length - 1, Math.floor(s.activeLayer / 3)),
      };
    case 'box':
      return {
        tab,
        cam,
        s8: clamp(s.ra, LIMITS.s8),
        om: clamp(s.dec, LIMITS.om),
        volume: clamp(s.spread, LIMITS.volume),
      };
    case 'slices':
      return { tab, cam, ra: s.ra, dec: s.dec, gap: clamp(s.spread, LIMITS.gap) };
  }
}

/** Human-readable tab for a participant's `activeLayer`. */
export const tabLabel = (activeLayer: number): string => TAB_LABEL[TABS[activeLayer % 3]];

/** True when two views are indistinguishable at the precision we bother to publish. */
export function sameView(a: SharedView, b: SharedView): boolean {
  return (
    a.activeLayer === b.activeLayer &&
    Math.abs(a.ra - b.ra) < 0.005 &&
    Math.abs(a.dec - b.dec) < 0.005 &&
    Math.abs(a.spread - b.spread) < 0.002 &&
    Math.abs(a.yaw - b.yaw) < 0.002 &&
    Math.abs(a.pitch - b.pitch) < 0.002 &&
    Math.abs(a.zoom - b.zoom) < Math.max(0.002, a.zoom * 0.002)
  );
}

export function camToOffset({ az, el, dist }: Cam): [number, number, number] {
  return [dist * Math.cos(el) * Math.sin(az), dist * Math.sin(el), dist * Math.cos(el) * Math.cos(az)];
}

export function offsetToCam(x: number, y: number, z: number): Cam {
  const dist = Math.hypot(x, y, z) || 1e-6;
  return { az: Math.atan2(x, z), el: Math.asin(Math.max(-1, Math.min(1, y / dist))), dist };
}
