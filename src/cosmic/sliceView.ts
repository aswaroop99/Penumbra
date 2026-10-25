import * as THREE from 'three';
import type { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import type { Annotation } from '../generated/types';
import type { Manifest } from '../lib/manifest';
import { f16ToNumber, skyToUV, uvToSky } from '../lib/sky';
import { lookbackGyr } from './physics';
import { $, debounce, getCam, label, makeBase, type Ctx, type View } from './viewKit';
import { LIMITS, type CosmicView } from './viewCodec';

export interface SkyPlace {
  ra: number;
  dec: number;
  bin: number;
}

export type PickResult = { kind: 'place'; place: SkyPlace } | { kind: 'outside' } | { kind: 'miss' };

export interface SliceView extends View {
  /** Map a screen position to (ra, dec, layer), or say why it can't be done. */
  pick(clientX: number, clientY: number, canvas: HTMLElement): PickResult;
  setAnnotations(list: readonly Annotation[], focus: bigint | null): void;
  setDraft(p: SkyPlace | null): void;
  /** Centre the patch on a sky position (used when flying to a flag). */
  centerOn(ra: number, dec: number): void;
}

const BIN_Z = [0.2, 0.3, 0.4, 0.5]; // approximate lensing-sensitivity peak of each tomographic bin
const SIZE = 4;

const STOPS: [number, [number, number, number]][] = [
  [0, [5, 9, 38]],
  [0.4, [12, 30, 105]],
  [0.66, [38, 102, 222]],
  [0.86, [120, 196, 255]],
  [1, [240, 249, 255]],
];
function blue(t: number): [number, number, number] {
  for (let i = 1; i < STOPS.length; i++) {
    if (t <= STOPS[i][0]) {
      const [t0, c0] = STOPS[i - 1];
      const [t1, c1] = STOPS[i];
      const u = (t - t0) / (t1 - t0);
      return [c0[0] + (c1[0] - c0[0]) * u, c0[1] + (c1[1] - c0[1]) * u, c0[2] + (c1[2] - c0[2]) * u];
    }
  }
  return STOPS[STOPS.length - 1][1];
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** View 3: the exported DES layers as sky patches stacked along the line of sight. */
export function createSliceView(ctx: Ctx, manifest: Manifest): SliceView {
  const base = makeBase(ctx, 0x0a0f33, 42, 0.1, 200);
  const [h, w] = manifest.layers[0].shape;
  const { bounds } = manifest;
  let grids: Float32Array[] = [];
  let loaded = false;
  let loading: Promise<void> | null = null;
  const planes: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>[] = [];
  const frames: THREE.LineSegments[] = [];
  const tags: CSS2DObject[] = [];
  // Last painted crop, in grid pixels (used to place flags).
  const crop = { c0: 0, r0: 0, S: 1, Sh: 1 };
  let center: { x: number; y: number } = { x: w / 2, y: h * 0.62 };
  let top: SkyPlace[] = [];

  // Earth + line of sight
  const earth = new THREE.Mesh(
    new THREE.SphereGeometry(0.32, 32, 16),
    new THREE.MeshBasicMaterial({ color: 0x4f8dff })
  );
  earth.position.set(-7, 0, 0);
  base.scene.add(earth);
  const glow = new THREE.Mesh(
    new THREE.SphereGeometry(0.5, 32, 16),
    new THREE.MeshBasicMaterial({ color: 0x4f8dff, transparent: true, opacity: 0.18 })
  );
  glow.position.copy(earth.position);
  base.scene.add(glow);
  const el = label('Earth<small>observer</small>');
  el.position.set(-7, -0.75, 0);
  base.scene.add(el);
  base.scene.add(
    new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-7, 0, 0), new THREE.Vector3(12, 0, 0)]),
      new THREE.LineBasicMaterial({ color: 0xc8d4ff, transparent: true, opacity: 0.35 })
    )
  );

  base.camera.position.set(-6.5, 5, 14);
  base.controls.target.set(0, 0, 0);
  if (innerWidth < innerHeight) base.camera.position.multiplyScalar(1.6);

  const cropPx = () => +$<HTMLInputElement>('crop').value;
  const gap = () => +$<HTMLInputElement>('gap').value;
  const toPix = (ra: number, dec: number) => {
    const { u, v } = skyToUV(bounds, ra, dec);
    return { x: u * w, y: v * h };
  };

  // ---- flags -------------------------------------------------------------
  const pins = new Map<bigint, { obj: CSS2DObject; a: Annotation }>();
  let draftPin: { obj: CSS2DObject; p: SkyPlace } | null = null;
  let focusId: bigint | null = null;

  const pinHtml = (color: string, name: string) =>
    `<span class="pin" style="background:${/^#[0-9a-f]{6}$/i.test(color) ? color : '#fff'}"></span><span class="pin-name">${escapeHtml(name)}</span>`;

  /** World position for a sky position on layer `bin`, or null if it's outside the painted patch. */
  function worldOf(ra: number, dec: number, bin: number): THREE.Vector3 | null {
    const plane = planes[bin];
    if (!plane) return null;
    const { x, y } = toPix(ra, dec);
    const fx = (x - crop.c0) / crop.S;
    const fy = (y - crop.r0) / crop.Sh;
    if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return null;
    plane.updateMatrixWorld(true);
    return plane.localToWorld(new THREE.Vector3((fx - 0.5) * SIZE, (0.5 - fy) * SIZE, 0));
  }

  function placePin(obj: CSS2DObject, ra: number, dec: number, bin: number) {
    const pos = worldOf(ra, dec, bin);
    obj.visible = pos !== null;
    if (pos) obj.position.copy(pos);
  }

  function refreshPins() {
    for (const { obj, a } of pins.values()) placePin(obj, a.ra, a.dec, a.bin);
    if (draftPin) placePin(draftPin.obj, draftPin.p.ra, draftPin.p.dec, draftPin.p.bin);
  }

  // ---- painting ----------------------------------------------------------
  function paint() {
    const S = cropPx();
    $('cropval').textContent = `${((S * (bounds.ra_max - bounds.ra_min)) / w).toFixed(0)}°`;
    const c0 = Math.max(0, Math.min(w - S, Math.round(center.x - S / 2)));
    const r0 = Math.max(0, Math.min(h - S, Math.round(center.y - S / 2)));
    const Sh = Math.min(S, h);
    Object.assign(crop, { c0, r0, S, Sh });
    manifest.layers.forEach((Lr, b) => {
      const cv = document.createElement('canvas');
      cv.width = S;
      cv.height = Sh;
      const g2 = cv.getContext('2d')!;
      const img = g2.createImageData(S, Sh);
      const g = grids[b];
      for (let r = 0; r < Sh; r++) {
        for (let c = 0; c < S; c++) {
          const v = g[(r0 + r) * w + (c0 + c)];
          const o = 4 * (r * S + c);
          if (Number.isNaN(v)) {
            img.data.set([8, 14, 50, 150], o);
            continue;
          }
          const t = Math.min(1, Math.max(0, (v / Lr.sigma + 1.5) / 5.5));
          const [R, G, B] = blue(t);
          img.data[o] = R;
          img.data[o + 1] = G;
          img.data[o + 2] = B;
          img.data[o + 3] = 235;
        }
      }
      g2.putImageData(img, 0, 0);
      const tex = new THREE.CanvasTexture(cv);
      tex.colorSpace = THREE.SRGBColorSpace;
      planes[b].material.map?.dispose();
      planes[b].material.map = tex;
      planes[b].material.needsUpdate = true;
      planes[b].scale.set(1, Sh / S, 1);
      frames[b].scale.set(1, Sh / S, 1);
    });
    refreshPins();
  }

  function layout() {
    const g = gap();
    planes.forEach((p, b) => {
      const x = -2.5 + b * g;
      p.position.x = frames[b].position.x = x;
      tags[b].position.set(x, -SIZE / 2 - 0.35, 0);
    });
    refreshPins();
  }

  async function loadData() {
    const root = import.meta.env.BASE_URL;
    grids = await Promise.all(
      manifest.layers.map(async (Lr) => {
        const res = await fetch(`${root}data/${encodeURIComponent(Lr.raw)}`);
        if (!res.ok) throw new Error(`Could not load ${Lr.raw} (HTTP ${res.status})`);
        const u16 = new Uint16Array(await res.arrayBuffer());
        const out = new Float32Array(u16.length);
        for (let i = 0; i < u16.length; i++) out[i] = f16ToNumber(u16[i]);
        return out;
      })
    );

    // Prefer peaks whose surrounding patch is fully inside the survey (no empty, masked corners).
    const S0 = cropPx();
    const maskedShare = (p: { ra: number; dec: number }) => {
      const { x, y } = toPix(p.ra, p.dec);
      const c0 = Math.max(0, Math.min(w - S0, Math.round(x - S0 / 2)));
      const r0 = Math.max(0, Math.min(h - S0, Math.round(y - S0 / 2)));
      let nan = 0;
      let n = 0;
      for (let r = 0; r < S0; r += 8)
        for (let c = 0; c < S0; c += 8, n++) if (Number.isNaN(grids[0][(r0 + r) * w + c0 + c])) nan++;
      return nan / n;
    };
    const bySnr = [...manifest.peaks].sort((a, b) => b.snr - a.snr);
    let best = bySnr.filter((p) => maskedShare(p) < 0.02).slice(0, 10);
    if (!best.length) best = bySnr.slice(0, 10);
    top = best.map((p) => ({ ra: p.ra, dec: p.dec, bin: p.bin }));

    const sel = $<HTMLSelectElement>('region');
    sel.replaceChildren();
    best.forEach((p, i) =>
      sel.add(
        new Option(
          `Peak ${i + 1}: RA ${p.ra.toFixed(1)}°, Dec ${p.dec.toFixed(1)}° (S/N ${p.snr.toFixed(1)})`,
          String(i)
        )
      )
    );
    sel.add(new Option('Middle of the survey', 'mid'));
    sel.onchange = () => {
      sel.querySelector('option[value="custom"]')?.remove();
      center =
        sel.value === 'mid' ? { x: w / 2, y: h * 0.62 } : toPix(top[+sel.value].ra, top[+sel.value].dec);
      paint();
    };
    center = top.length ? toPix(top[0].ra, top[0].dec) : center;

    manifest.layers.forEach((Lr, b) => {
      const plane = new THREE.Mesh(
        new THREE.PlaneGeometry(SIZE, SIZE),
        new THREE.MeshBasicMaterial({ transparent: true, side: THREE.DoubleSide, depthWrite: false })
      );
      plane.rotation.y = -Math.PI / 2; // face the observer
      const frame = new THREE.LineSegments(
        new THREE.EdgesGeometry(plane.geometry),
        new THREE.LineBasicMaterial({ color: 0xc8d4ff, transparent: true, opacity: 0.6 })
      );
      frame.rotation.y = -Math.PI / 2;
      const z = BIN_Z[b] ?? 0.2 + 0.1 * b;
      const tag = label(
        `~${lookbackGyr(z, 0.315).toFixed(1)} billion years ago<small>${escapeHtml(Lr.name)} · sources near z ≈ ${z.toFixed(1)}</small>`
      );
      base.scene.add(plane, frame, tag);
      planes.push(plane);
      frames.push(frame);
      tags.push(tag);
    });
    layout();
    paint(); // also places any flags that arrived before the planes existed
  }

  async function ensureLoaded() {
    if (loaded) return;
    loading ??= (async () => {
      ctx.busy(true);
      try {
        await loadData();
        loaded = true;
      } finally {
        ctx.busy(false);
        loading = null;
      }
    })();
    await loading;
  }

  $<HTMLInputElement>('gap').oninput = () => planes.length && layout();
  $<HTMLInputElement>('crop').oninput = debounce(() => planes.length && paint(), 120);

  function addCustomRegion() {
    const sel = $<HTMLSelectElement>('region');
    if (!sel.querySelector('option[value="custom"]')) sel.add(new Option('Shared / flagged location', 'custom'));
    sel.value = 'custom';
  }

  function centerOn(ra: number, dec: number) {
    center = toPix(ra, dec);
    addCustomRegion();
    if (planes.length) paint();
  }

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  return {
    ...base,
    caption:
      'The same patch of sky in the four DES Y3 lensing layers. Each layer is the mass projected toward more distant galaxies, so the layers overlap; they are not separate slices of space. Times are approximate.',
    tick: () => {},
    async onShow() {
      await ensureLoaded();
    },
    hud: () => [
      'Looking deeper',
      `${manifest.source} · ${manifest.smoothing_arcmin}′ smoothing`,
    ],
    source() {
      const toy = /toy/i.test(manifest.source);
      return toy
        ? `<b class="toy">Toy data</b>Stand-in maps from the team pipeline (<code>${escapeHtml(manifest.source)}</code>), shaped like DES Y3. Not real observations.`
        : `<b class="real">Survey data</b>${escapeHtml(manifest.source)}`;
    },
    cameraShared: () => true,
    getView(): CosmicView {
      const { ra, dec } = uvToSky(bounds, center.x / w, center.y / h);
      return { tab: 'slices', cam: getCam(base), ra, dec, gap: gap() };
    },
    async applyView(v) {
      if (v.tab !== 'slices') return;
      await ensureLoaded();
      const g = $<HTMLInputElement>('gap');
      g.value = String(Math.min(LIMITS.gap[1], Math.max(LIMITS.gap[0], v.gap)));
      layout();
      // Only re-centre if the presenter actually moved the patch.
      const cur = uvToSky(bounds, center.x / w, center.y / h);
      if (Math.abs(cur.ra - v.ra) > 0.05 || Math.abs(cur.dec - v.dec) > 0.05) centerOn(v.ra, v.dec);
    },
    centerOn,

    pick(clientX, clientY, canvas) {
      if (!planes.length) return { kind: 'miss' };
      const r = canvas.getBoundingClientRect();
      ndc.set(((clientX - r.left) / r.width) * 2 - 1, -(((clientY - r.top) / r.height) * 2 - 1));
      raycaster.setFromCamera(ndc, base.camera);
      const hit = raycaster.intersectObjects(planes, false)[0];
      if (!hit || !hit.uv) return { kind: 'miss' };
      const bin = planes.indexOf(hit.object as (typeof planes)[number]);
      const col = Math.min(w - 1, Math.floor(crop.c0 + hit.uv.x * crop.S));
      const row = Math.min(h - 1, Math.floor(crop.r0 + (1 - hit.uv.y) * crop.Sh));
      if (Number.isNaN(grids[0][row * w + col])) return { kind: 'outside' };
      const { ra, dec } = uvToSky(bounds, (col + 0.5) / w, (row + 0.5) / h);
      return { kind: 'place', place: { ra, dec, bin } };
    },

    setAnnotations(list, focus) {
      focusId = focus;
      const keep = new Set(list.map((a) => a.id));
      for (const [id, pin] of pins) {
        if (!keep.has(id)) {
          base.scene.remove(pin.obj);
          pin.obj.element.remove();
          pins.delete(id);
        }
      }
      for (const a of list) {
        let pin = pins.get(a.id);
        if (!pin) {
          const obj = label(pinHtml(a.authorColor, a.authorName), 'flag-pin');
          base.scene.add(obj);
          pin = { obj, a };
          pins.set(a.id, pin);
        } else {
          pin.a = a;
          pin.obj.element.innerHTML = pinHtml(a.authorColor, a.authorName);
        }
        pin.obj.element.title = a.text;
        pin.obj.element.classList.toggle('focus', a.id === focusId);
        placePin(pin.obj, a.ra, a.dec, a.bin);
      }
    },

    setDraft(p) {
      if (draftPin) {
        base.scene.remove(draftPin.obj);
        draftPin.obj.element.remove();
        draftPin = null;
      }
      if (!p) return;
      const obj = label('<span class="pin draft"></span>', 'flag-pin');
      base.scene.add(obj);
      draftPin = { obj, p };
      placePin(obj, p.ra, p.dec, p.bin);
    },
  };
}
