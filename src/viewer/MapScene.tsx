import { Html } from '@react-three/drei';
import { useThree, type ThreeEvent } from '@react-three/fiber';
import { memo, useMemo, useState, type Ref } from 'react';
import { DoubleSide, type Texture } from 'three';
import type { Annotation, Presence } from '../generated/types';
import type { Manifest, Peak } from '../lib/manifest';
import { planeSize, skyToPlane, uvToSky } from '../lib/sky';
import { CameraRig, type RigHandle } from './CameraRig';
import { layerZ, type ViewState } from './types';

export interface Hover {
  ra: number;
  dec: number;
  layer: number;
}

export interface Draft {
  ra: number;
  dec: number;
  bin: number;
}

interface Props {
  manifest: Manifest;
  textures: (Texture | null)[];
  activeLayer: number;
  spread: number;
  isolate: boolean;
  showAllPeaks: boolean;
  annotateMode: boolean;
  annotations: Annotation[];
  others: Presence[];
  presenterHex: string | null;
  draft: Draft | null;
  focusAnnotation: bigint | null;
  rigRef: Ref<RigHandle>;
  initialView: ViewState;
  onViewChange: (v: ViewState) => void;
  onInteract: () => void;
  onHover: (h: Hover | null) => void;
  onPlace: (p: Draft) => void;
  onPeakSelect: (peak: Peak) => void;
}

const GHOST_OPACITY = 0.38;

/** Dev-only: expose the R3F state for debugging / browser automation. */
function DevHandle() {
  const state = useThree();
  if (import.meta.env.DEV) (window as unknown as { __r3f?: unknown }).__r3f = state;
  return null;
}

function peakRadius(snr: number): number {
  return Math.min(0.2, Math.max(0.06, 0.05 + (snr - 4) * 0.02));
}

export const MapScene = memo(function MapScene(props: Props) {
  const {
    manifest,
    textures,
    activeLayer,
    spread,
    isolate,
    showAllPeaks,
    annotateMode,
    annotations,
    others,
    presenterHex,
    draft,
    focusAnnotation,
  } = props;
  const { bounds } = manifest;
  const { width, height } = useMemo(() => planeSize(bounds), [bounds]);
  const n = manifest.layers.length;
  const [hoverPeak, setHoverPeak] = useState<number | null>(null);
  const [hoverAnn, setHoverAnn] = useState<bigint | null>(null);

  const visiblePeaks = useMemo(
    () =>
      manifest.peaks
        .map((p, i) => ({ p, i }))
        .filter(({ p }) => showAllPeaks || p.bin === activeLayer),
    [manifest.peaks, showAllPeaks, activeLayer]
  );

  const lastHover = useMemo(() => ({ t: 0 }), []);

  const onPlaneMove = (e: ThreeEvent<PointerEvent>) => {
    const now = performance.now();
    if (now - lastHover.t < 40 || !e.uv) return;
    lastHover.t = now;
    const sky = uvToSky(bounds, e.uv.x, 1 - e.uv.y);
    props.onHover({ ...sky, layer: activeLayer });
  };

  const onPlaneClick = (e: ThreeEvent<MouseEvent>) => {
    if (!annotateMode || !e.uv || e.delta > 4) return;
    e.stopPropagation();
    const sky = uvToSky(bounds, e.uv.x, 1 - e.uv.y);
    props.onPlace({ ...sky, bin: activeLayer });
  };

  return (
    <>
      <color attach="background" args={['#05060a']} />
      <DevHandle />
      <CameraRig
        bounds={bounds}
        initialView={props.initialView}
        rigRef={props.rigRef}
        onChange={props.onViewChange}
        onInteract={props.onInteract}
      />

      {manifest.layers.map((layer, i) => {
        const tex = textures[i];
        if (!tex) return null;
        const isActive = i === activeLayer;
        const opacity = isActive ? 1 : isolate ? 0 : GHOST_OPACITY;
        if (opacity === 0 && !isActive) return null;
        return (
          <mesh
            key={layer.png}
            position={[0, 0, layerZ(i, spread)]}
            renderOrder={n - i}
            onPointerMove={isActive ? onPlaneMove : undefined}
            onPointerOut={isActive ? () => props.onHover(null) : undefined}
            onClick={isActive ? onPlaneClick : undefined}
          >
            <planeGeometry args={[width, height]} />
            <meshBasicMaterial
              map={tex}
              transparent
              opacity={opacity}
              depthWrite={false}
              toneMapped={false}
              side={DoubleSide}
            />
          </mesh>
        );
      })}

      {/* peaks / clusters from the manifest */}
      {visiblePeaks.map(({ p, i }) => {
        const pos = skyToPlane(bounds, p.ra, p.dec);
        const r = peakRadius(p.snr);
        const isActive = p.bin === activeLayer;
        return (
          <group key={`peak-${i}`} position={[pos.x, pos.y, layerZ(p.bin, spread) + 0.01]}>
            <mesh
              renderOrder={100}
              onPointerOver={(e) => {
                e.stopPropagation();
                setHoverPeak(i);
              }}
              onPointerOut={() => setHoverPeak((h) => (h === i ? null : h))}
              onClick={(e) => {
                if (annotateMode || e.delta > 4) return;
                e.stopPropagation();
                props.onPeakSelect(p);
              }}
            >
              <ringGeometry args={[r * 0.78, r, 32]} />
              <meshBasicMaterial
                color={hoverPeak === i ? '#ffffff' : '#ffd479'}
                transparent
                opacity={isActive ? 0.95 : 0.45}
                depthWrite={false}
                toneMapped={false}
                side={DoubleSide}
              />
            </mesh>
            {hoverPeak === i && (
              <Html center distanceFactor={undefined} style={{ pointerEvents: 'none' }} zIndexRange={[20, 10]}>
                <div className="tip" style={{ transform: 'translateY(-34px)' }}>
                  <strong>Cluster peak</strong>
                  <span>
                    {manifest.layers[p.bin].name} · SNR {p.snr.toFixed(1)} · κ {p.kappa.toFixed(3)}
                  </span>
                  <span>
                    RA {p.ra.toFixed(2)}° · Dec {p.dec.toFixed(2)}°
                  </span>
                </div>
              </Html>
            )}
          </group>
        );
      })}

      {/* shared sky-anchored annotations */}
      {annotations.map((a) => {
        if (a.bin >= n) return null;
        const pos = skyToPlane(bounds, a.ra, a.dec);
        const hot = hoverAnn === a.id || focusAnnotation === a.id;
        return (
          <group key={`ann-${a.id}`} position={[pos.x, pos.y, layerZ(a.bin, spread) + 0.02]}>
            <mesh
              renderOrder={110}
              onPointerOver={(e) => {
                e.stopPropagation();
                setHoverAnn(a.id);
              }}
              onPointerOut={() => setHoverAnn((h) => (h === a.id ? null : h))}
            >
              <circleGeometry args={[hot ? 0.11 : 0.08, 20]} />
              <meshBasicMaterial color={a.authorColor} depthWrite={false} toneMapped={false} />
            </mesh>
            <mesh renderOrder={109} position={[0, 0, -0.001]}>
              <ringGeometry args={[hot ? 0.11 : 0.08, hot ? 0.145 : 0.115, 20]} />
              <meshBasicMaterial color="#ffffff" depthWrite={false} toneMapped={false} />
            </mesh>
            {hot && (
              <Html center style={{ pointerEvents: 'none' }} zIndexRange={[20, 10]}>
                <div className="tip" style={{ transform: 'translateY(-44px)', borderColor: a.authorColor }}>
                  <strong style={{ color: a.authorColor }}>{a.authorName}</strong>
                  <span>{a.text}</span>
                  <span className="dim">
                    {manifest.layers[a.bin].name} · RA {a.ra.toFixed(2)}° · Dec {a.dec.toFixed(2)}°
                  </span>
                </div>
              </Html>
            )}
          </group>
        );
      })}

      {/* pending annotation */}
      {draft && (
        <group
          position={[
            skyToPlane(bounds, draft.ra, draft.dec).x,
            skyToPlane(bounds, draft.ra, draft.dec).y,
            layerZ(draft.bin, spread) + 0.03,
          ]}
        >
          <mesh renderOrder={120}>
            <ringGeometry args={[0.1, 0.14, 24]} />
            <meshBasicMaterial color="#7cf" depthWrite={false} toneMapped={false} />
          </mesh>
        </group>
      )}

      {/* where other people are looking */}
      {others.map((o) => {
        const pos = skyToPlane(bounds, o.viewRa, o.viewDec);
        const layer = Math.min(o.activeLayer, n - 1);
        const isPresenter = presenterHex !== null && o.identity.toHexString() === presenterHex;
        return (
          <group key={`who-${o.identity.toHexString()}`} position={[pos.x, pos.y, layerZ(layer, spread) + 0.04]}>
            <mesh renderOrder={130}>
              <ringGeometry args={[0.22, 0.26, 4, 1, Math.PI / 4]} />
              <meshBasicMaterial color={o.color} transparent opacity={0.9} depthWrite={false} toneMapped={false} />
            </mesh>
            <Html center style={{ pointerEvents: 'none' }} zIndexRange={[15, 5]}>
              <div className="who" style={{ background: o.color, transform: 'translateY(-26px)' }}>
                {isPresenter ? '★ ' : ''}
                {o.name}
              </div>
            </Html>
          </group>
        );
      })}
    </>
  );
});
