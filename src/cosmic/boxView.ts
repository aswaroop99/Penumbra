import * as THREE from 'three';
import { MarchingCubes } from 'three/addons/objects/MarchingCubes.js';
import type { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { cosmosIndex, loadCosmos3d, type CosmosMeta } from '../lib/cosmos3d';
import {
  displacementField,
  forEachMode,
  fft3,
  growth,
  lookbackGyr,
  sigma8From,
  whiteNoiseK,
  type KField,
  type Vec3,
} from './physics';
import { $, getCam, label, makeBase, nextFrame, serial, type Ctx, type View } from './viewKit';
import type { BoxSource, CosmicView } from './viewCodec';

/** A grid in box axes: X = distance (long axis), Y = declination (up), Z = right ascension. */
interface BoxGrid {
  NX: number;
  NY: number;
  NZ: number;
  data: Float32Array;
  get(X: number, Y: number, Z: number): number;
}

interface Frame {
  items: THREE.Object3D[];
  hy: number;
  hz: number;
}

const RES = 128; // marching-cubes grid
const WORLD = 10; // world length of the long axis
const HW = WORLD / 2;

const SIM = { dims: [128, 32, 32] as Vec3, L: [512, 128, 128] as Vec3, zNear: 0.25, zFar: 0.95 };

const CAPTION: Record<BoxSource, string> = {
  cosmos:
    'Our rebuild of the Hubble COSMOS 3D dark-matter map (Massey et al. 2007) from the public galaxy-shape catalog. Galaxies are split by distance, each group gives a lensing mass map, and the change from group to group places the mass in depth. Solid clumps show where a lens is detected with high significance. The faint purple haze is low-confidence structure below that threshold: much of it is noise, so read it as "possibly something here", not as mapped filaments. Depth resolution is poor, so clumps stretch along the distance axis. The strongest structure sits at z ≈ 0.7, where the known COSMOS cluster at z ≈ 0.73 is. Not to scale: the real volume is a long, narrow cone.',
  sim: 'Styled after the Hubble COSMOS 3D dark-matter map (Massey et al. 2007), but built from the in-browser simulation, not telescope data. The box runs from about 3 to 8 billion years ago. Distances are not to scale: the real survey volume is a long, narrow cone.',
};

/**
 * View 2: the 3D map. By default our rebuild of the COSMOS 3D mass map from real Hubble
 * data (data/cosmos, made by prep/cosmos_3d.py), with a low-confidence haze layer; the
 * simulated Massey-style light-cone box stays available as a toggle.
 */
export function createBoxView(ctx: Ctx): View {
  const base = makeBase(ctx, 0x0a0f33, 40, 0.1, 200);
  let src: BoxSource = 'cosmos';
  const grids: { cosmos?: BoxGrid; cosmosFaint?: BoxGrid; sim?: BoxGrid } = {};
  let cosmosMeta: CosmosMeta | null = null;
  let cosmosFailed = false;
  let threshold = 0;

  base.scene.add(new THREE.AmbientLight(0x6a7bd0, 0.9));
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(3, 6, 5);
  base.scene.add(key);
  const rim = new THREE.DirectionalLight(0x7fb2ff, 1.0);
  rim.position.set(-6, -2, -4);
  base.scene.add(rim);

  const mc = new MarchingCubes(
    RES,
    new THREE.MeshPhongMaterial({
      color: 0x4d86ff,
      emissive: 0x0b1f6a,
      specular: 0xbcd4ff,
      shininess: 60,
      transparent: true,
      opacity: 0.82,
      side: THREE.DoubleSide,
      depthWrite: true,
    }),
    false,
    false,
    400000
  );
  mc.scale.setScalar(WORLD / 2);
  base.scene.add(mc);

  // Low-confidence haze (COSMOS only): weaker structure below the clump threshold, much of it
  // noise. Drawn after the clumps without depth writes, so the solid clumps show through it.
  const mcFaint = new MarchingCubes(
    RES,
    new THREE.MeshBasicMaterial({ color: 0xc4aaff, transparent: true, opacity: 0.13, side: THREE.DoubleSide, depthWrite: false }),
    false,
    false,
    600000
  );
  mcFaint.scale.setScalar(WORLD / 2);
  mcFaint.renderOrder = 1;
  base.scene.add(mcFaint);

  // Wireframe box + axis labels per source. Labels are toggled one by one,
  // because CSS2DRenderer ignores a parent's visibility.
  const frames: Partial<Record<BoxSource, Frame>> = {};
  function makeFrame(name: BoxSource, NY: number, NZ: number, zNear: number, zFar: number, ticks: number[]) {
    const hy = (WORLD * NY) / RES / 2;
    const hz = (WORLD * NZ) / RES / 2;
    const items: THREE.Object3D[] = [
      new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.BoxGeometry(WORLD, 2 * hy, 2 * hz)),
        new THREE.LineBasicMaterial({ color: 0xc8d4ff, transparent: true, opacity: 0.55 })
      ),
    ];
    for (const z of ticks) {
      const l = label(`${lookbackGyr(z, 0.315).toFixed(1)} billion years ago<small>z = ${z.toFixed(2)}</small>`);
      l.position.set(-HW + (WORLD * (z - zNear)) / (zFar - zNear), -hy - 0.45, hz);
      items.push(l);
    }
    const ax = label('<span class="axis">nearer · more recent  ←  distance from Earth  →  farther · earlier</span>');
    ax.position.set(0, -hy - 1.6, hz);
    const ra = label('<span class="axis">right ascension</span>');
    ra.position.set(-HW - 0.2, -hy, 0);
    const dec = label('<span class="axis">declination</span>');
    dec.position.set(-HW - 0.2, 0, hz + 0.2);
    items.push(ax, ra, dec);
    items.forEach((o) => base.scene.add(o));
    frames[name] = { items, hy, hz };
  }
  function showFrame(name: BoxSource) {
    for (const [n, f] of Object.entries(frames)) f.items.forEach((o) => (o.visible = n === name));
  }

  base.camera.position.set(-4.2, 5, 12.5);
  if (innerWidth < innerHeight) base.camera.position.multiplyScalar(1.8); // fit the long box on portrait screens
  base.controls.target.set(0, -0.3, 0);
  base.controls.autoRotateSpeed = 0.25;
  base.controls.minDistance = 3;
  base.controls.maxDistance = 30;

  const fracInput = () => $<HTMLInputElement>('frac');
  const sigInput = () => $<HTMLInputElement>('sig');

  function fill(target: MarchingCubes, g: BoxGrid) {
    target.reset();
    const f = target.field;
    const oy = (RES - g.NY) / 2;
    const oz = (RES - g.NZ) / 2;
    for (let Z = 0; Z < g.NZ; Z++)
      for (let Y = 0; Y < g.NY; Y++)
        for (let X = 2; X < g.NX - 2; X++) {
          f[X + RES * (Y + oy) + RES * RES * (Z + oz)] = g.get(X, Y, Z);
        }
  }

  function drawClumps() {
    const g = grids[src];
    if (!g) return;
    const frac = +fracInput().value;
    if (src === 'cosmos') {
      threshold = +sigInput().value;
    } else {
      const sorted = Float32Array.from(g.data).sort();
      threshold = Math.max(0.05, sorted[Math.floor((1 - frac) * (sorted.length - 1))]);
    }
    fill(mc, g);
    mc.isolation = threshold;
    mc.update();
    $('fracval').textContent = `${Math.round(frac * 100)}%`;
    $('sigval').textContent = `${(+sigInput().value).toFixed(1)}σ`;
    $('fracnote').textContent =
      src === 'cosmos'
        ? `Solid: lens detections above ${threshold.toFixed(1)}σ.`
        : 'Share of the box drawn as dark-matter clumps (the densest regions).';
    drawFaint();
  }

  function drawFaint() {
    const g = grids.cosmosFaint;
    mcFaint.visible = src === 'cosmos' && !!g && $<HTMLInputElement>('faintOn').checked;
    if (!g || !mcFaint.visible) return;
    // Keep the haze strictly below the clump threshold so the two layers never claim the same level.
    const t = Math.min(+$<HTMLInputElement>('faintSig').value, threshold - 0.1);
    fill(mcFaint, g);
    mcFaint.isolation = t;
    mcFaint.update();
    $('faintval').textContent = `${t.toFixed(1)}σ`;
    $('faintnote').textContent =
      `Haze: signal from ${t.toFixed(1)}σ to ${threshold.toFixed(1)}σ. Not detections. ` +
      'At this level much of it is random galaxy-shape noise, and it smears along the distance axis. ' +
      'It may trace real filaments, but this data cannot tell them apart from noise.';
  }

  // ---------- simulation source ----------
  makeFrame('sim', SIM.dims[1], SIM.dims[2], SIM.zNear, SIM.zFar, [0.25, 0.25 + 0.7 / 3, 0.25 + 1.4 / 3, 0.95]);
  let noise: KField | null = null;
  async function buildSim() {
    const { dims, L } = SIM;
    const [nx, ny, nz] = dims;
    const N = nx * ny * nz;
    const cell = L[0] / nx; // 4 Mpc/h
    ctx.busy(true);
    await nextFrame();
    if (!noise) noise = whiteNoiseK(dims, 2007);
    const psi = displacementField(noise, dims, L, {
      om: ctx.params.om,
      sigma8: sigma8From(ctx.params.s8, ctx.params.om),
      Rs: 4.0,
    });
    // Light-cone: nearer slabs (small x) are seen later in cosmic time, so they've grown more.
    const Dx = new Float64Array(nx);
    for (let x = 0; x < nx; x++) Dx[x] = growth(SIM.zNear + ((SIM.zFar - SIM.zNear) * (x + 0.5)) / nx, ctx.params.om);
    // Move one particle per cell, deposit with cloud-in-cell.
    const rho = new Float64Array(N);
    const im = new Float64Array(N);
    for (let z = 0; z < nz; z++)
      for (let y = 0; y < ny; y++)
        for (let x = 0; x < nx; x++) {
          const i = x + nx * (y + ny * z);
          const D = Dx[x];
          const gx = x + D * (psi[0][i] / cell);
          const gy = y + D * (psi[1][i] / cell);
          const gz = z + D * (psi[2][i] / cell);
          const x0 = Math.floor(gx);
          const y0 = Math.floor(gy);
          const z0 = Math.floor(gz);
          const fx = gx - x0;
          const fy = gy - y0;
          const fz = gz - z0;
          for (let c = 0; c < 8; c++) {
            const ddx = c & 1;
            const ddy = (c >> 1) & 1;
            const ddz = (c >> 2) & 1;
            const w = (ddx ? fx : 1 - fx) * (ddy ? fy : 1 - fy) * (ddz ? fz : 1 - fz);
            const xi = (((x0 + ddx) % nx) + nx) % nx;
            const yi = (((y0 + ddy) % ny) + ny) % ny;
            const zi = (((z0 + ddz) % nz) + nz) % nz;
            rho[xi + nx * (yi + ny * zi)] += w;
          }
        }
    for (let i = 0; i < N; i++) rho[i] -= 1;
    // Smooth like a lensing map would (~8 Mpc/h Gaussian).
    fft3(rho, im, dims, false);
    forEachMode(dims, L, (i, _kx, _ky, _kz, k2) => {
      const g = Math.exp(-0.5 * k2 * 64);
      rho[i] *= g;
      im[i] *= g;
    });
    fft3(rho, im, dims, true);
    const data = Float32Array.from(rho);
    grids.sim = { NX: nx, NY: ny, NZ: nz, data, get: (X, Y, Z) => data[X + nx * (Y + ny * Z)] };
    ctx.busy(false);
  }

  // ---------- COSMOS source ----------
  const peakMarker = new THREE.Mesh(
    new THREE.TorusGeometry(0.28, 0.025, 8, 48),
    new THREE.MeshBasicMaterial({ color: 0xffd34d })
  );
  peakMarker.visible = false;
  const peakLabel: CSS2DObject = label('');
  peakLabel.visible = false;
  base.scene.add(peakMarker, peakLabel);

  async function loadCosmos() {
    try {
      const { meta, clumps, faint } = await loadCosmos3d(import.meta.env.BASE_URL);
      cosmosMeta = meta;
      const [ny, nx, nd] = meta.shape;
      const grid = (data: Float32Array): BoxGrid => ({
        NX: nd,
        NY: ny,
        NZ: nx,
        data,
        get: (X, Y, Z) => data[cosmosIndex(meta, Y, Z, X)],
      });
      grids.cosmos = grid(clumps);
      if (faint) grids.cosmosFaint = grid(faint);
      const { zNear, zFar, bounds: b } = meta;
      makeFrame('cosmos', ny, nx, zNear, zFar, [0.1, 0.4, 0.7, 1.0, 1.3].filter((z) => z > zNear && z < zFar + 1e-6));
      // Mark the strongest structure.
      const p = meta.peaks[0];
      const f = frames.cosmos!;
      if (p) {
        peakMarker.position.set(
          -HW + (WORLD * (p.z - zNear)) / (zFar - zNear),
          -f.hy + (2 * f.hy * (p.dec - b.decMin)) / (b.decMax - b.decMin),
          -f.hz + (2 * f.hz * (b.raMax - p.ra)) / (b.raMax - b.raMin)
        );
        peakMarker.rotation.y = Math.PI / 2;
        peakLabel.position.copy(peakMarker.position).add(new THREE.Vector3(0, f.hy + 0.6 - peakMarker.position.y, 0));
        peakLabel.element.innerHTML = `Strongest structure<small>z ≈ ${p.z.toFixed(1)} · ${p.value.toFixed(1)}σ · RA ${p.ra.toFixed(2)}°, Dec ${p.dec.toFixed(2)}°</small>`;
      }
    } catch (e) {
      cosmosFailed = true;
      console.warn('COSMOS 3D grid not available; run prep/cosmos_3d.py', e);
    }
  }

  const setSource = serial(async (name: BoxSource) => {
    if (name === 'cosmos' && !grids.cosmos && !cosmosFailed) {
      ctx.busy(true);
      await loadCosmos();
      ctx.busy(false);
    }
    if (name === 'cosmos' && cosmosFailed) name = 'sim';
    src = name;
    document
      .querySelectorAll<HTMLElement>('[data-src]')
      .forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.src === src)));
    if (src === 'sim' && !grids.sim) await buildSim();
    showFrame(src);
    peakMarker.visible = peakLabel.visible = src === 'cosmos' && !!cosmosMeta?.peaks.length;
    document.body.dataset.boxsrc = src;
    if (document.body.dataset.active === 'box') $('caption').textContent = CAPTION[src];
    drawClumps();
  });

  let flight: { t0: number; p0: THREE.Vector3; p1: THREE.Vector3; q0: THREE.Vector3; q1: THREE.Vector3 } | null = null;
  function flyToPeak() {
    if (!peakMarker.visible) return;
    const t = peakMarker.position.clone();
    flight = {
      t0: performance.now(),
      p0: base.camera.position.clone(),
      p1: t.clone().add(new THREE.Vector3(-1.2, 1.4, 3.6)),
      q0: base.controls.target.clone(),
      q1: t,
    };
  }
  base.controls.addEventListener('start', () => (flight = null));

  document.querySelectorAll<HTMLElement>('[data-src]').forEach((b) => {
    b.onclick = async () => {
      const again = b.dataset.src === src;
      await setSource(b.dataset.src as BoxSource);
      if (again && src === 'cosmos') flyToPeak();
    };
  });
  fracInput().oninput = () => drawClumps();
  sigInput().oninput = () => drawClumps();
  $<HTMLInputElement>('faintSig').oninput = () => drawFaint();
  $<HTMLInputElement>('faintOn').onchange = () => drawFaint();
  document.body.dataset.boxsrc = src;

  return {
    ...base,
    get caption() {
      return CAPTION[src];
    },
    // First show loads the current source. Later calls come from the S8/Ωm sliders,
    // which only change the simulation.
    async rebuild() {
      grids.sim = undefined;
      await setSource(src);
    },
    tick(now) {
      if (!flight) return;
      const k = Math.min(1, (now - flight.t0) / 1200);
      const e = k < 0.5 ? 4 * k ** 3 : 1 - (-2 * k + 2) ** 3 / 2;
      base.camera.position.lerpVectors(flight.p0, flight.p1, e);
      base.controls.target.lerpVectors(flight.q0, flight.q1, e);
      if (k === 1) flight = null;
    },
    onShow: () => {},
    hud: () =>
      src === 'cosmos'
        ? [
            'Dark matter in 3D: COSMOS',
            `A ${cosmosMeta ? (cosmosMeta.widthArcmin / 60).toFixed(1) : '1.4'}° patch of sky seen by Hubble, out to z ≈ ${cosmosMeta ? cosmosMeta.zFar.toFixed(1) : '1.3'}`,
          ]
        : [
            'Dark matter in 3D: simulated',
            `Clumpier toward the near side: structure has had longer to grow · S8 = ${ctx.params.s8.toFixed(2)}`,
          ],
    source: () =>
      src === 'cosmos' && cosmosMeta
        ? `<b class="real">Survey data</b>Hubble COSMOS galaxy shapes (Leauthaud et al. 2007${cosmosMeta.sourceUrl ? `, <a href="${cosmosMeta.sourceUrl}" target="_blank" rel="noopener">IRSA</a>` : ''}), ${cosmosMeta.nGalaxies.toLocaleString()} galaxies. Our 3D rebuild, not the published map.`
        : '<b class="sim">Simulated</b>Built from the in-browser simulation, not observations. Style after Massey et al. 2007 (<a href="https://science.nasa.gov/mission/hubble/science/science-highlights/mapping-the-cosmic-web/" target="_blank" rel="noopener">NASA</a>).',
    // While flying to the peak the orbit target moves, so don't publish mid-flight.
    cameraShared: () => !flight,
    getView: (): CosmicView => ({
      tab: 'box',
      cam: getCam(base),
      s8: ctx.params.s8,
      om: ctx.params.om,
      source: src,
      level: src === 'cosmos' ? +sigInput().value : +fracInput().value,
    }),
    async applyView(v) {
      if (v.tab !== 'box') return;
      (v.source === 'cosmos' ? sigInput() : fracInput()).value = String(v.level);
      if (v.source !== src) await setSource(v.source);
      else drawClumps();
    },
  };
}
