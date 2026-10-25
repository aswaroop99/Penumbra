# Adding the spaceship to a 3D view

This guide is for Claude (or anyone) adding the drivable spaceship camera to a new 3D visualization. The code is in [`ship.ts`](ship.ts). It knows nothing about the data. Two working examples:

| View | File | Kind of space |
|---|---|---|
| 3D map (COSMOS rebuild + simulated box) | [`boxView.ts`](boxView.ts), section `// ---------- spaceship ----------` | Bounded box, launch from Earth, fog, per-position readout from a grid |
| Simulate (Zel'dovich particles) | [`simView.ts`](simView.ts), search `createShipRig` | Periodic box, no walls, no dust, shader points re-centred on the camera |

Read both before starting. Copy the 3D map pattern for gridded volumes and the Simulate pattern for particle clouds or periodic boxes.

## What the rig gives you

`createShipRig(options)` returns a `ShipRig`. While it is active, it owns the camera and adds:
- The ship model: a slim metallic craft with twin blue engines. It uses matcap shading, so it needs no scene lights and ignores fog.
- A chase camera (default) or a cockpit camera with a reticle (**C** switches).
- Free 6-DOF flight using a quaternion: loops, flying inverted, and roll.
- Controls:
  - Keys: ↑/W thrust, ↓/S brake or reverse, ←→/A D turn, R/F climb or dive, Q/E roll, Shift boost, +/− cruise speed, Esc leave.
  - Mouse/touch: drag to steer (like a joystick), scroll for cruise speed.
- The flight HUD at the bottom: your `describe()` readout, a cruise/speed bar, a camera button and a leave button.
- The orientation globe in the bottom-right corner, with your `compass` labels plus heading and climb angle.
- Optional drifting dust as a speed cue, and optional fog.
- Saving and restoring state: on `enter()` it stores the camera pose, `camera.near`, `scene.fog` and `controls.enabled`, and `exit()` puts them back.
- `document.body.dataset.ship = 'on'` while flying. The CSS uses it to hide `#caption`, and the panel on phones.

Every rig adds its own HUD and globe to `<body>`. Several rigs on one page are fine, as long as only one is active at a time. The `onHide` hook below makes sure of that.

## Step by step (inside the cosmic app)

### 1. Create the rig once, in the view factory

```ts
import { createShipRig, type ShipWorld } from './ship';

let orbitCam = getCam(base);               // orbit pose to publish while flying
const ship = createShipRig({
  scene: base.scene,
  camera: base.camera,
  controls: base.controls,                 // disabled while flying, restored after
  dom: ctx.renderer.domElement,            // pointer + wheel input
  onInput: () => ctx.interacted(),         // stops "follow presenter"
  onEnter: () => { /* show/hide view-specific things */ syncShipButton(); },
  onExit:  () => { /* undo them */ syncShipButton(); },
});
```

`onExit` runs exactly once per flight, whichever way it ends (Esc, the HUD button, your own `exit()`, or a tab switch). Put all clean-up there, not in your button handler.

### 2. Describe the space as a `ShipWorld`

```ts
function shipWorld(): ShipWorld {
  return {
    start: new THREE.Vector3(...),   // where the ship appears
    yaw: 0, pitch: 0,                // initial heading: yaw 0 = toward +X, positive = left
    size: 0.12,                      // ship length, world units
    speed: 0.7,                      // top speed without boost (×2.2 with Shift)
    bounds: new THREE.Box3(...),     // omit for open or periodic space
    fog: new THREE.FogExp2(bgColor, density), // omit for none
    dust: true,                      // false if the view already has moving particles
    describe: (pos) => '<b>Headline</b>Detail line…', // HTML, called every frame
    compass: [{ dir: [-1, 0, 0], label: 'Earth', color: '#7ee0a3' }, ...],
  };
}
```

Make it a function, not a constant, when the world depends on state (for example, the 3D map's bounds depend on the selected source).

### 3. Add a button and wire enter/exit

```html
<!-- index.html, inside the view's data-mode panel section -->
<div class="row"><button class="btn primary wide" id="shipMyView">🚀 Fly a spaceship</button></div>
```

```ts
const shipButton = () => $<HTMLButtonElement>('shipMyView');
const syncShipButton = () => (shipButton().textContent = ship.active ? 'Leave the spaceship' : '🚀 Fly a spaceship');
shipButton().onclick = () => {
  if (ship.active) return ship.exit();
  if (!dataReady) return;              // don't launch into an empty scene
  orbitCam = getCam(base);
  ship.enter(shipWorld());
};
syncShipButton();
```

### 4. Hook into the view's lifecycle (the `View` returned to `CosmicApp`)

```ts
return {
  ...base,
  tick(now) {
    ship.tick(now);                    // FIRST, so anything that follows the camera sees its new pose
    // ...the rest of the view's per-frame work
  },
  onHide: () => ship.exit(),           // CosmicApp calls this on tab switch
  orbitEnabled: () => !ship.active,    // CosmicApp asks this when the tab opens
  cameraShared: () => !ship.active,    // don't broadcast the ship camera to the room
  getView: () => ({ ..., cam: ship.active ? orbitCam : getCam(base) }),
};
```

`onHide` and `orbitEnabled` are optional members of `View` in [`viewKit.ts`](viewKit.ts). [`CosmicApp.show()`](CosmicApp.ts) calls them. Always call `ship.tick(now)`, even when inactive: it keeps its frame clock current, so the first frame after `enter()` doesn't jump.

### 5. If the data can change while flying

Call `ship.setWorld(shipWorld())` after the change. The ship stays where it is, clamped into the new bounds. Example: `setSource` in `boxView.ts` swaps COSMOS ↔ simulation mid-flight. Disable anything else that moves the camera while the ship is active (e.g. `flyToPeak` returns early, and the Simulate tab's autopilot calls `ship.exit()` before starting).

## Coordinates and tuning

- **Ship axes:** nose +X, up +Y, right wing +Z. A view with a "natural forward" (like distance from Earth) should put it along world +X and start with `yaw: 0`, or set `yaw`/`pitch` to point the nose where you want.
- **Globe:** world +Y is "up" (the blue half). Put the most meaningful vertical axis (declination/north, say) on +Y, or label it with `compass` so the user isn't misled.
- **Starting values** (scale them to your world's longest axis, L):

| | 3D map (L = 10) | Simulate (L = 160) | Rule of thumb |
|---|---|---|---|
| `size` | 0.12 | 2.4 | ≈ 1–1.5 % of L |
| `speed` | 0.7 | 22 | full thrust crosses L in ~10–15 s |
| fog density (`FogExp2`) | 0.13 | none | ≈ 1.3 / L, background colour |
| bounds margin | 0.5 around the box, 1.6 behind for Earth | none | leave room for the chase camera |

- The rig sets `camera.near = size × 0.04` while flying. Make sure `camera.far` covers the whole world.
- The chase camera sits about 4.4 ship lengths behind and 1.35 above. Keep scenery (like the 3D map's Earth) out of that spot at the start pose, or the first frame is from inside it.

## Gotchas

- **Fog only affects built-in materials.** A custom `ShaderMaterial` (like the Simulate particles) ignores `scene.fog`. Fade by camera distance in the shader instead. The Simulate view sets `uFade = 1` on enter and copies `camera.position` into `uCenter` every frame after `ship.tick`.
- **Flying inside surfaces.** Use `side: THREE.DoubleSide` on isosurfaces (as `MarchingCubes` does here), or they vanish from the inside.
- **CSS2D labels ignore parent visibility.** Toggle each `CSS2DObject.visible` yourself (see `earthLabel` in `boxView.ts`).
- **Text fields keep their keys.** The rig ignores keystrokes in text inputs, textareas, selects and contenteditable. Range sliders and checkboxes don't count, so flying works after touching a slider. On `enter()` it also blurs the focused element.
- **Readout honesty.** `describe()` text is UI copy and must follow the honest-claims rules in [`/CLAUDE.md`](../../CLAUDE.md):
  - Say "low confidence, may be noise" for the COSMOS haze.
  - Label simulated data as simulated.
  - Note that distances are not to scale where they aren't.
  - Never imply COSMOS is inside the DES footprint.
- **Sampling a grid for the readout.** `sample()` in `boxView.ts` turns a world position into the grid cell that `MarchingCubes` drew (field index `i` ↔ world `−HW + WORLD·i/RES`, centred on Y/Z). Copy it if your volume goes through the same `fill()` path.

## Outside the cosmic app

`ship.ts` depends only on `three` and the `OrbitControls` type. Any page with a `Scene`, `PerspectiveCamera` and render loop can use it:
- Call `ship.tick(performance.now())` every frame before rendering.
- If the page has its own controls, pass them as `controls`, or disable them yourself in `onEnter`/`onExit`. Otherwise they'll fight the ship for the camera.
- The HUD styles live in [`cosmic.css`](cosmic.css) under `/* ---- spaceship */` (`.ship-hud`, `.ship-reticle`, `.ship-nav`). Copy them, along with the `--panel`, `--line`, `--muted` and `--text` variables and the `button.btn` styles, into the other page's CSS.
- The standalone pages in `viewer/` have no bundler, so they'd need an import map for `three` and `three/addons/` before they can import `ship.ts`. Prefer porting into the Vite app.

## Checklist and testing

1. `npx tsc --noEmit && npm test && npm run build`.
2. The flight model is a pure function: `stepFlight(state, input, dt, world)`. Unit tests are in [`ship.test.ts`](ship.test.ts). Add a test there if you change the physics.
3. In the browser (`npm run dev`), open the view and check:
   - The ship launches facing the right way.
   - The readout text matches the position.
   - Globe labels sit where they should: e.g. "Deeper" at the centre at launch on the 3D map.
   - You can't leave the bounds.
   - Esc, the leave button and switching tabs all restore the earlier orbit view.
   - The room view isn't broadcast while flying.
4. The keys respond to `KeyboardEvent.code`, so a script can drive the ship from the browser console or a test:
   ```js
   const k = (t, code) => window.dispatchEvent(new KeyboardEvent(t, { code }));
   k('keydown', 'ArrowUp'); setTimeout(() => k('keyup', 'ArrowUp'), 2000);
   ```
   `document.querySelectorAll('.ship-nav')` returns one globe per rig. Filter to the one without `hidden`.
