import { Canvas } from '@react-three/fiber';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CollabPanel } from './collab/CollabPanel';
import { DEFAULT_ROOM } from './collab/connection';
import { useRoom, type Profile, type SharedView } from './collab/useRoom';
import { manifestVersion, type Manifest, type Peak } from './lib/manifest';
import { cleanRoomName } from './lib/room';
import { isInFootprint, sampleGrid, skyToUV } from './lib/sky';
import { throttle } from './lib/throttle';
import { ControlsPanel } from './viewer/ControlsPanel';
import type { RigHandle } from './viewer/CameraRig';
import { MapScene, type Draft, type Hover } from './viewer/MapScene';
import {
  DEFAULT_SPREAD,
  DEFAULT_VIEW_ZOOM,
  type ViewState,
} from './viewer/types';
import { useLayerTextures, useRawGrids } from './viewer/useMapData';

const PALETTE = ['#4cc9f0', '#f72585', '#ffd166', '#06d6a0', '#b388ff', '#ff9f68', '#9bf6ff', '#caffbf'];

function initialRoom(): string {
  const q = new URLSearchParams(location.search).get('room');
  return (q && cleanRoomName(q)) || cleanRoomName(DEFAULT_ROOM) || 'penumbra-demo';
}

function initialProfile(): Profile {
  try {
    const raw = localStorage.getItem('penumbra.profile');
    if (raw) {
      const p = JSON.parse(raw) as Partial<Profile>;
      if (typeof p.name === 'string' && p.name && typeof p.color === 'string' && /^#[0-9a-f]{6}$/i.test(p.color)) {
        return { name: p.name.slice(0, 32), color: p.color };
      }
    }
  } catch {
    /* ignore corrupt storage */
  }
  return {
    name: `Guest-${Math.floor(1000 + Math.random() * 9000)}`,
    color: PALETTE[Math.floor(Math.random() * PALETTE.length)],
  };
}

export function Shell({ manifest }: { manifest: Manifest }) {
  const version = useMemo(() => manifestVersion(manifest), [manifest]);
  const { bounds } = manifest;
  const initialView = useMemo<ViewState>(
    () => ({
      ra: (((bounds.ra_min + bounds.ra_max) / 2) % 360 + 360) % 360,
      dec: (bounds.dec_min + bounds.dec_max) / 2,
      zoom: DEFAULT_VIEW_ZOOM,
      yaw: 0,
      pitch: 0,
    }),
    [bounds]
  );

  // ---- local UI state
  const [activeLayer, setActiveLayer] = useState(0);
  const [spread, setSpread] = useState(DEFAULT_SPREAD);
  const [isolate, setIsolate] = useState(false);
  const [showAllPeaks, setShowAllPeaks] = useState(false);
  const [annotateMode, setAnnotateMode] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const [focusAnnotation, setFocusAnnotation] = useState<bigint | null>(null);
  const [following, setFollowing] = useState(false);
  const [roomId, setRoomId] = useState(initialRoom);
  const [profile, setProfileState] = useState<Profile>(initialProfile);

  // ---- data
  const tex = useLayerTextures(manifest);
  const grids = useRawGrids(manifest, activeLayer);
  const api = useRoom(roomId, profile, version);

  // ---- camera
  const rigRef = useRef<RigHandle>(null);
  const latestView = useRef<ViewState>(initialView);
  const live = useRef({ activeLayer, spread, api });
  live.current = { activeLayer, spread, api };
  const lastSent = useRef<SharedView | null>(null);

  const publish = useMemo(
    () =>
      throttle(
        () => {
          const { activeLayer: al, spread: sp, api: a } = live.current;
          const v = latestView.current;
          const next: SharedView = { ...v, activeLayer: al, spread: sp };
          const prev = lastSent.current;
          if (
            prev &&
            Math.abs(prev.ra - next.ra) < 0.01 &&
            Math.abs(prev.dec - next.dec) < 0.01 &&
            Math.abs(prev.zoom - next.zoom) < 0.01 &&
            Math.abs(prev.yaw - next.yaw) < 0.002 &&
            Math.abs(prev.pitch - next.pitch) < 0.002 &&
            prev.activeLayer === next.activeLayer &&
            prev.spread === next.spread
          ) {
            return;
          }
          lastSent.current = next;
          a.publishView(next);
        },
        () => (live.current.api.isPresenter ? 120 : 700)
      ),
    []
  );
  useEffect(() => () => publish.cancel(), [publish]);

  const onViewChange = useCallback(
    (v: ViewState) => {
      latestView.current = v;
      publish();
    },
    [publish]
  );

  // Send our state on join and whenever layer/spread change.
  useEffect(() => {
    if (api.joined) {
      lastSent.current = null;
      publish();
    }
  }, [api.joined, activeLayer, spread, publish]);

  // ---- follow presenter
  const room = api.room;
  const presenterOther = api.presenter && !api.isPresenter ? api.presenter : null;
  useEffect(() => {
    if (api.isPresenter || !presenterOther) setFollowing(false);
  }, [api.isPresenter, presenterOther]);

  useEffect(() => {
    if (!following || !room || !presenterOther) return;
    setActiveLayer(Math.min(room.activeLayer, manifest.layers.length - 1));
    setSpread(room.spread);
    rigRef.current?.flyTo(
      { ra: room.viewRa, dec: room.viewDec, zoom: room.viewZoom, yaw: room.viewYaw, pitch: room.viewPitch },
      { rate: 9 }
    );
  }, [following, room, presenterOther, manifest.layers.length]);

  const onInteract = useCallback(() => setFollowing(false), []);

  // ---- actions
  const flyToSky = useCallback((ra: number, dec: number, layer: number, zoom = 6) => {
    setFollowing(false);
    setActiveLayer(layer);
    rigRef.current?.flyTo({ ra, dec, zoom, yaw: 0, pitch: 0 });
  }, []);

  const onPeakSelect = useCallback((p: Peak) => flyToSky(p.ra, p.dec, p.bin), [flyToSky]);

  const resetView = useCallback(() => {
    setFollowing(false);
    setActiveLayer(0);
    setSpread(DEFAULT_SPREAD);
    rigRef.current?.reset();
  }, []);

  const onPlace = useCallback(
    async (p: Draft) => {
      setNotice(null);
      try {
        const grid = await grids.ensure(p.bin);
        if (!isInFootprint(grid, bounds, p.ra, p.dec)) {
          setNotice('That spot is outside the survey footprint (masked sky). Pick a covered area.');
          return;
        }
        setDraft(p);
      } catch {
        setNotice('Could not check the survey footprint for this layer; try again.');
      }
    },
    [grids, bounds]
  );

  const cancelAnnotate = useCallback(() => {
    setDraft(null);
    setAnnotateMode(false);
    setNotice(null);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancelAnnotate();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cancelAnnotate]);

  // Switching layers invalidates a pending draft (it is bound to a layer).
  useEffect(() => {
    setDraft((d) => (d && d.bin !== activeLayer ? null : d));
  }, [activeLayer]);

  const changeRoom = useCallback((next: string) => {
    setRoomId(next);
    setFollowing(false);
    setDraft(null);
    const url = new URL(location.href);
    url.searchParams.set('room', next);
    history.replaceState(null, '', url);
  }, []);

  const commitProfile = useCallback(
    (p: Profile) => {
      setProfileState(p);
      try {
        localStorage.setItem('penumbra.profile', JSON.stringify(p));
      } catch {
        /* ignore */
      }
      api.setProfile(p);
    },
    [api]
  );

  const others = useMemo(
    () => api.participants.filter((p) => p.identity.toHexString() !== api.identityHex),
    [api.participants, api.identityHex]
  );
  const presenterHex = room?.presenter?.toHexString() ?? null;

  const readout = useMemo(() => {
    if (!hover) return null;
    const grid = grids.get(hover.layer);
    const uv = skyToUV(bounds, hover.ra, hover.dec);
    const kappa = grid ? sampleGrid(grid, uv.u, uv.v) : undefined;
    return { ...hover, kappa };
    // grids.get is stable; re-evaluate when a grid finishes loading via `grids`
  }, [hover, grids, bounds]);

  const topPeaks = useMemo(
    () => [...manifest.peaks].sort((a, b) => b.snr - a.snr).slice(0, 12),
    [manifest.peaks]
  );

  return (
    <div className="shell">
      <Canvas
        className="canvas"
        camera={{ position: [0, 0, DEFAULT_VIEW_ZOOM], fov: 45, near: 0.1, far: 200 }}
        dpr={[1, 2]}
        flat
        style={{ cursor: annotateMode ? 'crosshair' : 'grab' }}
      >
        <MapScene
          manifest={manifest}
          textures={tex.textures}
          activeLayer={activeLayer}
          spread={spread}
          isolate={isolate}
          showAllPeaks={showAllPeaks}
          annotateMode={annotateMode}
          annotations={api.annotations}
          others={others}
          presenterHex={presenterHex}
          draft={draft}
          focusAnnotation={focusAnnotation}
          rigRef={rigRef}
          initialView={initialView}
          onViewChange={onViewChange}
          onInteract={onInteract}
          onHover={setHover}
          onPlace={onPlace}
          onPeakSelect={onPeakSelect}
        />
      </Canvas>

      <header className="brand">
        <h1>Penumbra</h1>
        <p className="dim">
          {manifest.source === 'unknown' ? 'dark matter map' : manifest.source} · {manifest.layers.length} layers
        </p>
      </header>

      {tex.loaded < tex.total && !tex.error && (
        <div className="toast center">
          Loading layers {tex.loaded}/{tex.total}…
        </div>
      )}
      {tex.error && <div className="toast center error">{tex.error}</div>}
      {grids.error && <div className="toast bottom error">{grids.error}</div>}

      <ControlsPanel
        manifest={manifest}
        activeLayer={activeLayer}
        onLayer={(i) => {
          setFollowing(false);
          setActiveLayer(i);
        }}
        spread={spread}
        onSpread={(s) => {
          setFollowing(false);
          setSpread(s);
        }}
        isolate={isolate}
        onIsolate={setIsolate}
        showAllPeaks={showAllPeaks}
        onShowAllPeaks={setShowAllPeaks}
        landmarks={topPeaks}
        onLandmark={onPeakSelect}
        onReset={resetView}
      />

      <CollabPanel
        api={api}
        roomId={roomId}
        onRoom={changeRoom}
        profile={profile}
        onProfile={commitProfile}
        manifest={manifest}
        following={following}
        onFollow={setFollowing}
        annotateMode={annotateMode}
        onAnnotateMode={(on) => {
          setAnnotateMode(on);
          if (!on) setDraft(null);
          setNotice(null);
        }}
        draft={draft}
        onDraftCancel={() => setDraft(null)}
        notice={notice}
        onFly={(a) => {
          setFocusAnnotation(a.id);
          flyToSky(a.ra, a.dec, Math.min(a.bin, manifest.layers.length - 1));
        }}
        focusAnnotation={focusAnnotation}
        onPublished={() => setDraft(null)}
      />

      <footer className="readout">
        {readout ? (
          <>
            RA {readout.ra.toFixed(2)}° · Dec {readout.dec >= 0 ? '+' : '−'}
            {Math.abs(readout.dec).toFixed(2)}° ·{' '}
            {readout.kappa === undefined
              ? 'κ …'
              : Number.isNaN(readout.kappa)
                ? 'outside survey footprint'
                : `κ ${readout.kappa.toFixed(4)}`}
          </>
        ) : (
          <span className="dim">
            drag to pan · scroll to zoom · right-drag to tilt · layers are mass toward progressively more distant sources
          </span>
        )}
      </footer>
    </div>
  );
}
