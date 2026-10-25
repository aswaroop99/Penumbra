import * as THREE from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/**
 * A drivable spaceship that carries the camera, for any 3D view.
 *
 * A view describes its space as a `ShipWorld` (where to start, how big the ship is, how
 * fast it flies, where it may go, and what to say about the spot it's at). The rig does
 * the rest: model, keyboard/mouse/touch controls, chase or cockpit camera and a flight HUD.
 * Ship axes: the model points along +X with +Y up, so yaw 0 / pitch 0 flies toward +X.
 */
export interface ShipWorld {
  start: THREE.Vector3;
  /** Heading in radians about +Y (0 = toward +X, positive = turn left). */
  yaw?: number;
  /** Nose angle in radians above the horizontal. */
  pitch?: number;
  /** Ship length in world units. Camera offsets and the dust field scale with it. */
  size: number;
  /** Top speed (world units per second) without boost. */
  speed: number;
  /** The ship stays inside this box. Leave out for open or periodic space. */
  bounds?: THREE.Box3;
  /** Fog used while flying (restored on exit). */
  fog?: THREE.Fog | THREE.FogExp2 | null;
  /** Drifting dust around the camera as a speed cue. Default true. */
  dust?: boolean;
  /** HTML for the flight readout at a world position, e.g. the redshift there. */
  describe?(pos: THREE.Vector3): string;
  /** Named directions drawn on the orientation globe, e.g. toward Earth. */
  compass?: CompassMark[];
}

export type ShipCamera = 'chase' | 'cockpit';

export interface CompassMark {
  /** World direction (need not be normalised). */
  dir: [number, number, number];
  label: string;
  /** Highlight colour, e.g. for Earth. */
  color?: string;
}

export interface ShipRig {
  readonly active: boolean;
  readonly position: THREE.Vector3;
  enter(world: ShipWorld): void;
  /** Swap the world while flying. The ship stays put, clamped into the new bounds. */
  setWorld(world: ShipWorld): void;
  exit(): void;
  /** Call every frame while the view is shown. */
  tick(now: number): void;
}

export interface ShipOptions {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls?: OrbitControls;
  dom: HTMLElement;
  /** The user steered or used the HUD (stops "follow presenter"). */
  onInput?(): void;
  onEnter?(): void;
  /** Called once whenever flying stops (Esc, the HUD button, or `exit()`). */
  onExit?(): void;
}

// ------------------------------------------------------------- flight model

export interface FlightState {
  pos: THREE.Vector3;
  /** Ship orientation. Turns, climbs and rolls are about the ship's own axes, so loops and flying upside down work. */
  quat: THREE.Quaternion;
  /** Visual roll while turning (model only, not the flight path). */
  bank: number;
  /** Signed, world units per second. */
  speed: number;
  yawRate: number;
  pitchRate: number;
  rollRate: number;
  /** Cruise throttle 0..1, used when no thrust key is held. */
  cruise: number;
}

export interface FlightInput {
  /** +1 thrust, −1 brake/reverse, 0 cruise. */
  thrust: number;
  /** +1 turn left, −1 turn right (about the ship's up axis). */
  turn: number;
  /** +1 nose up, −1 nose down (about the ship's wing axis). */
  climb: number;
  /** +1 roll right, −1 roll left (about the nose). */
  roll?: number;
  boost: boolean;
}

const TURN_RATE = 1.3;
const CLIMB_RATE = 1.2;
const ROLL_RATE = 2.0;
export const BOOST = 2.2;

export function forwardOf(yaw: number, pitch: number, out = new THREE.Vector3()): THREE.Vector3 {
  const c = Math.cos(pitch);
  return out.set(c * Math.cos(yaw), Math.sin(pitch), -c * Math.sin(yaw));
}

/** Orientation for a heading and nose angle, with the wings level. */
export function orientation(yaw: number, pitch: number, out = new THREE.Quaternion()): THREE.Quaternion {
  return out.setFromEuler(new THREE.Euler(0, yaw, pitch, 'YZX'));
}

const _e = new THREE.Euler();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();

/** Advance the ship by `dt` seconds. Pure apart from mutating `s`. */
export function stepFlight(
  s: FlightState,
  input: FlightInput,
  dt: number,
  world: Pick<ShipWorld, 'speed' | 'bounds'>
): void {
  const ease = (rate: number) => 1 - Math.exp(-rate * dt);
  let target = input.thrust > 0 ? world.speed : input.thrust < 0 ? -0.35 * world.speed : s.cruise * world.speed;
  if (input.boost && target > 0) target *= BOOST;
  s.speed += (target - s.speed) * ease(input.thrust < 0 ? 4 : 2.2);

  const c = THREE.MathUtils.clamp;
  s.yawRate += (c(input.turn, -1, 1) * TURN_RATE - s.yawRate) * ease(6);
  s.pitchRate += (c(input.climb, -1, 1) * CLIMB_RATE - s.pitchRate) * ease(6);
  s.rollRate += (c(input.roll ?? 0, -1, 1) * ROLL_RATE - s.rollRate) * ease(6);
  // Local axes: +X nose (roll), +Y up (turn), +Z right wing (pitch: positive lifts the nose).
  s.quat.multiply(_q.setFromEuler(_e.set(s.rollRate * dt, s.yawRate * dt, s.pitchRate * dt, 'YZX'))).normalize();
  // Left turn (positive yaw rate) dips the left wing (negative roll about the nose).
  s.bank += (-0.55 * s.yawRate - s.bank) * ease(5);

  s.pos.addScaledVector(_v.set(1, 0, 0).applyQuaternion(s.quat), s.speed * dt);
  if (world.bounds) {
    const before = s.pos.clone();
    world.bounds.clampPoint(s.pos, s.pos);
    // Hitting a wall soaks up speed instead of grinding along it at full throttle.
    if (!before.equals(s.pos)) s.speed *= Math.exp(-12 * dt);
  }
}

// ------------------------------------------------------------------- model

function metalMatcap(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#15181e';
  g.fillRect(0, 0, 256, 256);
  // Soft key light up-left, a cool sky band across the top and a dark rim: brushed metal.
  const body = g.createRadialGradient(92, 80, 6, 128, 128, 128);
  body.addColorStop(0, '#ffffff');
  body.addColorStop(0.18, '#dfe4ec');
  body.addColorStop(0.5, '#8c939f');
  body.addColorStop(0.82, '#3b414b');
  body.addColorStop(1, '#1b1f26');
  g.fillStyle = body;
  g.beginPath();
  g.arc(128, 128, 128, 0, Math.PI * 2);
  g.fill();
  const sky = g.createLinearGradient(0, 0, 0, 256);
  sky.addColorStop(0, 'rgba(150, 185, 255, 0.28)');
  sky.addColorStop(0.45, 'rgba(150, 185, 255, 0)');
  sky.addColorStop(0.8, 'rgba(255, 190, 140, 0)');
  sky.addColorStop(1, 'rgba(255, 190, 140, 0.12)');
  g.globalCompositeOperation = 'source-atop';
  g.fillStyle = sky;
  g.fillRect(0, 0, 256, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * A unit-length spacecraft pointing along +X: slim fuselage, delta wings, twin canted
 * fins and twin engines with a blue exhaust. Matcap shading, so it needs no scene lights.
 */
function buildShip(matcap: THREE.Texture) {
  const group = new THREE.Group();
  const part = (geo: THREE.BufferGeometry, color: number) => {
    const mesh = new THREE.Mesh(geo, new THREE.MeshMatcapMaterial({ color, matcap, fog: false }));
    group.add(mesh);
    return mesh;
  };
  const HULL = 0xd6dae2;
  const TRIM = 0x8d94a1;
  const DARK = 0x464c58;

  const profile = [
    [0, -0.42],
    [0.045, -0.42],
    [0.062, -0.36],
    [0.068, -0.15],
    [0.064, 0.05],
    [0.05, 0.22],
    [0.03, 0.36],
    [0.012, 0.46],
    [0, 0.5],
  ].map(([r, y]) => new THREE.Vector2(r, y));
  part(new THREE.LatheGeometry(profile, 32).rotateZ(-Math.PI / 2).scale(1, 0.72, 1), HULL);
  // Canopy: dark tinted glass along the spine.
  part(new THREE.SphereGeometry(1, 24, 12).scale(0.15, 0.03, 0.034).translate(0.19, 0.035, 0), 0x1c2838);

  const flat = (pts: number[][], depth: number) => {
    const shape = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
    return new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
  };
  // Shapes are drawn in X/Y and extruded along Z; rotateX(π/2) lays them flat with +Y → +Z.
  const plate = (pts: number[][], depth: number) => flat(pts, depth).rotateX(Math.PI / 2).translate(0, depth / 2, 0);
  for (const s of [1, -1]) {
    part(plate([[0.1, 0], [-0.34, 0], [-0.41, 0.3 * s], [-0.335, 0.3 * s]], 0.012).translate(0, -0.012, 0), TRIM);
    part(plate([[0.31, 0], [0.21, 0], [0.19, 0.075 * s], [0.225, 0.075 * s]], 0.008), DARK);
    // Twin tail fins, canted outward.
    part(
      flat([[-0.2, 0], [-0.4, 0], [-0.455, 0.15], [-0.385, 0.15]], 0.01)
        .translate(0, 0, -0.005)
        .rotateX(0.38 * s)
        .translate(0, 0.02, 0.055 * s),
      DARK
    );
    // Engine nacelle and nozzle.
    part(new THREE.CylinderGeometry(0.03, 0.036, 0.26, 20).rotateZ(-Math.PI / 2).translate(-0.33, -0.006, 0.075 * s), TRIM);
    part(new THREE.CylinderGeometry(0.036, 0.03, 0.03, 20).rotateZ(-Math.PI / 2).translate(-0.475, -0.006, 0.075 * s), DARK);
  }

  const glow = (color: number, opacity: number) =>
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
  const plume = (r: number, len: number) => new THREE.ConeGeometry(r, len, 16, 1, true).rotateZ(Math.PI / 2).translate(-len / 2, 0, 0);
  const flame = new THREE.Group();
  for (const s of [1, -1]) {
    const z = 0.075 * s;
    flame.add(
      new THREE.Mesh(plume(0.028, 0.38).translate(0, -0.006, z), glow(0x4f9dff, 0.5)),
      new THREE.Mesh(plume(0.014, 0.22).translate(0, -0.006, z), glow(0xdff2ff, 0.9))
    );
    const disc = new THREE.Mesh(new THREE.CircleGeometry(0.026, 20).rotateY(-Math.PI / 2).translate(-0.003, -0.006, z), glow(0xbfe6ff, 1));
    group.add(disc.translateX(-0.49));
  }
  flame.position.x = -0.49;
  group.add(flame);
  return { group, flame };
}

function buildDust(count: number) {
  const pos = new Float32Array(count * 3);
  for (let i = 0; i < pos.length; i++) pos[i] = Math.random() - 0.5;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uCenter: { value: new THREE.Vector3() }, uBox: { value: 1 }, uPx: { value: 2 } },
    vertexShader: `
      uniform vec3 uCenter; uniform float uBox, uPx; varying float vA;
      void main() {
        vec3 p = uCenter + (fract(position - uCenter / uBox + 0.5) - 0.5) * uBox;  // wrap around the camera
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        float d = -mv.z / uBox;
        vA = smoothstep(0.0, 0.06, d) * (1.0 - smoothstep(0.25, 0.5, d));
        gl_PointSize = uPx;
      }`,
    fragmentShader: `
      varying float vA;
      void main() { gl_FragColor = vec4(0.75, 0.8, 1.0, 0.35 * vA); }`,
  });
  return new THREE.Points(geo, mat);
}

// --------------------------------------------------------------------- HUD

const KEYS_HELP =
  '<b>↑ W</b> thrust · <b>↓ S</b> brake · <b>← → A D</b> turn · <b>R F</b> climb/dive · <b>Q E</b> roll · <b>Shift</b> boost · ' +
  '<b>drag</b> to steer · <b>scroll</b> cruise speed · <b>C</b> camera · <b>Esc</b> leave';

function buildHud() {
  const hud = document.createElement('div');
  hud.className = 'ship-hud';
  hud.hidden = true;
  hud.innerHTML = `
    <div class="ship-read"></div>
    <div class="ship-row">
      <span class="ship-lbl">Cruise</span>
      <button class="btn ship-slow" title="Slower (scroll down)" aria-label="Slower">−</button>
      <div class="ship-bar"><i class="ship-cruise"></i><i class="ship-speed"></i></div>
      <button class="btn ship-fast" title="Faster (scroll up)" aria-label="Faster">+</button>
      <button class="btn ship-cam"></button>
      <button class="btn primary ship-exit">Leave ship</button>
    </div>
    <div class="ship-keys">${KEYS_HELP}</div>`;
  const reticle = document.createElement('div');
  reticle.className = 'ship-reticle';
  reticle.hidden = true;
  document.body.append(hud, reticle);
  const q = <T extends HTMLElement>(sel: string) => hud.querySelector(sel) as T;
  return {
    hud,
    reticle,
    read: q('.ship-read'),
    cruise: q('.ship-cruise'),
    speed: q('.ship-speed'),
    slow: q<HTMLButtonElement>('.ship-slow'),
    fast: q<HTMLButtonElement>('.ship-fast'),
    cam: q<HTMLButtonElement>('.ship-cam'),
    exit: q<HTMLButtonElement>('.ship-exit'),
  };
}

// ------------------------------------------------------- orientation globe

/** Heading of a world direction, degrees 0..360 (0 = +X, 90 = −Z, matching a left turn). */
export function headingDeg(d: THREE.Vector3): number {
  return (THREE.MathUtils.radToDeg(Math.atan2(-d.z, d.x)) + 360) % 360;
}

/**
 * A small attitude ball: the world's directions painted on a sphere, seen from the ship.
 * The centre is where the nose points; the top half is world +Y ("up"), the bottom half −Y,
 * with a grid every 30° and labelled directions. Drawn per pixel on a 2D canvas.
 */
function buildNavball() {
  const wrap = document.createElement('div');
  wrap.className = 'ship-nav';
  wrap.hidden = true;
  wrap.setAttribute('aria-hidden', 'true');
  const canvas = document.createElement('canvas');
  const caption = document.createElement('div');
  caption.className = 'ship-nav-read';
  wrap.append(canvas, caption);
  document.body.append(wrap);
  const g = canvas.getContext('2d')!;
  let img: ImageData | null = null;
  let lastCaption = '';
  const F = new THREE.Vector3();
  const U = new THREE.Vector3();
  const Rt = new THREE.Vector3();
  const d = new THREE.Vector3();
  const STEP = Math.PI / 6;
  const SKY = [58, 95, 176];
  const GROUND = [52, 40, 82];
  const LINE = 0.028;

  function size() {
    const css = canvas.clientWidth || 92;
    const px = Math.round(css * Math.min(devicePixelRatio, 2));
    if (canvas.width !== px) {
      canvas.width = canvas.height = px;
      img = g.createImageData(px, px);
    }
    return px;
  }

  function draw(q: THREE.Quaternion, marks: CompassMark[] = []) {
    const N = size();
    const data = img!.data;
    const c = N / 2;
    const R = c - 1;
    F.set(1, 0, 0).applyQuaternion(q);
    U.set(0, 1, 0).applyQuaternion(q);
    Rt.set(0, 0, 1).applyQuaternion(q);
    for (let py = 0; py < N; py++) {
      for (let px = 0; px < N; px++) {
        const i = 4 * (px + N * py);
        const sx = (px + 0.5 - c) / R;
        const sy = (py + 0.5 - c) / R;
        const rr = sx * sx + sy * sy;
        if (rr >= 1) {
          data[i + 3] = 0;
          continue;
        }
        const f = Math.sqrt(1 - rr);
        // Screen right = ship right (+Z), screen up = ship up (+Y), centre = nose (+X).
        const dx = F.x * f + U.x * -sy + Rt.x * sx;
        const dy = F.y * f + U.y * -sy + Rt.y * sx;
        const dz = F.z * f + U.z * -sy + Rt.z * sx;
        const lat = Math.asin(Math.max(-1, Math.min(1, dy)));
        const lon = Math.atan2(-dz, dx);
        const latOff = Math.abs(lat - Math.round(lat / STEP) * STEP);
        const lonOff = Math.abs(lon - Math.round(lon / STEP) * STEP) * Math.cos(lat);
        const base = dy >= 0 ? SKY : GROUND;
        let line = 0;
        if (Math.abs(lat) < LINE * 1.6) line = 1;
        else if (latOff < LINE || lonOff < LINE) line = 0.35;
        const shade = 0.5 + 0.5 * f;
        for (let k = 0; k < 3; k++) data[i + k] = (base[k] + (230 - base[k]) * line) * shade;
        data[i + 3] = 255 * Math.min(1, (1 - Math.sqrt(rr)) * R * 1.5) * 0.92;
      }
    }
    g.putImageData(img!, 0, 0);

    const s = N / 92;
    g.font = `600 ${9.5 * s}px system-ui, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (const m of marks) {
      d.set(...m.dir).normalize();
      const f = d.dot(F);
      if (f < 0.12) continue;
      const x = c + d.dot(Rt) * R;
      const y = c - d.dot(U) * R;
      g.globalAlpha = Math.min(1, (f - 0.12) * 4);
      g.fillStyle = 'rgba(4, 3, 11, 0.55)';
      const w = g.measureText(m.label).width + 6 * s;
      g.fillRect(x - w / 2, y - 6.5 * s, w, 13 * s);
      g.fillStyle = m.color ?? '#e8ecff';
      g.fillText(m.label, x, y + 0.5 * s);
    }
    g.globalAlpha = 1;
    // Fixed ship symbol at the centre: where the nose points.
    g.strokeStyle = '#ffb36b';
    g.lineWidth = 2 * s;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(c - 14 * s, c);
    g.lineTo(c - 6 * s, c);
    g.lineTo(c - 3 * s, c + 4 * s);
    g.lineTo(c, c);
    g.lineTo(c + 3 * s, c + 4 * s);
    g.lineTo(c + 6 * s, c);
    g.lineTo(c + 14 * s, c);
    g.stroke();
    g.strokeStyle = 'rgba(160, 190, 255, 0.35)';
    g.lineWidth = 1 * s;
    g.beginPath();
    g.arc(c, c, R - 0.5 * s, 0, Math.PI * 2);
    g.stroke();

    const text = `HDG ${Math.round(headingDeg(F)).toString().padStart(3, '0')}° · ${lat0(F)}`;
    if (text !== lastCaption) caption.textContent = lastCaption = text;
  }
  const lat0 = (f: THREE.Vector3) => {
    const p = Math.round(THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(f.y, -1, 1))));
    return `${p >= 0 ? '▲' : '▼'} ${Math.abs(p)}°`;
  };
  return { wrap, draw };
}

const KEYMAP: Record<string, keyof typeof NO_KEYS> = {
  ArrowUp: 'fwd',
  KeyW: 'fwd',
  ArrowDown: 'back',
  KeyS: 'back',
  ArrowLeft: 'left',
  KeyA: 'left',
  ArrowRight: 'right',
  KeyD: 'right',
  KeyR: 'up',
  PageUp: 'up',
  KeyF: 'down',
  KeyQ: 'rollL',
  KeyE: 'rollR',
  PageDown: 'down',
  ShiftLeft: 'boost',
  ShiftRight: 'boost',
};
const NO_KEYS = { fwd: false, back: false, left: false, right: false, up: false, down: false, rollL: false, rollR: false, boost: false };

const isTextField = (t: EventTarget | null) =>
  t instanceof HTMLElement &&
  (t.isContentEditable || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || (t instanceof HTMLInputElement && t.type !== 'range' && t.type !== 'checkbox'));

// --------------------------------------------------------------------- rig

export function createShipRig(opts: ShipOptions): ShipRig {
  const { scene, camera, controls, dom } = opts;
  const matcap = metalMatcap();
  const { group: ship, flame } = buildShip(matcap);
  ship.visible = false;
  scene.add(ship);
  const dust = buildDust(500);
  dust.visible = false;
  scene.add(dust);
  const ui = buildHud();
  const nav = buildNavball();
  // On narrower screens the flight panel sits in the bottom-right corner, so stack the globe above it.
  const narrow = matchMedia('(max-width: 1100px)');
  const placeNav = () => {
    nav.wrap.style.bottom = narrow.matches && !ui.hud.hidden ? `${ui.hud.offsetHeight + 24}px` : '';
  };
  new ResizeObserver(placeNav).observe(ui.hud);
  narrow.addEventListener('change', placeNav);

  let world: ShipWorld | null = null;
  let view: ShipCamera = 'chase';
  const st: FlightState = {
    pos: new THREE.Vector3(),
    quat: new THREE.Quaternion(),
    bank: 0,
    speed: 0,
    yawRate: 0,
    pitchRate: 0,
    rollRate: 0,
    cruise: 0.3,
  };
  const bankQ = new THREE.Quaternion();
  const xAxis = new THREE.Vector3(1, 0, 0);
  const keys = { ...NO_KEYS };
  let steer: { x0: number; y0: number; x: number; y: number; id: number } | null = null;
  let saved: { pos: THREE.Vector3; quat: THREE.Quaternion; up: THREE.Vector3; near: number; fog: THREE.Scene['fog']; orbit: boolean } | null = null;
  let last = 0;
  let readKey = '';
  const camPos = new THREE.Vector3();
  const camUp = new THREE.Vector3(0, 1, 0);
  const fwd = new THREE.Vector3();
  const up = new THREE.Vector3();
  const tmp = new THREE.Vector3();

  const input = () => opts.onInput?.();
  const setCruise = (v: number) => {
    st.cruise = THREE.MathUtils.clamp(Math.round(v * 10) / 10, 0, 1);
    input();
  };
  const syncCamButton = () => {
    ui.cam.textContent = view === 'chase' ? 'Cockpit view' : 'Chase view';
    ui.cam.title = 'Switch camera (C)';
    ship.visible = view === 'chase';
    ui.reticle.hidden = view !== 'cockpit';
  };
  const toggleView = () => {
    view = view === 'chase' ? 'cockpit' : 'chase';
    syncCamButton();
    snapCamera();
    input();
  };

  // ---- input handlers (attached only while flying)
  const onKeyDown = (e: KeyboardEvent) => {
    if (isTextField(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = KEYMAP[e.code];
    if (k) {
      keys[k] = true;
      e.preventDefault();
      input();
    } else if (e.code === 'KeyC' || e.code === 'KeyV') {
      toggleView();
    } else if (e.code === 'Escape') {
      rig.exit();
    } else if (e.code === 'Equal' || e.code === 'NumpadAdd') {
      setCruise(st.cruise + 0.1);
    } else if (e.code === 'Minus' || e.code === 'NumpadSubtract') {
      setCruise(st.cruise - 0.1);
    }
  };
  const onKeyUp = (e: KeyboardEvent) => {
    const k = KEYMAP[e.code];
    if (k) keys[k] = false;
  };
  const onBlur = () => Object.assign(keys, NO_KEYS);
  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 || steer) return;
    steer = { x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, id: e.pointerId };
    dom.setPointerCapture(e.pointerId);
    input();
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!steer || e.pointerId !== steer.id) return;
    steer.x = e.clientX;
    steer.y = e.clientY;
  };
  const onPointerUp = (e: PointerEvent) => {
    if (steer && e.pointerId === steer.id) steer = null;
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    setCruise(st.cruise + (e.deltaY < 0 ? 0.1 : -0.1));
  };
  ui.slow.onclick = () => setCruise(st.cruise - 0.1);
  ui.fast.onclick = () => setCruise(st.cruise + 0.1);
  ui.cam.onclick = toggleView;
  ui.exit.onclick = () => rig.exit();

  function listen(on: boolean) {
    const m = on ? 'addEventListener' : 'removeEventListener';
    window[m]('keydown', onKeyDown as EventListener);
    window[m]('keyup', onKeyUp as EventListener);
    window[m]('blur', onBlur);
    dom[m]('pointerdown', onPointerDown as EventListener);
    dom[m]('pointermove', onPointerMove as EventListener);
    dom[m]('pointerup', onPointerUp as EventListener);
    dom[m]('pointercancel', onPointerUp as EventListener);
    dom[m]('wheel', onWheel as EventListener, { passive: false } as AddEventListenerOptions);
  }

  function applyWorld(w: ShipWorld) {
    world = w;
    ship.scale.setScalar(w.size);
    scene.fog = w.fog ?? null;
    dust.visible = w.dust !== false;
    const m = dust.material as THREE.ShaderMaterial;
    m.uniforms.uBox.value = w.size * 60;
    m.uniforms.uPx.value = Math.max(1.5, devicePixelRatio * 1.5);
    camera.near = w.size * 0.04;
    camera.updateProjectionMatrix();
    if (w.bounds) w.bounds.clampPoint(st.pos, st.pos);
    readKey = '';
  }

  function placeShip() {
    ship.position.copy(st.pos);
    ship.quaternion.copy(st.quat).multiply(bankQ.setFromAxisAngle(xAxis, st.bank));
    fwd.set(1, 0, 0).applyQuaternion(st.quat);
    up.set(0, 1, 0).applyQuaternion(st.quat);
  }

  function chaseTarget(out: THREE.Vector3) {
    const s = world!.size;
    return out.copy(st.pos).addScaledVector(fwd, -4.4 * s).addScaledVector(up, 1.35 * s);
  }

  function snapCamera() {
    if (!world) return;
    placeShip();
    chaseTarget(camPos);
    camUp.copy(up);
  }

  function updateCamera(dt: number) {
    const s = world!.size;
    if (view === 'cockpit') {
      camera.position.copy(st.pos).addScaledVector(fwd, 0.35 * s).addScaledVector(up, 0.12 * s);
      camera.up.copy(up);
      camera.lookAt(tmp.copy(camera.position).add(fwd));
      return;
    }
    // Chase: a spring toward a point behind and above the ship, looking a little ahead of it.
    camPos.lerp(chaseTarget(tmp), 1 - Math.exp(-7 * dt));
    // The camera rolls with the ship, so loops and inverted flight stay readable.
    camUp.lerp(up, 1 - Math.exp(-5 * dt)).normalize();
    camera.position.copy(camPos);
    camera.up.copy(camUp);
    camera.lookAt(tmp.copy(st.pos).addScaledVector(fwd, 2.5 * s));
  }

  function updateHud() {
    const w = world!;
    ui.cruise.style.width = `${st.cruise * 100}%`;
    const frac = Math.min(1, Math.abs(st.speed) / (w.speed * BOOST));
    ui.speed.style.width = `${frac * 100}%`;
    ui.speed.classList.toggle('reverse', st.speed < 0);
    const html = w.describe?.(st.pos) ?? '';
    if (html !== readKey) {
      readKey = html;
      ui.read.innerHTML = html;
      ui.read.hidden = !html;
    }
  }

  const rig: ShipRig = {
    get active() {
      return world !== null;
    },
    get position() {
      return st.pos;
    },
    enter(w) {
      if (world) return rig.setWorld(w);
      saved = {
        pos: camera.position.clone(),
        quat: camera.quaternion.clone(),
        up: camera.up.clone(),
        near: camera.near,
        fog: scene.fog,
        orbit: controls?.enabled ?? false,
      };
      if (controls) controls.enabled = false;
      st.pos.copy(w.start);
      orientation(w.yaw ?? 0, w.pitch ?? 0, st.quat);
      st.bank = st.speed = st.yawRate = st.pitchRate = st.rollRate = 0;
      applyWorld(w);
      (document.activeElement as HTMLElement | null)?.blur?.();
      listen(true);
      syncCamButton();
      snapCamera();
      ui.hud.hidden = nav.wrap.hidden = false;
      placeNav();
      document.body.dataset.ship = 'on';
      last = performance.now();
      opts.onEnter?.();
      input();
    },
    setWorld(w) {
      if (!world) return;
      applyWorld(w);
    },
    exit() {
      if (!world) return;
      world = null;
      listen(false);
      Object.assign(keys, NO_KEYS);
      steer = null;
      ship.visible = dust.visible = false;
      ui.hud.hidden = ui.reticle.hidden = nav.wrap.hidden = true;
      delete document.body.dataset.ship;
      if (saved) {
        camera.position.copy(saved.pos);
        camera.quaternion.copy(saved.quat);
        camera.up.copy(saved.up);
        camera.near = saved.near;
        camera.updateProjectionMatrix();
        scene.fog = saved.fog;
        if (controls) controls.enabled = saved.orbit;
        saved = null;
      }
      opts.onExit?.();
    },
    tick(now) {
      const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
      last = now;
      if (!world) return;
      let turn = +keys.left - +keys.right;
      let climb = +keys.up - +keys.down;
      if (steer) {
        // Drag works like a joystick: the offset from where you pressed sets the turn rate.
        const reach = 0.16 * Math.min(innerWidth, innerHeight);
        turn -= THREE.MathUtils.clamp((steer.x - steer.x0) / reach, -1, 1);
        climb -= THREE.MathUtils.clamp((steer.y - steer.y0) / reach, -1, 1);
      }
      const roll = +keys.rollR - +keys.rollL;
      stepFlight(st, { thrust: +keys.fwd - +keys.back, turn, climb, roll, boost: keys.boost }, dt, world);
      placeShip();
      const thrust = Math.max(0, st.speed) / world.speed;
      flame.scale.set(0.25 + 0.9 * thrust * (0.9 + 0.2 * Math.sin(now * 0.05)), 1, 1);
      flame.visible = thrust > 0.02;
      updateCamera(dt);
      (dust.material as THREE.ShaderMaterial).uniforms.uCenter.value.copy(camera.position);
      updateHud();
      nav.draw(st.quat, world.compass);
    },
  };
  return rig;
}
