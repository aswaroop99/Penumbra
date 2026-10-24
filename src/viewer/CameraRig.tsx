import { OrbitControls } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import { useCallback, useEffect, useImperativeHandle, useRef, type Ref } from 'react';
import { MOUSE, TOUCH } from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import type { Bounds } from '../lib/manifest';
import { normalizeRa, planeSize, planeToSky, skyToPlane, wrapDeltaRa } from '../lib/sky';
import { clamp, MAX_PITCH, MAX_YAW, MAX_ZOOM, MIN_ZOOM, type ViewState } from './types';

export interface RigHandle {
  getView: () => ViewState;
  /** Camera distance at which the whole map fits the viewport. */
  fitZoom: () => number;
  /** Fly back to the initial framing (map fitted to the screen). */
  reset: () => void;
  /** Move the camera. `rate` is the smoothing speed (1/s); omit `instant` to animate. */
  flyTo: (view: Partial<ViewState>, opts?: { instant?: boolean; rate?: number }) => void;
}

interface Props {
  bounds: Bounds;
  /** Applied once on mount. */
  initialView: ViewState;
  rigRef: Ref<RigHandle>;
  /** Called whenever the camera moves (user input or programmatic). */
  onChange: (view: ViewState) => void;
  /** Called when the user grabs the camera (drag / wheel / touch). */
  onInteract: () => void;
}

const HALF_PI = Math.PI / 2;

export function CameraRig({ bounds, initialView, rigRef, onChange, onInteract }: Props) {
  const controls = useRef<OrbitControlsImpl>(null);
  const camera = useThree((s) => s.camera);
  const aspect = useThree((s) => s.size.width / Math.max(1, s.size.height));
  const flight = useRef<{ target: ViewState; rate: number } | null>(null);
  const { width, height } = planeSize(bounds);

  const fitZoom = useCallback((): number => {
    const fov = 'fov' in camera ? (camera as { fov: number }).fov : 45;
    const tan = Math.tan((fov * Math.PI) / 360);
    const need = Math.max(width / 2 / (tan * aspect), height / 2 / tan) * 1.08;
    return clamp(need, MIN_ZOOM, MAX_ZOOM);
  }, [camera, aspect, width, height]);

  const read = useCallback((): ViewState => {
    const c = controls.current;
    if (!c) return { ra: 0, dec: 0, zoom: 14, yaw: 0, pitch: 0 };
    const sky = planeToSky(bounds, c.target.x, c.target.y);
    return {
      ra: sky.ra,
      dec: sky.dec,
      zoom: c.getDistance(),
      yaw: c.getAzimuthalAngle(),
      pitch: c.getPolarAngle() - HALF_PI,
    };
  }, [bounds]);

  const write = useCallback(
    (v: ViewState) => {
      const c = controls.current;
      if (!c) return;
      const p = skyToPlane(bounds, v.ra, v.dec);
      const x = clamp(p.x, -width / 2, width / 2);
      const y = clamp(p.y, -height / 2, height / 2);
      const dist = clamp(v.zoom, MIN_ZOOM, MAX_ZOOM);
      const az = clamp(v.yaw, -MAX_YAW, MAX_YAW);
      const polar = HALF_PI + clamp(v.pitch, -MAX_PITCH, MAX_PITCH);
      c.target.set(x, y, 0);
      camera.position.set(
        x + dist * Math.sin(polar) * Math.sin(az),
        y + dist * Math.cos(polar),
        dist * Math.sin(polar) * Math.cos(az)
      );
      c.update();
    },
    [bounds, camera, width, height]
  );

  useImperativeHandle(
    rigRef,
    () => ({
      getView: read,
      fitZoom,
      reset: () => {
        flight.current = { target: { ...initialView, zoom: fitZoom() }, rate: 4 };
      },
      flyTo: (partial, opts) => {
        const target = { ...read(), ...partial };
        if (opts?.instant) {
          flight.current = null;
          write(target);
        } else {
          flight.current = { target, rate: opts?.rate ?? 4 };
        }
      },
    }),
    [read, write, fitZoom, initialView]
  );

  useEffect(() => {
    write({ ...initialView, zoom: fitZoom() });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bounds]);

  useFrame((_, dt) => {
    const f = flight.current;
    if (!f || !controls.current) return;
    const cur = read();
    const k = 1 - Math.exp(-f.rate * Math.min(dt, 0.1));
    const t = f.target;
    const dRa = wrapDeltaRa(t.ra, cur.ra);
    const next: ViewState = {
      ra: normalizeRa(cur.ra + dRa * k),
      dec: cur.dec + (t.dec - cur.dec) * k,
      zoom: Math.exp(Math.log(cur.zoom) + (Math.log(t.zoom) - Math.log(cur.zoom)) * k),
      yaw: cur.yaw + (t.yaw - cur.yaw) * k,
      pitch: cur.pitch + (t.pitch - cur.pitch) * k,
    };
    const done =
      Math.abs(dRa) < 0.02 &&
      Math.abs(t.dec - cur.dec) < 0.02 &&
      Math.abs(Math.log(t.zoom / cur.zoom)) < 0.003 &&
      Math.abs(t.yaw - cur.yaw) < 0.003 &&
      Math.abs(t.pitch - cur.pitch) < 0.003;
    if (done) {
      flight.current = null;
      write(t);
    } else {
      write(next);
    }
  });

  const handleChange = useCallback(() => {
    const c = controls.current;
    if (!c) return;
    // Keep the look-at point on the map: pan is screen-space, so re-seat z and clamp x/y.
    const x = clamp(c.target.x, -width / 2, width / 2);
    const y = clamp(c.target.y, -height / 2, height / 2);
    const dx = x - c.target.x;
    const dy = y - c.target.y;
    const dz = -c.target.z;
    if (dx !== 0 || dy !== 0 || dz !== 0) {
      c.target.set(x, y, 0);
      camera.position.x += dx;
      camera.position.y += dy;
      camera.position.z += dz;
    }
    onChange(read());
  }, [camera, height, onChange, read, width]);

  const handleStart = useCallback(() => {
    flight.current = null;
    onInteract();
  }, [onInteract]);

  return (
    <OrbitControls
      ref={controls as Ref<OrbitControlsImpl>}
      makeDefault
      enableDamping
      dampingFactor={0.12}
      screenSpacePanning
      zoomSpeed={0.8}
      panSpeed={1}
      minDistance={MIN_ZOOM}
      maxDistance={MAX_ZOOM}
      minPolarAngle={HALF_PI - MAX_PITCH}
      maxPolarAngle={HALF_PI + MAX_PITCH}
      minAzimuthAngle={-MAX_YAW}
      maxAzimuthAngle={MAX_YAW}
      mouseButtons={{ LEFT: MOUSE.PAN, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.ROTATE }}
      touches={{ ONE: TOUCH.PAN, TWO: TOUCH.DOLLY_ROTATE }}
      onChange={handleChange}
      onStart={handleStart}
    />
  );
}
