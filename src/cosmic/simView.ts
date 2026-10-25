import * as THREE from 'three';
import {
  ageGyr,
  displacementField,
  growth,
  H,
  linearSigmaR,
  lookbackGyr,
  seedAmplitude,
  seedDisplacement,
  sigma8From,
  whiteNoiseK,
  mulberry32,
  type KField,
  type Seed,
  type Vec3,
} from './physics';
import { createShipRig } from './ship';
import { $, getCam, label, makeBase, nextFrame, serial, type Ctx, type View } from './viewKit';
import { UNIVERSE_SEEDS, type CosmicView } from './viewCodec';

const PLAY_LABEL = '▶ Play from the early universe';

/** View 1: particles moved by the Zel'dovich approximation, rendered live. */
export function createSimView(ctx: Ctx): View {
  const base = makeBase(ctx, 0x04030b, 55, 0.5, 4000);
  const canvas = ctx.renderer.domElement;
  const NG = 64;
  const L = 160;
  const dims: Vec3 = [NG, NG, NG];
  const N = NG ** 3;
  const cell = L / NG;
  const ZMAX = 30;
  const RS = 3.0;

  let universe = 0;
  let noise: KField | null = null;
  let zs = 1;
  let playing = false;
  let fly = false;
  const state = { z: 0, D: 1 };
  /** Planted seeds: ν (peak height in σ) and R are kept; the amplitude is set per cosmology at rebuild. */
  const seeds: { x: number; y: number; z: number; nu: number; R: number; marker: THREE.Object3D }[] = [];
  let basePsi: [Float32Array, Float32Array, Float32Array] | null = null;

  const q = new Float32Array(N * 3);
  const psiAttr = new Float32Array(N * 3);
  const dens = new Float32Array(N);
  const cellOf = new Uint32Array(N);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(q, 3));
  geo.setAttribute('psi', new THREE.BufferAttribute(psiAttr, 3));
  geo.setAttribute('dens', new THREE.BufferAttribute(dens, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uD: { value: 1 },
      uL: { value: L },
      uCenter: { value: new THREE.Vector3() },
      uSize: { value: 1.3 },
      uPR: { value: ctx.renderer.getPixelRatio() },
      uGlow: { value: 1 },
      uFade: { value: 0 },
    },
    vertexShader: `
      uniform float uD, uL, uSize, uPR, uFade; uniform vec3 uCenter;
      attribute vec3 psi; attribute float dens;
      varying float vDens; varying float vFade;
      void main() {
        vec3 p = position + uD * psi;
        p = mod(p - uCenter + 0.5 * uL, uL) - 0.5 * uL + uCenter;   // periodic box
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        float s = uSize * (1.0 + 0.45 * log(1.0 + dens));
        gl_PointSize = clamp(s * uPR * 300.0 / -mv.z, 0.0, 40.0);
        vDens = dens;
        vFade = mix(1.0, 1.0 - smoothstep(0.25 * uL, 0.5 * uL, -mv.z), uFade);
      }`,
    fragmentShader: `
      uniform float uGlow, uD; varying float vDens; varying float vFade;
      void main() {
        vec2 c = gl_PointCoord - 0.5; float d2 = dot(c, c);
        if (d2 > 0.25) discard;
        float ld = log(1.0 + vDens);
        float web = smoothstep(0.6, 1.6, ld);     // sheets and filaments (~top half of particles)
        float knot = smoothstep(1.9, 2.7, ld);    // densest knots, ~top 5% (galaxies)
        vec3 col = mix(vec3(0.45, 0.22, 1.0), vec3(1.0, 0.95, 0.9), knot);
        // Early on everything is near-average density; show it as a faint, even haze.
        float base = 0.025 + 0.16 * (1.0 - uD) * (1.0 - uD);
        float a = (base + 0.17 * web + 0.6 * knot) * exp(-d2 * 14.0) * uGlow * vFade;
        gl_FragColor = vec4(col, a);   // additive blending multiplies by alpha once
      }`,
  });
  base.scene.add(new THREE.Points(geo, mat));

  const boxLines = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(L, L, L)),
    new THREE.LineBasicMaterial({ color: 0x6f7cc9, transparent: true, opacity: 0.25 })
  );
  base.scene.add(boxLines);
  const scaleBar = label(
    `<span class="axis">← ${(L / H) | 0} million parsecs (≈ ${(((L / H) * 3.26) / 1000).toFixed(1)} billion light-years) →</span>`
  );
  scaleBar.position.set(0, -L / 2 - 8, L / 2);
  base.scene.add(scaleBar);

  const HOME = new THREE.Vector3(150, 110, 230);
  base.camera.position.copy(HOME);
  base.controls.autoRotateSpeed = 0.35;

  function placeParticles() {
    const rnd = mulberry32(UNIVERSE_SEEDS[universe] * 31 + 1);
    let p = 0;
    for (let z = 0; z < NG; z++)
      for (let y = 0; y < NG; y++)
        for (let x = 0; x < NG; x++, p++) {
          // small jitter hides the starting lattice
          q[3 * p] = (x + 0.5 + (rnd() - 0.5) * 0.9) * cell - L / 2;
          q[3 * p + 1] = (y + 0.5 + (rnd() - 0.5) * 0.9) * cell - L / 2;
          q[3 * p + 2] = (z + 0.5 + (rnd() - 0.5) * 0.9) * cell - L / 2;
        }
    geo.attributes.position.needsUpdate = true;
  }

  // Density for colouring, counted on a coarser grid (2 sim cells wide) so it's less noisy.
  const NC = NG / 2;
  const CC = L / NC;
  const PER = N / NC ** 3;
  function updateDensity() {
    const D = state.D;
    const counts = new Float32Array(NC ** 3);
    for (let p = 0; p < N; p++) {
      let idx = 0;
      let mul = 1;
      for (let a = 0; a < 3; a++) {
        let v = (q[3 * p + a] + D * psiAttr[3 * p + a] + L / 2) % L;
        if (v < 0) v += L;
        idx += Math.min(NC - 1, (v / CC) | 0) * mul;
        mul *= NC;
      }
      cellOf[p] = idx;
      counts[idx]++;
    }
    for (let p = 0; p < N; p++) dens[p] = counts[cellOf[p]] / PER;
    geo.attributes.dens.needsUpdate = true;
  }

  function setZ(s: number) {
    zs = s;
    state.z = Math.pow(1 + ZMAX, 1 - s) - 1;
    state.D = growth(state.z, ctx.params.om);
    mat.uniforms.uD.value = state.D;
    $<HTMLInputElement>('zslider').value = String(s);
    $('zval').textContent = state.z < 10 ? state.z.toFixed(2) : state.z.toFixed(1);
    updateDensity();
  }

  const setPlaying = (on: boolean) => {
    playing = on;
    $('play').textContent = on ? '❚❚ Pause' : PLAY_LABEL;
  };

  /** Ψ seen by the particles: the universe's own field plus any planted seeds. */
  function fillPsi() {
    if (!noise || !basePsi) return;
    const LL: Vec3 = [L, L, L];
    const params = { om: ctx.params.om, sigma8: sigma8From(ctx.params.s8, ctx.params.om) };
    const sigR = new Map<number, number>();
    const planted: Seed[] = seeds.map((s) => {
      if (!sigR.has(s.R)) sigR.set(s.R, linearSigmaR(noise!, dims, LL, params, s.R));
      return { x: s.x, y: s.y, z: s.z, R: s.R, A: seedAmplitude(s.nu, sigR.get(s.R)!) };
    });
    const extra = planted.length ? seedDisplacement(planted, dims, LL, RS) : null;
    for (let p = 0; p < N; p++) {
      const x = Math.min(NG - 1, Math.floor((q[3 * p] + L / 2) / cell));
      const y = Math.min(NG - 1, Math.floor((q[3 * p + 1] + L / 2) / cell));
      const z = Math.min(NG - 1, Math.floor((q[3 * p + 2] + L / 2) / cell));
      const i = x + NG * (y + NG * z);
      for (let a = 0; a < 3; a++) psiAttr[3 * p + a] = basePsi[a][i] + (extra ? extra[a][i] : 0);
    }
    geo.attributes.psi.needsUpdate = true;
  }

  /** `seedsOnly` skips the universe's own field (unchanged) and only redoes the seeds. */
  const rebuild = serial(async (newNoise = false, seedsOnly = false) => {
    ctx.busy(true);
    await nextFrame();
    if (newNoise || !noise) {
      noise = whiteNoiseK(dims, UNIVERSE_SEEDS[universe]);
      placeParticles();
    }
    if (!seedsOnly || !basePsi) {
      basePsi = displacementField(noise, dims, [L, L, L], {
        om: ctx.params.om,
        sigma8: sigma8From(ctx.params.s8, ctx.params.om),
        Rs: RS,
      });
    }
    fillPsi();
    setZ(zs);
    ctx.busy(false);
  });

  // ------------------------------------------------------------ seeds
  const markerGeo = new THREE.SphereGeometry(1, 16, 12);
  const ringGeo = new THREE.RingGeometry(0.92, 1, 48);
  function makeMarker(peak: boolean, R: number): THREE.Object3D {
    const color = peak ? 0xffa64d : 0x5aa8ff;
    const g = new THREE.Group();
    const core = new THREE.Mesh(
      markerGeo,
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false })
    );
    core.scale.setScalar(1.4);
    const halo = new THREE.Mesh(
      markerGeo,
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.12,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
    );
    halo.scale.setScalar(R);
    // A ring at the seed radius that always faces the camera.
    const ring = new THREE.Mesh(
      ringGeo,
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide })
    );
    ring.scale.setScalar(R);
    ring.onBeforeRender = (_r, _s, cam) => ring.quaternion.copy(cam.quaternion);
    g.add(halo, core, ring);
    return g;
  }
  const seedLayer = new THREE.Group();
  base.scene.add(seedLayer);

  let planting = false;
  const syncCursor = () => {
    canvas.style.cursor = planting && base.controls.enabled ? 'crosshair' : '';
  };
  const syncSeedCount = () => {
    const n = seeds.length;
    $('clearSeeds').textContent = n ? `Clear seeds (${n})` : 'Clear seeds';
  };

  function plantAt(clientX: number, clientY: number) {
    const r = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - r.left) / r.width) * 2 - 1,
      -((clientY - r.top) / r.height) * 2 + 1
    );
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, base.camera);
    // A plane through the box centre, facing the camera.
    const normal = base.camera.getWorldDirection(new THREE.Vector3());
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, new THREE.Vector3());
    const hit = ray.ray.intersectPlane(plane, new THREE.Vector3());
    if (!hit) return;
    hit.clampScalar(-L / 2, L / 2);
    const peak = $<HTMLInputElement>('seedPeak').checked;
    const nu = Math.max(-4, Math.min(4, (peak ? 1 : -1) * +$<HTMLInputElement>('seedNu').value));
    const R = +$<HTMLInputElement>('seedR').value;
    const marker = makeMarker(peak, R);
    marker.position.copy(hit);
    seedLayer.add(marker);
    seeds.push({ x: hit.x, y: hit.y, z: hit.z, nu, R, marker });
    syncSeedCount();
    // Back to the early universe, so Play shows the seed growing.
    setPlaying(false);
    zs = 0;
    void rebuild(false, true);
  }

  let down: { x: number; y: number } | null = null;
  canvas.addEventListener('pointerdown', (e) => {
    down = { x: e.clientX, y: e.clientY };
  });
  canvas.addEventListener('pointerup', (e) => {
    const start = down;
    down = null;
    // controls.enabled is true only while this tab is showing and not flying.
    if (!start || !planting || !base.controls.enabled || e.button !== 0) return;
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 4) return;
    plantAt(e.clientX, e.clientY);
  });

  $<HTMLInputElement>('plant').onchange = (e) => {
    planting = (e.target as HTMLInputElement).checked;
    syncCursor();
  };
  const syncSeedVals = () => {
    $('seedNuVal').textContent = (+$<HTMLInputElement>('seedNu').value).toFixed(1);
    $('seedRVal').textContent = String(+$<HTMLInputElement>('seedR').value);
  };
  $<HTMLInputElement>('seedNu').oninput = syncSeedVals;
  $<HTMLInputElement>('seedR').oninput = syncSeedVals;
  syncSeedVals();
  $('clearSeeds').onclick = () => {
    if (!seeds.length) return;
    for (const s of seeds) seedLayer.remove(s.marker);
    seeds.length = 0;
    syncSeedCount();
    void rebuild(false, true);
  };

  const syncUniverseLabel = () => {
    $('reseed').textContent = `Next universe (${universe + 1}/${UNIVERSE_SEEDS.length})`;
  };
  syncUniverseLabel();

  $<HTMLInputElement>('zslider').oninput = (e) => {
    setPlaying(false);
    setZ(+(e.target as HTMLInputElement).value);
  };
  $('play').onclick = () => {
    setPlaying(!playing);
    if (playing && zs >= 0.999) setZ(0);
  };
  $<HTMLInputElement>('glow').oninput = (e) => {
    mat.uniforms.uGlow.value = +(e.target as HTMLInputElement).value;
  };
  $('reseed').onclick = () => {
    universe = (universe + 1) % UNIVERSE_SEEDS.length;
    syncUniverseLabel();
    void rebuild(true);
  };

  const flyDir = new THREE.Vector3(1, 0.37, 0.21).normalize();
  const flyBox = () => $<HTMLInputElement>('fly');
  function setFly(on: boolean) {
    fly = on;
    flyBox().checked = on;
    base.controls.enabled = !fly;
    boxLines.visible = scaleBar.visible = seedLayer.visible = !fly;
    syncCursor();
    mat.uniforms.uFade.value = fly ? 1 : 0;
    if (fly) {
      base.camera.position.set(0, 0, 0);
    } else {
      base.camera.position.copy(HOME);
      base.controls.target.set(0, 0, 0);
      base.camera.lookAt(0, 0, 0);
      mat.uniforms.uCenter.value.set(0, 0, 0);
    }
  }
  flyBox().onchange = (e) => {
    ship.exit();
    setFly((e.target as HTMLInputElement).checked);
  };

  // Spaceship: the box is periodic, so there are no walls and the web repeats forever.
  let orbitCam = getCam(base);
  const shipButton = () => $<HTMLButtonElement>('shipSim');
  const syncShipButton = () => (shipButton().textContent = ship.active ? 'Leave the spaceship' : '🚀 Fly a spaceship');
  const ship = createShipRig({
    scene: base.scene,
    camera: base.camera,
    controls: base.controls,
    dom: ctx.renderer.domElement,
    onInput: () => ctx.interacted(),
    onEnter: () => {
      boxLines.visible = scaleBar.visible = seedLayer.visible = false;
      mat.uniforms.uFade.value = 1;
      syncShipButton();
    },
    onExit: () => {
      boxLines.visible = scaleBar.visible = seedLayer.visible = true;
      mat.uniforms.uFade.value = 0;
      mat.uniforms.uCenter.value.set(0, 0, 0);
      syncShipButton();
    },
  });
  shipButton().onclick = () => {
    if (ship.active) return ship.exit();
    if (fly) setFly(false);
    orbitCam = getCam(base);
    ship.enter({
      start: new THREE.Vector3(-L / 2, 0, 0),
      size: 2.4,
      speed: 22,
      dust: false,
      compass: [
        { dir: [1, 0, 0], label: '+x' },
        { dir: [-1, 0, 0], label: '−x' },
        { dir: [0, 1, 0], label: '+y' },
        { dir: [0, -1, 0], label: '−y' },
        { dir: [0, 0, 1], label: '+z' },
        { dir: [0, 0, -1], label: '−z' },
      ],
      describe: () =>
        `<b>Simulated universe</b>A periodic box ${(L / H) | 0} million parsecs wide: fly out one side and you come back in the other. ` +
        'Every point in the box is shown at the same cosmic time (use the redshift slider).',
    });
  };
  syncShipButton();

  let last = performance.now();
  return {
    ...base,
    rebuild,
    caption:
      'A small simulation, built live in your browser. It starts from tiny random ripples in an almost smooth early universe, and gravity draws matter into sheets, filaments and knots. Purple shows dark matter; white shows the densest knots, where galaxies form. Plant your own seeds (extra early ripples, or voids) and watch them grow; seeded spots are made up, not real places on the sky. Method: Zel’dovich approximation (first-order perturbation theory), not a full N-body run; very strong seeds overshoot at late times.',
    onShow: () => syncCursor(),
    onHide: () => ship.exit(),
    orbitEnabled: () => !fly && !ship.active,
    tick(now) {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (playing) {
        const s = Math.min(1, zs + dt / 14);
        setZ(s);
        if (s >= 1) setPlaying(false);
      }
      ship.tick(now);
      if (ship.active) mat.uniforms.uCenter.value.copy(base.camera.position);
      if (fly) {
        base.camera.position.addScaledVector(flyDir, 14 * dt);
        base.camera.lookAt(base.camera.position.clone().add(flyDir));
        mat.uniforms.uCenter.value.copy(base.camera.position);
      }
    },
    hud() {
      const lb = lookbackGyr(state.z, ctx.params.om);
      const age = ageGyr(state.z, ctx.params.om);
      return [
        state.z < 0.005 ? 'Today' : `${lb.toFixed(1)} billion years ago`,
        `redshift z = ${state.z.toFixed(2)} · universe ${age.toFixed(1)} Gyr old · clumping ${(state.D * 100).toFixed(0)}% of today`,
      ];
    },
    source: () =>
      '<b class="sim">Simulated</b>Generated in your browser from random initial conditions. No telescope data. Defaults: Planck 2018 (Ω<sub>m</sub>) and DES Y3 (S8).',
    cameraShared: () => !fly && !ship.active,
    getView: (): CosmicView => ({
      tab: 'sim',
      cam: ship.active ? orbitCam : getCam(base),
      s8: ctx.params.s8,
      om: ctx.params.om,
      time: zs,
      universe,
    }),
    applyView(v) {
      if (v.tab !== 'sim') return;
      setPlaying(false);
      if (v.universe !== universe) {
        universe = v.universe;
        syncUniverseLabel();
        void rebuild(true);
      }
      setZ(v.time);
    },
  };
}
