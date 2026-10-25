import {
  AmbientLight,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  DoubleSide,
  EdgesGeometry,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  OctahedronGeometry,
  PerspectiveCamera,
  PlaneGeometry,
  Points,
  PointsMaterial,
  Raycaster,
  RingGeometry,
  Scene,
  SphereGeometry,
  Spherical,
  SRGBColorSpace,
  Sprite,
  SpriteMaterial,
  TextureLoader,
  Vector2,
  Vector3,
  WebGLRenderer,
  type Object3D,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Annotation, Presence } from '../generated/types';
import type { SharedView } from '../collab/client';
import type { Manifest, Peak } from '../lib/manifest';
import { loadRawGrid, planeToSky, sampleGrid, skyToPlane, type RawGrid } from '../lib/sky';

export const BIN_COLORS = [0x7fd8ff, 0x9dff8a, 0xffd34d, 0xff6b9e, 0xb388ff, 0xff9f68];
export const binColor = (i: number) => BIN_COLORS[i % BIN_COLORS.length];
export const hex = (n: number) => '#' + n.toString(16).padStart(6, '0');

/** Map plane width in world units; height follows the sky's degree aspect ratio. */
const W = 24;

export type HoverInfo =
  | { kind: 'peak'; peak: Peak }
  | { kind: 'flag'; annotation: Annotation }
  | { kind: 'layer'; layer: number; ra: number; dec: number; kappa: number; sigma: number }
  | { kind: 'loading'; layer: number }
  | { kind: 'outside' };

export interface PlaceInfo {
  ra: number;
  dec: number;
  bin: number;
}

export interface ViewerEvents {
  /** Fired (rapidly) whenever the camera moves, including during flights. */
  onViewChange?: () => void;
  /** The user grabbed the map (drag / wheel). Programmatic flights do not fire this. */
  onInteract?: () => void;
  onHover?: (h: HoverInfo | null) => void;
  /** A click while annotate mode is on, on an unmasked part of a layer. */
  onPlace?: (p: PlaceInfo) => void;
  onFlagClick?: (a: Annotation) => void;
  /** The focus layer changed programmatically (peak fly-to, follow, reset). */
  onFocusChange?: (layer: number) => void;
  /** A layer was made visible programmatically (e.g. flying to a peak on a hidden layer). */
  onLayerShown?: (layer: number) => void;
  onError?: (message: string) => void;
}

interface Flight {
  t0: number;
  ms: number;
  p0: Vector3;
  p1: Vector3;
  q0: Vector3;
  q1: Vector3;
}

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

const HOME = { pos: new Vector3(0, -14, 16), target: new Vector3(0, 0, 0) };
const MIN_RADIUS = 0.5;
const MAX_RADIUS = 200;

export class FlyViewer {
  readonly manifest: Manifest;
  private readonly scene = new Scene();
  private readonly camera: PerspectiveCamera;
  private readonly renderer: WebGLRenderer;
  private readonly controls: OrbitControls;
  private readonly raycaster = new Raycaster();
  private readonly layerGroups: Group[] = [];
  private readonly flagGroups: Group[] = [];
  private readonly peakGroups: Group[] = [];
  private readonly peakMeshes: Mesh[] = [];
  private readonly grids = new Map<number, RawGrid>();
  private readonly inflight = new Map<number, Promise<RawGrid>>();
  private readonly width: number;
  private readonly height: number;
  private readonly unitsPerDeg: number;
  private readonly flagGeo = new OctahedronGeometry(0.14);
  private readonly ringGeo = new RingGeometry(0.16, 0.22, 32);
  private readonly others = new Map<
    string,
    { sprite: Sprite; ring: Mesh; key: string; base: Vector2; at: Vector3 }
  >();
  private flagMeshes: { mesh: Mesh; hot: boolean }[] = [];
  private readonly draftMarker: Mesh;
  private readonly events: ViewerEvents;
  private readonly tmp = new Vector3();

  private spacing = 3;
  private opacity = 0.7;
  private focusLayer = 0;
  private annotateMode = false;
  private flight: Flight | null = null;
  private disposed = false;
  private pointerDown: { x: number; y: number } | null = null;
  private flagById = new Map<Object3D['id'], Annotation>();

  constructor(manifest: Manifest, container: HTMLElement, events: ViewerEvents = {}) {
    this.manifest = manifest;
    this.events = events;
    const { ra_min, ra_max, dec_min, dec_max } = manifest.bounds;
    this.width = W;
    this.height = (W * (dec_max - dec_min)) / (ra_max - ra_min);
    this.unitsPerDeg = W / (ra_max - ra_min);

    this.scene.background = new Color(0x05040a);
    this.camera = new PerspectiveCamera(50, innerWidth / innerHeight, 0.05, 1000);
    this.renderer = new WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.domElement.className = 'canvas';
    container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.addEventListener('start', () => {
      this.flight = null;
      this.events.onInteract?.();
    });
    this.controls.addEventListener('change', () => this.events.onViewChange?.());
    this.camera.position.copy(HOME.pos);
    this.controls.target.copy(HOME.target);
    this.controls.update();

    this.scene.add(new AmbientLight(0xffffff, 1));
    this.addStars();

    this.draftMarker = new Mesh(
      this.ringGeo,
      new MeshBasicMaterial({ color: 0xffffff, side: DoubleSide, transparent: true, opacity: 0.95, depthTest: false })
    );
    this.draftMarker.visible = false;
    this.draftMarker.renderOrder = 20;
    this.scene.add(this.draftMarker);

    const el = this.renderer.domElement;
    el.addEventListener('pointermove', this.onPointerMove);
    el.addEventListener('pointerleave', () => this.events.onHover?.(null));
    el.addEventListener('pointerdown', (e) => {
      this.pointerDown = { x: e.clientX, y: e.clientY };
    });
    el.addEventListener('pointerup', this.onPointerUp);
    addEventListener('resize', this.onResize);
    this.renderer.setAnimationLoop(this.tick);
  }

  /** Loads every layer texture and builds the scene. Rejects if a layer image is missing. */
  async load(): Promise<void> {
    const loader = new TextureLoader();
    const base = `${import.meta.env.BASE_URL}data/`;
    await Promise.all(
      this.manifest.layers.map(
        (L, i) =>
          new Promise<void>((resolve, reject) => {
            loader.load(
              `${base}${encodeURIComponent(L.png)}`,
              (tex) => {
                tex.colorSpace = SRGBColorSpace;
                tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
                const mat = new MeshBasicMaterial({
                  map: tex,
                  transparent: true,
                  opacity: this.opacity,
                  depthWrite: false,
                  side: DoubleSide,
                });
                const mesh = new Mesh(new PlaneGeometry(this.width, this.height), mat);
                mesh.userData.layer = i;
                const frame = new LineSegments(
                  new EdgesGeometry(mesh.geometry),
                  new LineBasicMaterial({ color: binColor(i), transparent: true, opacity: 0.35 })
                );
                const group = new Group();
                const peaks = new Group();
                const flags = new Group();
                group.add(mesh, frame, peaks, flags);
                group.userData = { mesh };
                this.scene.add(group);
                this.layerGroups[i] = group;
                this.peakGroups[i] = peaks;
                this.flagGroups[i] = flags;
                resolve();
              },
              undefined,
              () => reject(new Error(`Could not load ${L.png}`))
            );
          })
      )
    );
    this.layoutLayers();
    this.buildPeaks();
    void this.ensureGrid(0).catch(() => {});
  }

  dispose() {
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    removeEventListener('resize', this.onResize);
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  // -- coordinates ----------------------------------------------------------

  private skyToXY(ra: number, dec: number) {
    return skyToPlane(this.manifest.bounds, ra, dec, this.unitsPerDeg);
  }

  private layerZ(i: number) {
    return -i * this.spacing;
  }

  // -- scene building -------------------------------------------------------

  private addStars() {
    const n = 1500;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n * 3; i++) pos[i] = (Math.random() - 0.5) * 300;
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(pos, 3));
    this.scene.add(new Points(g, new PointsMaterial({ color: 0x8a80aa, size: 0.15 })));
  }

  private layoutLayers() {
    this.layerGroups.forEach((g, i) => {
      g.position.z = this.layerZ(i);
    });
  }

  private buildPeaks() {
    const geo = new SphereGeometry(0.07, 16, 16);
    for (const p of this.manifest.peaks) {
      const group = this.peakGroups[p.bin];
      if (!group) continue;
      const { x, y } = this.skyToXY(p.ra, p.dec);
      const s = new Mesh(geo, new MeshBasicMaterial({ color: binColor(p.bin) }));
      s.position.set(x, y, 0.06);
      s.scale.setScalar(p.snr / 5);
      s.userData.peak = p;
      group.add(s);
      this.peakMeshes.push(s);
    }
  }

  // -- public controls ------------------------------------------------------

  get layerCount() {
    return this.manifest.layers.length;
  }

  setOpacity(o: number) {
    this.opacity = o;
    for (const g of this.layerGroups) (g.userData.mesh as Mesh<PlaneGeometry, MeshBasicMaterial>).material.opacity = o;
  }

  /**
   * Change the gap between layers while keeping the focus layer (and the camera
   * relative to it) where it is, so the view does not jump.
   */
  setSpacing(s: number) {
    const dz = -this.focusLayer * (s - this.spacing);
    this.spacing = s;
    this.layoutLayers();
    this.camera.position.z += dz;
    this.controls.target.z += dz;
    if (this.flight) {
      this.flight.p0.z += dz;
      this.flight.p1.z += dz;
      this.flight.q0.z += dz;
      this.flight.q1.z += dz;
    }
    this.events.onViewChange?.();
  }

  getSpacing() {
    return this.spacing;
  }

  setLayerVisible(i: number, visible: boolean) {
    const g = this.layerGroups[i];
    if (g) g.visible = visible;
  }

  isLayerVisible(i: number) {
    return this.layerGroups[i]?.visible ?? false;
  }

  setPeaksVisible(visible: boolean) {
    for (const g of this.peakGroups) g.visible = visible;
  }

  setFocusLayer(i: number) {
    const next = clamp(Math.round(i), 0, this.layerCount - 1);
    if (next === this.focusLayer) return;
    // Slide the camera and target together so the view looks the same, one layer over.
    const dz = this.layerZ(next) - this.layerZ(this.focusLayer);
    this.focusLayer = next;
    this.camera.position.z += dz;
    this.controls.target.z += dz;
    if (this.flight) {
      this.flight.p0.z += dz;
      this.flight.p1.z += dz;
      this.flight.q0.z += dz;
      this.flight.q1.z += dz;
    }
    this.events.onFocusChange?.(next);
  }

  getFocusLayer() {
    return this.focusLayer;
  }

  setAnnotateMode(on: boolean) {
    this.annotateMode = on;
    this.renderer.domElement.style.cursor = on ? 'crosshair' : '';
    if (!on) this.setDraft(null);
  }

  // -- camera ---------------------------------------------------------------

  private flyTo(pos: Vector3, target: Vector3, ms = 1400) {
    this.flight = {
      t0: performance.now(),
      ms,
      p0: this.camera.position.clone(),
      p1: pos,
      q0: this.controls.target.clone(),
      q1: target,
    };
  }

  private showLayer(i: number) {
    const g = this.layerGroups[i];
    if (g && !g.visible) {
      g.visible = true;
      this.events.onLayerShown?.(i);
    }
  }

  /** Fly in front of (ra, dec) on `layer`, stopping in the gap before it so nearer layers don't blur the view. */
  flyToSky(ra: number, dec: number, layer: number) {
    const bin = clamp(Math.round(layer), 0, this.layerCount - 1);
    this.showLayer(bin);
    this.setFocusLayer(bin);
    const { x, y } = this.skyToXY(ra, dec);
    const z = this.layerZ(bin);
    const d = bin === 0 ? 4.5 : Math.min(4.5, Math.max(1.5, this.spacing * 0.85));
    this.flyTo(new Vector3(x, y - d * 0.5, z + d), new Vector3(x, y, z));
  }

  flyToPeak(p: Peak) {
    this.flyToSky(p.ra, p.dec, p.bin);
  }

  reset() {
    this.setFocusLayer(0);
    this.flyTo(HOME.pos.clone(), HOME.target.clone());
  }

  /** The camera expressed in sky terms, suitable for sharing with other clients. */
  getView(): SharedView {
    const off = this.camera.position.clone().sub(this.controls.target);
    const sph = new Spherical().setFromVector3(off);
    const t = this.controls.target;
    const sky = planeToSky(this.manifest.bounds, t.x, t.y, this.unitsPerDeg);
    return {
      ra: sky.ra,
      dec: clamp(sky.dec, -90, 90),
      zoom: sph.radius,
      yaw: sph.theta,
      pitch: sph.phi,
      activeLayer: this.focusLayer,
      spread: this.spacing,
    };
  }

  /** Move the camera to a shared view. The caller is responsible for syncing the spacing slider. */
  applyView(v: SharedView, ms = 350) {
    if (v.spread !== this.spacing) this.setSpacing(v.spread);
    const layer = clamp(Math.round(v.activeLayer), 0, this.layerCount - 1);
    this.showLayer(layer);
    this.setFocusLayer(layer);
    const { x, y } = this.skyToXY(v.ra, v.dec);
    const target = new Vector3(x, y, this.layerZ(layer));
    const off = new Vector3().setFromSpherical(new Spherical(clamp(v.zoom, MIN_RADIUS, MAX_RADIUS), v.pitch, v.yaw));
    this.flyTo(target.clone().add(off), target, ms);
  }

  // -- shared overlays ------------------------------------------------------

  setAnnotations(list: Annotation[], focus: bigint | null = null) {
    for (const g of this.flagGroups) {
      for (const c of [...g.children]) {
        g.remove(c);
        (c as Mesh<BufferGeometry, MeshBasicMaterial>).material.dispose();
      }
    }
    this.flagById.clear();
    this.flagMeshes = [];
    for (const a of list) {
      const group = this.flagGroups[a.bin];
      if (!group) continue;
      const { x, y } = this.skyToXY(a.ra, a.dec);
      const hot = focus === a.id;
      const m = new Mesh(this.flagGeo, new MeshBasicMaterial({ color: new Color(a.authorColor) }));
      m.position.set(x, y, 0.12);
      m.renderOrder = 10;
      m.userData.annotation = a;
      group.add(m);
      this.flagById.set(m.id, a);
      this.flagMeshes.push({ mesh: m, hot });
    }
  }

  setDraft(d: PlaceInfo | null) {
    if (!d) {
      this.draftMarker.visible = false;
      return;
    }
    const { x, y } = this.skyToXY(d.ra, d.dec);
    this.draftMarker.position.set(x, y, this.layerZ(d.bin) + 0.15);
    this.draftMarker.visible = true;
  }

  /** Other participants' viewpoints, drawn as a coloured ring + name tag on the layer they are looking at. */
  setOthers(people: Presence[], presenterHex: string | null) {
    const live = new Set<string>();
    for (const p of people) {
      const id = p.identity.toHexString();
      live.add(id);
      const layer = clamp(p.activeLayer, 0, this.layerCount - 1);
      const { x, y } = this.skyToXY(p.viewRa, p.viewDec);
      const isPresenter = presenterHex === id;
      const key = `${p.name}|${p.color}|${isPresenter}`;
      let entry = this.others.get(id);
      if (!entry) {
        const ring = new Mesh(
          this.ringGeo,
          new MeshBasicMaterial({ color: new Color(p.color), side: DoubleSide, transparent: true, opacity: 0.9, depthTest: false })
        );
        ring.renderOrder = 15;
        const sprite = new Sprite(new SpriteMaterial({ transparent: true, depthTest: false }));
        sprite.renderOrder = 16;
        this.scene.add(ring, sprite);
        entry = { sprite, ring, key: '', base: new Vector2(1, 1), at: new Vector3() };
        this.others.set(id, entry);
      }
      if (entry.key !== key) {
        entry.key = key;
        (entry.ring.material as MeshBasicMaterial).color.set(p.color);
        const mat = entry.sprite.material;
        mat.map?.dispose();
        const { tex, aspect } = labelTexture(isPresenter ? `${p.name} ★` : p.name, p.color);
        mat.map = tex;
        mat.needsUpdate = true;
        entry.base.set(0.7 * aspect, 0.7);
      }
      const z = this.layerZ(layer);
      entry.at.set(x, y, z + 0.15);
      const visible = this.layerGroups[layer]?.visible ?? true;
      entry.ring.visible = entry.sprite.visible = visible;
    }
    for (const [id, e] of this.others) {
      if (live.has(id)) continue;
      this.scene.remove(e.ring, e.sprite);
      (e.ring.material as MeshBasicMaterial).dispose();
      e.sprite.material.map?.dispose();
      e.sprite.material.dispose();
      this.others.delete(id);
    }
  }

  // -- raw grids / picking --------------------------------------------------

  ensureGrid(layer: number): Promise<RawGrid> {
    const hit = this.grids.get(layer);
    if (hit) return Promise.resolve(hit);
    const pending = this.inflight.get(layer);
    if (pending) return pending;
    const info = this.manifest.layers[layer];
    if (!info) return Promise.reject(new Error(`No layer ${layer}`));
    const p = loadRawGrid(`${import.meta.env.BASE_URL}data/${encodeURIComponent(info.raw)}`, info)
      .then((g) => {
        this.grids.set(layer, g);
        return g;
      })
      .catch((e: unknown) => {
        this.inflight.delete(layer);
        this.events.onError?.(e instanceof Error ? e.message : String(e));
        throw e;
      });
    this.inflight.set(layer, p);
    return p;
  }

  private setRay(e: PointerEvent) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const m = new Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(m, this.camera);
  }

  /** First unmasked layer under the ray, or a loading/outside marker. */
  private pickLayer(): HoverInfo & { point?: Vector3 } {
    const meshes = this.layerGroups.filter((g) => g.visible).map((g) => g.userData.mesh as Mesh);
    const b = this.manifest.bounds;
    for (const hit of this.raycaster.intersectObjects(meshes)) {
      const i = hit.object.userData.layer as number;
      const grid = this.grids.get(i);
      if (!grid) {
        void this.ensureGrid(i).catch(() => {});
        return { kind: 'loading', layer: i };
      }
      const u = hit.point.x / this.width + 0.5;
      const v = 0.5 - hit.point.y / this.height;
      const kappa = sampleGrid(grid, u, v);
      if (Number.isNaN(kappa)) continue; // outside the survey: look through to the next layer
      const sky = planeToSky(b, hit.point.x, hit.point.y, this.unitsPerDeg);
      return { kind: 'layer', layer: i, ra: sky.ra, dec: sky.dec, kappa, sigma: this.manifest.layers[i].sigma, point: hit.point };
    }
    return { kind: 'outside' };
  }

  private pickFlag(): Annotation | null {
    // Raycaster ignores `visible`, so only offer flags on layers that are shown.
    const meshes = this.flagGroups.flatMap((g, i) => (this.layerGroups[i]?.visible ? g.children : []));
    const hit = this.raycaster.intersectObjects(meshes)[0];
    return hit ? (this.flagById.get(hit.object.id) ?? null) : null;
  }

  private onPointerMove = (e: PointerEvent) => {
    if (e.buttons) return; // dragging: don't spend time raycasting
    this.setRay(e);
    const flag = this.pickFlag();
    if (flag) return void this.events.onHover?.({ kind: 'flag', annotation: flag });
    const visiblePeaks = this.peakMeshes.filter((s) => s.parent?.visible && s.parent.parent?.visible);
    const ph = this.raycaster.intersectObjects(visiblePeaks)[0];
    if (ph) return void this.events.onHover?.({ kind: 'peak', peak: ph.object.userData.peak as Peak });
    const { point: _p, ...info } = this.pickLayer();
    this.events.onHover?.(info);
  };

  private onPointerUp = (e: PointerEvent) => {
    const down = this.pointerDown;
    this.pointerDown = null;
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return; // a drag, not a click
    this.setRay(e);
    if (!this.annotateMode) {
      const flag = this.pickFlag();
      if (flag) this.events.onFlagClick?.(flag);
      return;
    }
    const resolve = (): void => {
      const info = this.pickLayer();
      if (info.kind === 'layer') {
        this.events.onPlace?.({ ra: info.ra, dec: info.dec, bin: info.layer });
      } else if (info.kind === 'loading') {
        this.ensureGrid(info.layer).then(resolve, () =>
          this.events.onError?.('Could not check the survey footprint for this layer; try again.')
        );
      } else {
        this.events.onError?.('That spot is outside the survey footprint (masked sky). Pick a covered area.');
      }
    };
    resolve();
  };

  // -- loop -----------------------------------------------------------------

  private onResize = () => {
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(innerWidth, innerHeight);
  };

  private tick = (now: number) => {
    if (this.disposed) return;
    const f = this.flight;
    if (f) {
      const t = Math.min(1, (now - f.t0) / f.ms);
      const k = ease(t);
      this.camera.position.lerpVectors(f.p0, f.p1, k);
      this.controls.target.lerpVectors(f.q0, f.q1, k);
      if (t === 1) this.flight = null;
    }
    this.controls.update();
    if (!this.flight) {
      // Panning is confined to the focus layer's plane: drop any depth drift so the
      // shared (ra, dec, layer) camera always round-trips exactly.
      const dz = this.layerZ(this.focusLayer) - this.controls.target.z;
      if (Math.abs(dz) > 1e-6) {
        this.camera.position.z += dz;
        this.controls.target.z += dz;
      }
    }
    // Keep peak markers a steady on-screen size instead of ballooning up close.
    for (const s of this.peakMeshes) {
      const d = this.camera.position.distanceTo(s.getWorldPosition(this.tmp));
      s.scale.setScalar(((s.userData.peak as Peak).snr / 5) * Math.min(1, Math.max(0.12, d * 0.05)));
    }
    // Same for flags and other people's markers: constant-ish on-screen size.
    const cam = this.camera.position;
    const screenScale = (at: Vector3) => Math.min(1, Math.max(0.12, cam.distanceTo(at) * 0.05));
    for (const f of this.flagMeshes) {
      f.mesh.scale.setScalar(screenScale(f.mesh.getWorldPosition(this.tmp)) * (f.hot ? 1.6 : 1));
    }
    for (const e of this.others.values()) {
      const k = screenScale(e.at);
      e.ring.position.copy(e.at);
      e.ring.scale.setScalar(k);
      e.ring.lookAt(cam);
      e.sprite.position.set(e.at.x, e.at.y + 0.55 * k, e.at.z);
      e.sprite.scale.set(e.base.x * k, e.base.y * k, 1);
    }
    this.renderer.render(this.scene, this.camera);
  };
}

function labelTexture(text: string, color: string): { tex: CanvasTexture; aspect: number } {
  const pad = 14;
  const fontPx = 40;
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d')!;
  ctx.font = `600 ${fontPx}px system-ui, sans-serif`;
  const w = Math.ceil(ctx.measureText(text).width) + pad * 2;
  const h = fontPx + pad;
  c.width = w;
  c.height = h;
  ctx.font = `600 ${fontPx}px system-ui, sans-serif`;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(0, 0, w, h, h / 2);
  ctx.fill();
  ctx.fillStyle = '#05060a';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, pad, h / 2 + 2);
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  return { tex, aspect: w / h };
}
