# Penumbra

**Mapping the Dark Universe** (Cal Hacks 2026). We take public weak-lensing dark-matter maps (DES Y3), read cosmological parameters (Ωm, S8) off them with simulation-based inference, compare the result to Planck, and wrap it all in a 3D fly-through viewer.

The viewer puts three datasets on one shared sky:

- **Planck CMB**: early-universe light, drawn as the outermost sphere.
- **DES Y3 mass maps**: four partial shells, one per tomographic redshift bin. Each shell is mass projected toward more distant galaxies. The shells overlap; they are not slices of space.
- **COSMOS**: a small, deep Hubble field (RA 150°, Dec +2°), outside the DES footprint. It holds a galaxy point cloud and our rebuild of the Massey et al. 2007 3D mass map.

## Repo layout

| Path | What it is |
|---|---|
| `index.html`, `src/cosmic/` | **The app's frontend**: the cosmic web simulator (live Zel'dovich simulation, Massey-style 3D clump map, survey layers as line-of-sight slices) with SpacetimeDB rooms, presenter/follow and flags |
| `layers.html`, `src/layers/`, `src/viewer/` | The sky-sphere layer viewer, also backed by SpacetimeDB (its own default room) |
| `guide.html`, `src/tour/` | The Tour page: lensing demo, 7 tour stops, the 2026 cosmology status board and the team's progress. Edit progress in `src/tour/team_status.json` |
| `src/collab/`, `spacetimedb/` | SpacetimeDB client and server module (shared by both pages) |
| `viewer/index.html`, `viewer/cosmic-web.html` | The original standalone viewer pages from the viewer branch: no build step, no multiplayer, three from a CDN. Kept as reference |
| `data/` | Exported viewer layers: PNGs, float16 grids, and `manifest.json`. See `data/README_for_frontend.md` |
| `get_dark_matter_data.sh` | Downloads the raw survey data into `dark_universe_data/` |
| `dark_universe_data/` | Raw data (~2.4 GB). **Git-ignored**, so each teammate fetches it with the script |
| `CLAUDE.md`, `HANDOFF.md` | Project context and build plan for Claude Code |
| `project-handoff-summary.md` | Planning summary for the whole project |
| `dark-matter-maps.skill` | Claude skill for the analysis pipeline |

## Getting the data

```bash
bash get_dark_matter_data.sh
```

This fetches the DES Y3 KaRMMa maps and the COSMOS catalog (~0.3 GB). Add `--planck` to also get the Planck SMICA CMB map (~1.9 GB):

```bash
bash get_dark_matter_data.sh --planck
```

The script skips files you already have and resumes partial downloads. Set `OUT=/some/path` to save somewhere else.

What you end up with:

| File | Contents |
|---|---|
| `des_y3/karmma/desy3_karmma_maps/map_0..99.npy` | 100 DES Y3 mass-map samples, each (4 bins × 78,091 in-mask pixels) |
| `des_y3/karmma/desy3_karmma_maps/mask.fits` | HEALPix Nside 256 mask (equatorial) |
| `cosmos/cosmos_wl_source_catalog.csv` | 261,123 COSMOS galaxies with shapes (γ1, γ2) and photo-z |
| `planck/COM_CMB_IQU-smica_2048_R3.00_full.fits` | Planck 2018 SMICA CMB map, Nside 2048, **galactic** coords (rotate to equatorial before use) |

## Running the app

```bash
npm install && (cd spacetimedb && npm install)
npm run stdb:start      # terminal 1: local SpacetimeDB
npm run stdb:publish    # once: publish the module as database "penumbra"
npm run dev             # terminal 2: http://localhost:5173
```

- `/` is the cosmic web app. `/layers.html` is the layer viewer. `/guide.html` is the tour.
- Without SpacetimeDB both pages still work locally; the room panel shows "Offline".
- Open two tabs on the same `?room=` to try multiplayer: one tab clicks **Share my view**, the other **Follow presenter**.
- The two pages use different shared-view encodings, so they never share a room: the cosmic web joins `penumbra-demo`, the layer viewer `penumbra-demo-layers`.
- The standalone pages in `viewer/` still work with `python3 -m http.server 8000` from the repo root (open `/viewer/`).

### How the cosmic web page uses the backend

The SpacetimeDB module is unchanged. The cosmic web view is carried in the existing `update_view` fields (see `src/cosmic/viewCodec.ts`): `active_layer` is the tab (plus the universe number on Simulate), `view_ra`/`view_dec` are S8/Ωm (Simulate, 3D map) or the sky patch centre (Survey slices), `spread` is time, clump volume or slice spacing, and `view_yaw`/`view_pitch`/`view_zoom` are the orbit camera. Panning and the Survey slices Zoom slider are not shared. Flags are sky-anchored `(ra, dec, bin)`, so they are placed on the Survey slices tab.

## Data sources

- DES Y3 KaRMMa maps: [zenodo.org/records/10668943](https://zenodo.org/records/10668943)
- COSMOS weak-lensing catalog (Leauthaud et al. 2007): IRSA `cosmoswlsc`, DOI 10.26131/IRSA163
- Planck 2018 SMICA map: [IRSA Planck archive](https://irsa.ipac.caltech.edu/data/Planck/release_3/all-sky-maps/maps/component-maps/cmb/)

Key papers: Jeffrey et al. 2021 (DES Y3 mass maps, arXiv:2105.13539), Massey et al. 2007 (COSMOS 3D map, astro-ph/0701480), Planck 2018 VIII (lensing, arXiv:1807.06210).

## Live backend (SpacetimeDB)

Only small room state lives in SpacetimeDB: rooms, presence, the presenter's shared view,
and sky-anchored annotations. Map PNGs / raw grids stay in `data/` and are never stored in the database.
Local mode needs no account or API key.

```sh
# one-time: install the CLI  (https://spacetimedb.com/install)
npm install && (cd spacetimedb && npm install)

npm run stdb:start      # terminal 1: local server on ws://localhost:3000
npm run stdb:publish    # build + publish module as database "penumbra"
npm run stdb:generate   # regenerate typed client bindings into src/generated/
npm run test:backend    # integration tests against the running server (two independent clients)
```

Reset the local database: `spacetime publish --server local --module-path spacetimedb penumbra --delete-data --yes`.

### Data model (`spacetimedb/src/index.ts`)

| Table | Key | Purpose |
|---|---|---|
| `room_state` | `room_id` | map `manifest_version`, presenter identity, presenter's shared camera (`view_ra/dec/zoom/yaw/pitch`), `active_layer`, `spread` |
| `presence` | `identity` | one row per connected participant: name, colour, their own view centre + active layer, heartbeat |
| `annotation` | `id` | sky-anchored flag: `(ra, dec, bin)`, text, author, `manifest_version` |

Canonical coordinates are celestial `(ra, dec, bin)`; clients convert to/from plane coordinates.

### Reducers

`join_room`, `leave_room`, `heartbeat`, `set_profile`, `update_view`, `claim_presenter`,
`release_presenter`, `add_annotation`, `delete_annotation`.

- Rooms are created on first join and bound to the joiner's `manifest_version`; joining with a different
  version is rejected, so flags can't attach to an incompatible map.
- `update_view` always updates the caller's presence; it only updates the shared room view for the presenter.
  Clients should throttle it (~5–8 Hz presenter, ~1–2 Hz others).
- Only the author can delete an annotation. Limits: 280 chars/comment, 50 flags/user, 500/room.
- Disconnect removes presence and releases the presenter role. Rooms with no participants and no
  annotations are deleted automatically.
- Identity is an anonymous token. The planned client keeps it per browser tab (`sessionStorage`).

Remote publishing later: `spacetime login` (browser OAuth), then publish with `--server maincloud`.
