import * as THREE from 'three';
import type { SharedView } from '../collab/client';
import type { Annotation } from '../generated/types';
import type { Manifest } from '../lib/manifest';
import { createBoxView } from './boxView';
import { createSimView } from './simView';
import { createSliceView, type SkyPlace, type SliceView } from './sliceView';
import { $, debounce, getCam, setCam, type Ctx, type Params, type View } from './viewKit';
import { decodeView, encodeView, TABS, type Cam, type CosmicView, type Tab } from './viewCodec';

export type { SkyPlace } from './sliceView';

export interface CosmicEvents {
  /** The user touched the camera or a control (so "follow presenter" should stop). */
  onInteract(): void;
  /** Every animation frame, after rendering. Cheap hook for change detection. */
  onFrame(): void;
  onTabChange(tab: Tab): void;
  /** The user clicked a spot on a survey layer while placing a flag. */
  onPlace(p: SkyPlace): void;
  /** A short message for the user (null clears it). */
  onNotice(msg: string | null): void;
}

interface Tween {
  view: View;
  from: Cam;
  to: Cam;
  t0: number;
  ms: number;
}

const wrapPi = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const TAB_KEY = 'cw-tab';

/**
 * The cosmic-web frontend (ported from the viewer branch's `cosmic-web.html`):
 * three views behind one header/panel, plus the hooks the collaboration layer
 * needs: read/apply the shared view and show/place flags on the survey layers.
 */
export class CosmicApp {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly params: Params = { s8: 0.76, om: 0.3 }; // S8 from our DES Y3 shear fit; Omega_m = DES Y3 published
  private readonly views: Record<Tab, View>;
  private readonly built = new Set<Tab>();
  private active: View | null = null;
  private activeTab: Tab = 'sim';
  private showToken = 0;
  private tween: Tween | null = null;
  private annotateMode = false;
  private annotations: readonly Annotation[] = [];
  private focusAnnotation: bigint | null = null;
  private hudKey = '';
  private readonly ctx: Ctx;

  constructor(
    manifest: Manifest,
    private readonly events: CosmicEvents
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(innerWidth, innerHeight);
    document.body.prepend(this.renderer.domElement);

    this.ctx = {
      renderer: this.renderer,
      params: this.params,
      busy: (on) => {
        $('busy').style.display = on ? 'block' : 'none';
      },
      interacted: () => {
        this.tween = null;
        this.events.onInteract();
      },
    };
    this.views = {
      sim: createSimView(this.ctx),
      box: createBoxView(this.ctx),
      slices: createSliceView(this.ctx, manifest),
    };
    this.wireControls();
  }

  get tab(): Tab {
    return this.activeTab;
  }

  private get slices(): SliceView {
    return this.views.slices as SliceView;
  }

  async start(): Promise<void> {
    let first: Tab = 'sim';
    try {
      const saved = localStorage.getItem(TAB_KEY);
      if (saved && (TABS as readonly string[]).includes(saved)) first = saved as Tab;
    } catch {
      /* storage unavailable */
    }
    this.renderer.setAnimationLoop((now) => this.frame(now));
    await this.show(first);
  }

  // -------------------------------------------------------------- tabs
  async show(tab: Tab): Promise<void> {
    const token = ++this.showToken;
    const next = this.views[tab];
    if (this.active) {
      this.active.controls.enabled = false;
      this.active.labels.domElement.style.display = 'none';
    }
    this.tween = null;
    this.active = next;
    this.activeTab = tab;
    document.body.dataset.active = tab;
    document
      .querySelectorAll<HTMLElement>('nav button')
      .forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    next.controls.enabled = !(tab === 'sim' && $<HTMLInputElement>('fly').checked);
    next.labels.domElement.style.display = '';
    $('caption').textContent = next.caption;
    $('cursorHint').hidden = !(this.annotateMode && tab === 'slices');
    this.renderer.domElement.style.cursor = this.annotateMode && tab === 'slices' ? 'crosshair' : '';
    try {
      localStorage.setItem(TAB_KEY, tab);
    } catch {
      /* storage unavailable */
    }
    this.events.onTabChange(tab);
    try {
      if (!this.built.has(tab)) {
        this.built.add(tab);
        await next.rebuild?.(true);
      }
      await next.onShow();
      if (token === this.showToken && tab === 'slices') {
        this.slices.setAnnotations(this.annotations, this.focusAnnotation);
      }
    } catch (e) {
      this.events.onNotice(e instanceof Error ? e.message : String(e));
    }
  }

  // ----------------------------------------------------- shared controls
  private wireControls() {
    document.querySelectorAll<HTMLElement>('nav button').forEach((b) => {
      b.onclick = () => {
        this.events.onInteract();
        void this.show(b.dataset.tab as Tab);
      };
    });
    // Any manual use of the control panel takes over from "follow presenter".
    for (const type of ['input', 'click'] as const) {
      $('panel').addEventListener(type, () => this.events.onInteract(), true);
    }

    const rebuildCosmo = debounce(() => {
      for (const t of this.built) void this.views[t].rebuild?.();
    }, 180);
    this.rebuildCosmo = rebuildCosmo;
    for (const [id, key] of [
      ['s8', 's8'],
      ['om', 'om'],
    ] as const) {
      const slider = $<HTMLInputElement>(id);
      slider.oninput = () => {
        this.params[key] = +slider.value;
        this.syncCosmoLabels();
        rebuildCosmo();
      };
    }
    this.syncCosmoLabels();

    // Auto-rotate: off by default, remembered per viewer.
    const spin = $<HTMLInputElement>('spin');
    try {
      spin.checked = localStorage.getItem('cw-spin') === '1';
    } catch {
      /* storage unavailable */
    }
    const applySpin = () => {
      this.views.sim.controls.autoRotate = this.views.box.controls.autoRotate = spin.checked;
      try {
        localStorage.setItem('cw-spin', spin.checked ? '1' : '0');
      } catch {
        /* storage unavailable */
      }
    };
    spin.onchange = applySpin;
    applySpin();

    addEventListener('resize', () => {
      this.renderer.setSize(innerWidth, innerHeight);
      for (const v of Object.values(this.views)) {
        v.camera.aspect = innerWidth / innerHeight;
        v.camera.updateProjectionMatrix();
        v.labels.setSize(innerWidth, innerHeight);
      }
    });

    // Flag placement: a click (not a drag) on a survey layer.
    const canvas = this.renderer.domElement;
    let down: { x: number; y: number } | null = null;
    canvas.addEventListener('pointerdown', (e) => {
      down = { x: e.clientX, y: e.clientY };
    });
    canvas.addEventListener('pointerup', (e) => {
      const start = down;
      down = null;
      if (!start || !this.annotateMode || this.activeTab !== 'slices') return;
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 5) return;
      const hit = this.slices.pick(e.clientX, e.clientY, canvas);
      if (hit.kind === 'place') {
        this.events.onNotice(null);
        this.events.onPlace(hit.place);
      } else if (hit.kind === 'outside') {
        this.events.onNotice('That spot is outside the survey footprint.');
      }
    });
  }

  private rebuildCosmo: () => void = () => {};

  private syncCosmoLabels() {
    $('s8val').textContent = this.params.s8.toFixed(2);
    $('omval').textContent = this.params.om.toFixed(3);
  }

  private setCosmology(s8: number, om: number) {
    if (Math.abs(s8 - this.params.s8) < 0.0005 && Math.abs(om - this.params.om) < 0.0005) return;
    this.params.s8 = s8;
    this.params.om = om;
    $<HTMLInputElement>('s8').value = String(s8);
    $<HTMLInputElement>('om').value = String(om);
    this.syncCosmoLabels();
    this.rebuildCosmo();
  }

  // --------------------------------------------------------- shared view
  getView(): SharedView {
    return encodeView(this.views[this.activeTab].getView());
  }

  async applyView(shared: SharedView, ms = 0): Promise<void> {
    const cv: CosmicView = decodeView(shared);
    if (cv.tab !== this.activeTab) await this.show(cv.tab);
    if (cv.tab === 'sim' || cv.tab === 'box') this.setCosmology(cv.s8, cv.om);
    const view = this.views[cv.tab];
    await view.applyView(cv);
    if (!view.cameraShared() || cv.tab !== this.activeTab) return;
    if (ms <= 0) {
      this.tween = null;
      setCam(view, cv.cam);
    } else {
      this.tween = { view, from: getCam(view), to: cv.cam, t0: performance.now(), ms };
    }
  }

  private stepTween(now: number) {
    const tw = this.tween;
    if (!tw) return;
    const u = Math.min(1, (now - tw.t0) / tw.ms);
    const e = u * (2 - u); // ease-out
    setCam(tw.view, {
      az: tw.from.az + wrapPi(tw.to.az - tw.from.az) * e,
      el: tw.from.el + (tw.to.el - tw.from.el) * e,
      dist: tw.from.dist + (tw.to.dist - tw.from.dist) * e,
    });
    if (u >= 1) this.tween = null;
  }

  // --------------------------------------------------------------- flags
  setAnnotations(list: readonly Annotation[], focus: bigint | null) {
    this.annotations = list;
    this.focusAnnotation = focus;
    this.slices.setAnnotations(list, focus);
  }

  setDraft(p: SkyPlace | null) {
    this.slices.setDraft(p);
  }

  setAnnotateMode(on: boolean) {
    this.annotateMode = on;
    const live = on && this.activeTab === 'slices';
    this.renderer.domElement.style.cursor = live ? 'crosshair' : '';
    $('cursorHint').hidden = !live;
  }

  /** Open the survey layers centred on a flag. */
  async flyToFlag(a: Annotation): Promise<void> {
    if (this.activeTab !== 'slices') await this.show('slices');
    this.slices.centerOn(a.ra, a.dec);
    this.slices.setAnnotations(this.annotations, a.id);
    this.focusAnnotation = a.id;
  }

  // ---------------------------------------------------------------- loop
  private frame(now: number) {
    const v = this.active;
    if (!v) return;
    this.stepTween(now);
    v.tick(now);
    if (v.controls.enabled) v.controls.update();
    this.renderer.render(v.scene, v.camera);
    v.labels.render(v.scene, v.camera);
    const [big, small] = v.hud();
    const src = v.source();
    const key = big + small + src;
    if (key !== this.hudKey) {
      this.hudKey = key;
      $('hudBig').textContent = big;
      $('hudSmall').textContent = small;
      const s = $('source');
      s.innerHTML = src;
      s.style.display = src ? '' : 'none';
    }
    this.events.onFrame();
  }
}
