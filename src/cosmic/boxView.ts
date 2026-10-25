import * as THREE from 'three';
import { MarchingCubes } from 'three/addons/objects/MarchingCubes.js';
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
import type { CosmicView } from './viewCodec';

/** View 2: Massey et al. (2007)-style clumps in a long light-cone box (simulated, not observed). */
export function createBoxView(ctx: Ctx): View {
  const base = makeBase(ctx, 0x0a0f33, 40, 0.1, 200);
  const dims: Vec3 = [128, 32, 32];
  const L: Vec3 = [512, 128, 128];
  const [nx, ny, nz] = dims;
  const N = nx * ny * nz;
  const cell = L[0] / nx; // 4 Mpc/h
  const Z_NEAR = 0.25;
  const Z_FAR = 0.95;
  const RES = 128;
  const OFF = (RES - ny) / 2;
  const WORLD = 10; // world length of the long axis
  let noise: KField | null = null;
  let delta: Float32Array | null = null;

  base.scene.add(new THREE.AmbientLight(0x6a7bd0, 0.9));
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(3, 6, 5);
  base.scene.add(key);
  const rim = new THREE.DirectionalLight(0x7fb2ff, 1.0);
  rim.position.set(-6, -2, -4);
  base.scene.add(rim);

  const material = new THREE.MeshPhongMaterial({
    color: 0x4d86ff,
    emissive: 0x0b1f6a,
    specular: 0xbcd4ff,
    shininess: 60,
    transparent: true,
    opacity: 0.82,
    side: THREE.DoubleSide,
    depthWrite: true,
  });
  const mc = new MarchingCubes(RES, material, false, false, 400000);
  mc.scale.setScalar(WORLD / 2);
  base.scene.add(mc);

  const hw = WORLD / 2;
  const hh = (WORLD * ny) / RES / 2;
  base.scene.add(
    new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(WORLD, 2 * hh, 2 * hh)),
      new THREE.LineBasicMaterial({ color: 0xc8d4ff, transparent: true, opacity: 0.55 })
    )
  );

  // Distance axis along the bottom-front edge
  for (const t of [0, 1 / 3, 2 / 3, 1]) {
    const z = Z_NEAR + (Z_FAR - Z_NEAR) * t;
    const l = label(
      `${lookbackGyr(z, 0.315).toFixed(1)} billion years ago<small>z = ${z.toFixed(2)}</small>`
    );
    l.position.set(-hw + WORLD * t, -hh - 0.45, hh);
    base.scene.add(l);
  }
  const ax = label(
    '<span class="axis">nearer · more recent  ←  distance from Earth  →  farther · earlier</span>'
  );
  ax.position.set(0, -hh - 1.15, hh);
  base.scene.add(ax);
  const ra = label('<span class="axis">right ascension</span>');
  ra.position.set(-hw - 0.2, -hh, 0);
  base.scene.add(ra);
  const dec = label('<span class="axis">declination</span>');
  dec.position.set(-hw - 0.2, 0, hh + 0.2);
  base.scene.add(dec);

  base.camera.position.set(-4.2, 5, 12.5);
  if (innerWidth < innerHeight) base.camera.position.multiplyScalar(1.8); // fit the long box on portrait screens
  base.controls.target.set(0, -0.3, 0);
  base.controls.autoRotateSpeed = 0.25;
  base.controls.minDistance = 3;
  base.controls.maxDistance = 30;

  const frac = () => +$<HTMLInputElement>('frac').value;

  function drawClumps() {
    if (!delta) return;
    const sorted = Float32Array.from(delta).sort();
    const thr = Math.max(0.05, sorted[Math.floor((1 - frac()) * (N - 1))]);
    mc.reset();
    const f = mc.field;
    for (let z = 0; z < nz; z++)
      for (let y = 0; y < ny; y++)
        for (let x = 2; x < nx - 2; x++) {
          f[x + RES * (y + OFF) + RES * RES * (z + OFF)] = delta[x + nx * (y + ny * z)];
        }
    mc.isolation = thr;
    mc.update();
  }

  const rebuild = serial(async () => {
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
    for (let x = 0; x < nx; x++) {
      Dx[x] = growth(Z_NEAR + ((Z_FAR - Z_NEAR) * (x + 0.5)) / nx, ctx.params.om);
    }
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
    delta = Float32Array.from(rho);
    drawClumps();
    ctx.busy(false);
  });

  const syncFrac = () => {
    $('fracval').textContent = `${Math.round(frac() * 100)}%`;
  };
  $<HTMLInputElement>('frac').oninput = () => {
    syncFrac();
    drawClumps();
  };
  syncFrac();

  return {
    ...base,
    rebuild,
    caption:
      'Styled after the Hubble COSMOS 3D dark-matter map (Massey et al. 2007), but built from the simulation above, not from telescope data. The box runs from about 3 to 8 billion years ago. Distances are not to scale: the real survey volume is a long, narrow cone.',
    tick: () => {},
    onShow: () => {},
    hud: () => [
      'Dark matter in 3D',
      `Clumpier toward the near side: structure has had longer to grow · S8 = ${ctx.params.s8.toFixed(2)}`,
    ],
    source: () =>
      '<b class="sim">Simulated</b>Built from the in-browser simulation, not observations. Style after Massey et al. 2007 (<a href="https://science.nasa.gov/mission/hubble/science/science-highlights/mapping-the-cosmic-web/" target="_blank" rel="noopener">NASA</a>).',
    cameraShared: () => true,
    getView: (): CosmicView => ({
      tab: 'box',
      cam: getCam(base),
      s8: ctx.params.s8,
      om: ctx.params.om,
      volume: frac(),
    }),
    applyView(v) {
      if (v.tab !== 'box') return;
      $<HTMLInputElement>('frac').value = String(v.volume);
      syncFrac();
      drawClumps();
    },
  };
}
