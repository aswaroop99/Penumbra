import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { camToOffset, offsetToCam, type Cam, type CosmicView } from './viewCodec';

export const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as T;
};

export const nextFrame = () =>
  new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 0)));

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number) {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (...a: A) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

/** Run async jobs one after another, so overlapping rebuilds can't interleave. */
export function serial<A extends unknown[]>(fn: (...a: A) => Promise<void>) {
  let chain: Promise<void> = Promise.resolve();
  return (...a: A): Promise<void> => {
    chain = chain.then(() => fn(...a)).catch((e) => console.error(e));
    return chain;
  };
}

export function label(html: string, cls = 'lbl'): CSS2DObject {
  const el = document.createElement('div');
  el.className = cls;
  el.innerHTML = html;
  return new CSS2DObject(el);
}

/** Cosmology shared by the Simulate and 3D map views. */
export interface Params {
  s8: number;
  om: number;
}

export interface View {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  labels: CSS2DRenderer;
  caption: string;
  /** Called every frame while this view is the active one. */
  tick(now: number): void;
  /** Called each time the tab is opened (after the first `rebuild`). */
  onShow(): Promise<void> | void;
  /** Called when another tab is opened. */
  onHide?(): void;
  /** Whether orbit controls should be on when the tab opens (default true). */
  orbitEnabled?(): boolean;
  hud(): [string, string];
  /** HTML describing where this view's data comes from (empty = hide). */
  source(): string;
  rebuild?(newNoise?: boolean): Promise<void>;
  getView(): CosmicView;
  /** Apply a shared view to this view's own state. The camera is handled by the app. */
  applyView(v: CosmicView): Promise<void> | void;
  /** Camera can be shared (false while the sim "fly through" mode drives it). */
  cameraShared(): boolean;
}

export interface Ctx {
  renderer: THREE.WebGLRenderer;
  params: Params;
  busy(on: boolean): void;
  /** Something the user did that should stop "follow presenter". */
  interacted(): void;
}

export type BaseView = Pick<View, 'scene' | 'camera' | 'controls' | 'labels'>;

export function makeBase(
  ctx: Ctx,
  bg: number,
  fov: number,
  near: number,
  far: number
): BaseView {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(bg);
  const camera = new THREE.PerspectiveCamera(fov, innerWidth / innerHeight, near, far);
  const controls = new OrbitControls(camera, ctx.renderer.domElement);
  controls.enableDamping = true;
  controls.enabled = false;
  controls.addEventListener('start', () => ctx.interacted());
  const labels = new CSS2DRenderer();
  labels.setSize(innerWidth, innerHeight);
  labels.domElement.className = 'labels';
  labels.domElement.style.display = 'none';
  document.body.appendChild(labels.domElement);
  return { scene, camera, controls, labels };
}

export function getCam(v: BaseView): Cam {
  const p = v.camera.position;
  const t = v.controls.target;
  return offsetToCam(p.x - t.x, p.y - t.y, p.z - t.z);
}

export function setCam(v: BaseView, cam: Cam): void {
  const [x, y, z] = camToOffset(cam);
  v.camera.position.set(v.controls.target.x + x, v.controls.target.y + y, v.controls.target.z + z);
  v.controls.update();
}
