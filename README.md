# Penumbra

**Mapping the Dark Universe** (Cal Hacks 2026). We take public weak-lensing dark-matter maps (DES Y3), read cosmological parameters (Ωm, S8) off them with simulation-based inference, compare the result to Planck, and wrap it all in a 3D fly-through viewer.

The viewer puts three datasets on one shared sky:

- **Planck CMB**: early-universe light, drawn as the outermost sphere.
- **DES Y3 mass maps**: four partial shells, one per tomographic redshift bin. Each shell is mass projected toward more distant galaxies. The shells overlap; they are not slices of space.
- **COSMOS**: a small, deep Hubble field (RA 150°, Dec +2°), outside the DES footprint. It holds a galaxy point cloud and our rebuild of the Massey et al. 2007 3D mass map.

## Repo layout

| Path | What it is |
|---|---|
| `index.html`, `src/cosmic/` | **The app's frontend**: the cosmic web page. *Simulate* is a live Zel'dovich toy universe; *3D map* is our rebuild of the Hubble COSMOS 3D mass map (with the simulated Massey-style box as a toggle); *Survey slices* shows the DES layers along the line of sight. SpacetimeDB rooms, presenter/follow and flags |
| `layers.html`, `src/layers/`, `src/viewer/` | The sky-sphere layer viewer with the AI map-reading panel, also backed by SpacetimeDB (its own default room) |
| `guide.html`, `src/tour/` | The Tour page: lensing demo, 7 tour stops, the 2026 cosmology status board and the team's progress. Edit progress in `src/tour/team_status.json` |
| `src/collab/`, `spacetimedb/` | SpacetimeDB client and server module (shared by both pages) |
| `viewer/index.html`, `viewer/cosmic-web.html` | The original standalone pages (no build step, no multiplayer, three from a CDN). Kept as reference; `viewer/des-volume.html` is an experimental DES depth-inversion viewer |
| `data/` | Viewer data, **built by `build_data.sh`** (not committed): the real DES Y3 layers (PNGs, float16 grids, `manifest.json`) and the COSMOS 3D grids in `data/cosmos/`. The stored `reader.json` / `inference.json` are committed. See `data/README_for_frontend.md` |
| `build_data.sh` | Downloads the raw data and builds everything in `data/` |
| `prep/` | Data prep: `export_des.py` (alternative DES layer export), `cosmos_3d.py` (COSMOS 3D rebuild), `deproject_des.py` / `des_volume.py` (DES depth-inversion experiments) |
| `des_map/` | DES science pipeline and the vision-language map reader (`run-reader`, `run-vlm-demo`). See `des_map/MAP_READER.md` |
| `inference/` | Offline SBI pipeline (Ωm, S8 from a map). Run once per dataset; the stored result is reused. See `inference/README.md` |
| `environment.yml`, `penumbra-osx-arm64.lock`, `requirements.txt` | Python environments; see [Python environments](#python-environments) |
| `get_dark_matter_data.sh` | Downloads the raw survey data into `dark_universe_data/` |
| `dark_universe_data/` | Raw data (~2.4 GB). **Git-ignored**, so each teammate fetches it with the script |
| `CLAUDE.md`, `HANDOFF.md` | Project context and build plan for Claude Code |
| `project-handoff-summary.md` | Planning summary for the whole project |
| `dark-matter-maps.skill` | Claude skill for the analysis pipeline |
| `des_map/` | Python science pipeline: map contracts, summary statistics, SBI/MCMC, and the Claude vision map reader (`des_map/MAP_READER.md`) |
| `run-reader`, `run-vlm-demo` | Launchers for the map reader (load the ignored `.env`) |

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
bash build_data.sh      # once: build data/ (see "Building the viewer data")
npm install && (cd spacetimedb && npm install)
npm run stdb:start      # terminal 1: local SpacetimeDB
npm run stdb:publish    # once: publish the module as database "penumbra"
npm run dev             # terminal 2: http://localhost:5173
```

- `/` is the cosmic web app. `/layers.html` is the layer viewer. `/guide.html` is the tour.
- Without SpacetimeDB both pages still work locally; the room panel shows "Offline".
- Open two tabs on the same `?room=` to try multiplayer: one tab clicks **Share my view**, the other **Follow presenter**.
- The two pages use different shared-view encodings, so they never share a room: the cosmic web joins `penumbra-demo`, the layer viewer `penumbra-demo-layers`.
- The standalone pages in `viewer/` still work with `python3 serve.py` from the repo root (open http://localhost:8000/viewer/).

### Cosmology result (Ωm, S8)

The cosmic web page shows a "Cosmology from this map" card when `data/manifest.json` points at a matching
`data/inference.json`: S8, Ωm and σ8 with 68% intervals, a bar comparison with DES Y3 and Planck, and the held-out
trust check. The numbers are computed offline once and stored as JSON; inference never runs in the browser and
nothing is stored in SpacetimeDB. If the file is absent or does not match the map, the card is hidden.

```bash
cd inference && python run_inference.py ...   # first run trains; later runs load data/inference.json
```

**The shipped result is from the toy universe**, not real data: the card says "Toy data" and the Planck offset it
would imply is not a scientific result. Details and the real-data cutover: `inference/README.md`.

### How the cosmic web page uses the backend

The SpacetimeDB module is unchanged. The cosmic web view is carried in the existing `update_view` fields (see `src/cosmic/viewCodec.ts`): `active_layer` is the tab (plus the universe number on Simulate), `view_ra`/`view_dec` are S8/Ωm (Simulate, 3D map) or the sky patch centre (Survey slices), `spread` is time, clump volume or slice spacing, and `view_yaw`/`view_pitch`/`view_zoom` are the orbit camera. Panning and the Survey slices Zoom slider are not shared. Flags are sky-anchored `(ra, dec, bin)`, so they are placed on the Survey slices tab.

## Python environments

All Python in the repo (`prep/`, `inference/`, `des_map/` and the map reader) runs in **one** environment: the conda env `penumbra`, all from conda-forge.

```bash
conda env create -f environment.yml
```

On Apple Silicon you can skip the solver with the pre-solved lock:

```bash
conda create -n penumbra --file penumbra-osx-arm64.lock
```

Run scripts through `bin/penumbra-python` (or `conda activate penumbra` and use `python`). The launchers `run-reader` and `run-vlm-demo` already use it:

```bash
bin/penumbra-python prep/cosmos_3d.py
```

`bin/penumbra-python` uses the first of: `$PENUMBRA_PYTHON`, the active `penumbra` conda env, the `penumbra` env even when not activated, then a repo venv (`.venv-map-reader/`, `.venv/`, `venv/`). It clears `PYTHONPATH`, `PYTHONHOME` and `~/.local` site-packages first. Run `bin/penumbra-python --which` to see which one it picked.

Rules that avoid conda/venv clashes:

- Don't `pip install` into the conda env. A pip `torch` next to conda's OpenMP is what aborts SBI training on macOS.
- Don't create a venv while a conda env is active (the venv would be built on conda's Python). Run `conda deactivate` first.
- No conda? Use one venv with the pip superset, and the launcher finds it:

  ```bash
  python3.11 -m venv .venv && .venv/bin/pip install -r requirements.txt
  ```

- Narrower pinned sets: `inference/requirements.txt` (SBI lane, same versions as the conda env) and `des_map/requirements-reader.txt` (reader only).
- After editing `environment.yml`: `conda env update -n penumbra -f environment.yml --prune`, then regenerate the lock with `conda list -n penumbra --explicit --md5` (keep the header lines).

## Building the viewer data

The viewer data in `data/` is **not committed**. Build it once after cloning (and again after changing a prep script). It downloads the raw surveys (~0.3 GB) into `dark_universe_data/` if they're missing, then writes the DES layers, `manifest.json` and the COSMOS 3D grids into `data/` (about 30 s). It needs the Python environment from [Python environments](#python-environments):

```bash
bash build_data.sh
```

`--skip-download` builds from the raw files already on disk. `--with-volume` also builds the experimental DES depth volume for `viewer/des-volume.html`.

Only three files in `data/` are committed: `README_for_frontend.md`, and the small stored results `inference.json` (SBI; rebuild with `inference/`) and `reader.json` (AI map reading; needs an API key, see [Vision-language map reader](#vision-language-map-reader)). After the DES layers change, run the reader again so its pins line up with the map.

What the prep scripts do:

- **`export_des.py`** averages the 100 KaRMMa samples per bin, smooths the result (20′ by default) inside the survey mask, and writes plate-carrée PNGs, float16 grids and `manifest.json` (bounds and the top 40 peaks per bin). In the manifest, `snr` is peak height in units of the map's spread, and `post_snr` is peak height over the spread across the 100 samples. `post_snr` is the better measure of how certain a peak is (the top peaks are about 2–4σ).
- **`cosmos_3d.py`** splits galaxies into 7 photo-z slices and makes a Kaiser–Squires mass map per slice. It picks the shear sign convention from the data with an E/B-mode test, then runs a tomographic matched filter per sky pixel to find lenses in depth. Values in the grid are detection significance (σ), and each detected lens is drawn at its most likely redshift. Check: the strongest structure is at RA 149.93°, Dec 2.51°, z ≈ 0.7 (4.2σ), matching the known COSMOS cluster at z ≈ 0.73. Depth resolution is poor, so treat redshifts as approximate. `METHOD=wiener` gives a regularised density estimate instead, but it pulls structures toward low redshift.

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

## Vision-language map reader

The Python map reader combines numerical convergence-map features for SBI with
optional pretrained Claude or OpenAI vision-model interpretation. Start with
[des_map/MAP_READER.md](des_map/MAP_READER.md) for setup, the local toy demo,
DES ingestion, API configuration, and validation limits.

The viewer assets in `data/` follow their existing manifest. Scientific map
analysis uses HEALPix map contracts; viewer PNGs do not replace those inputs.

## Local quick start

The `run-reader` launcher loads the ignored `.env` file and runs the reader with
`bin/penumbra-python` (see [Python environments](#python-environments)). Keep your API key in `.env` (see `.env.example`).

```bash
./run-reader demo --out reader_runs/toy
./run-reader analyze --map reader_runs/toy/obs.npz --config reader_runs/toy/config.json --out reader_runs/toy/vlm-anthropic --provider anthropic --model claude-sonnet-5-5
```

Open `des_map/reader_runs/toy/vlm-anthropic/report.md` for the result. The demo uses toy
maps and does not measure DES cosmological parameters. The second command sends
the rendered map and evidence to Anthropic; repeated identical requests use a local cache.

For hackathon Claude credits, set these values in your ignored `.env` locally:

```dotenv
VLM_PROVIDER=anthropic
VLM_MODEL=claude-sonnet-5-5
ANTHROPIC_API_KEY=your-key-here
```

Then run `./run-vlm-demo`. Use a model enabled for your hackathon account if
Sonnet 5.5 is unavailable. This integration uses the direct Anthropic API;
gateway, Bedrock, or Vertex credentials require their respective authentication.
Do not paste keys into chat or commit `.env`. OpenAI remains available with
`VLM_PROVIDER=openai` and `VLM_MODEL=gpt-4.1-mini`.
