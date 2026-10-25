# Penumbra: Mapping the Dark Universe (Cal Hacks 2026)

Read this before doing anything. It covers the project goal, how the repo fits together, how to set it up, and what's still open.

## Goal
A browser app that shows dark matter from public weak-lensing data, plus the science behind it:
1. **DES Y3 mass maps** (convergence κ): 4 tomographic bins, shown as sky layers and line-of-sight slices.
2. **COSMOS (Hubble)**: our rebuild of the Massey et al. 2007 3D dark-matter map from the Leauthaud+2007 shear catalog.
3. **Fake universe**: a live in-browser Zel'dovich simulation (the "Simulate" tab) and a simulated Massey-style box.
4. **Explainer**: a static tour page (`guide.html`).
5. **VLM map reader**: Claude describes the DES map's shape from rendered images plus measured extrema.
6. **SBI**: Ωm / S8 inferred from a map (offline), shown as a card when the result matches the displayed map.
7. **SpacetimeDB rooms**: presence, presenter/follow, and sky-anchored flags.

## Repo layout
| Path | What it is |
|---|---|
| `index.html`, `src/cosmic/` | Main app: tabs **Simulate** (`simView.ts`), **3D map** (`boxView.ts`: COSMOS by default, simulation as a toggle), **Survey slices** (`sliceView.ts`). SpacetimeDB rooms |
| `layers.html`, `src/layers/`, `src/viewer/` | Sky-sphere layer viewer with the AI map-reading panel (`readerPanel.ts`). Own SpacetimeDB room |
| `guide.html`, `src/tour/` | Static tour. Team progress lives in `src/tour/team_status.json` |
| `src/lib/` | Validated loaders with tests: `manifest.ts`, `cosmos3d.ts`, `reader.ts`, `inference.ts`, `sky.ts` |
| `src/collab/`, `spacetimedb/`, `src/generated/` | SpacetimeDB client, server module, generated bindings |
| `prep/` | Data prep: `export_des.py` (DES layers), `cosmos_3d.py` (COSMOS 3D grid), `deproject_des.py` / `des_volume.py` (depth-inversion experiments) |
| `des_map/` | DES science pipeline + VLM map reader (`map_reader/`). Docs: `des_map/MAP_READER.md` |
| `inference/` | Offline SBI pipeline → `data/inference.json`. Docs: `inference/README.md` |
| `viewer/` | Original standalone pages (no build, no multiplayer). Reference only; `viewer/des-volume.html` is the depth-volume prototype |
| `build_data.sh` | Downloads raw data and builds everything in `data/` |
| `bin/penumbra-python` | Picks the Python interpreter for every script and launcher |
| `environment.yml`, `penumbra-osx-arm64.lock`, `requirements.txt` | Python environments (see below) |

## Setup (after cloning)
```bash
conda env create -f environment.yml          # or on Apple Silicon: conda create -n penumbra --file penumbra-osx-arm64.lock
bash build_data.sh                           # downloads ~0.3 GB raw data if missing, builds data/ (~30 s)
npm install && (cd spacetimedb && npm install)
npm run dev                                  # http://localhost:5173  (/, /layers.html, /guide.html)
```
For multiplayer, run `npm run stdb:start`, then `npm run stdb:publish` (needs the `spacetime` CLI). Without it the pages still work and show "Offline".

## Python environments
- **One env for everything:** the conda env `penumbra` (all conda-forge, no pip section) runs prep, SBI (torch, sbi, emcee) and the reader (anthropic, openai, jsonschema). Python 3.11. Its versions match the pins in `inference/requirements.txt`.
- **Always run Python through `bin/penumbra-python`** (or `conda activate penumbra`). It picks, in order: `$PENUMBRA_PYTHON`, the active `penumbra` env, the `penumbra` env even when not activated, then repo venvs `.venv-map-reader/`, `.venv/`, `venv/`. It clears `PYTHONPATH`, `PYTHONHOME` and user site-packages. `bin/penumbra-python --which` shows the choice. `run-reader` / `run-vlm-demo` use it.
- **Don't** `pip install` into the conda env: a pip torch next to conda's OpenMP aborts training on macOS. **Don't** create a venv while a conda env is active.
- `anthropic<2` is pinned everywhere: the reader is tested against the 1.x SDK (the auth header changed in 2.x).
- Fallbacks: `requirements.txt` (pip superset for one venv), `inference/requirements.txt` (pinned SBI set), `des_map/requirements-reader.txt` (reader only).
- After editing `environment.yml`: `conda env update -n penumbra -f environment.yml --prune`, then regenerate the lock with `conda list -n penumbra --explicit --md5` (keep the header lines).

## Data
- **`data/` is generated, not committed** (`.gitignore` has `/data/*`). `bash build_data.sh` runs `get_dark_matter_data.sh` → `prep/export_des.py` → `prep/cosmos_3d.py`. Flags: `--skip-download`, `--with-volume` (DES depth volume for `viewer/des-volume.html`).
- **Committed in `data/`:** only `README_for_frontend.md` (the data contract), and the small stored results `inference.json` (needs torch to recreate) and `reader.json` (needs an API key).
- The build is reproducible: in the conda env it gave byte-identical output to the earlier committed files.
- DES layers come from `prep/export_des.py` (20′ smoothing, 40 peaks/bin, adds `post_snr`). Arnav's earlier 10′ export came from the `des_map/` pipeline and couldn't be reproduced from a script. `export_des.py` adds the manifest's `"inference"` pointer when `data/inference.json` exists.
- COSMOS grid: `data/cosmos/cosmos_3d.{json,f32.bin}` + `cosmos_3d_faint.f32.bin` (haze). Index = `depth + nd*(x + nx*y)`, shape `[ny, nx, nd]`. Values are lens-detection σ. Sanity check: the strongest peak is at RA 149.93, Dec 2.51, z ≈ 0.7 (the known z ≈ 0.73 cluster).
- The Vite plugin serves `/manifest.json` and `/data/**` in dev, and the build emits `data/` plus `data/cosmos/` (`DATA_SUBDIRS` in `vite.config.ts`).

### Raw data (`dark_universe_data/`, git-ignored, fetched by `get_dark_matter_data.sh`)
- `des_y3/karmma/desy3_karmma_maps/`: `map_0..99.npy` = 100 posterior samples, each (4, 78091) float64 (4 bins × in-mask pixels). `mask.fits`: HEALPix nside 256, equatorial. Full map: `hp_map = zeros((4, 12*256**2)); hp_map[:, mask] = sample`.
- `cosmos/cosmos_wl_source_catalog.csv`: 261,123 galaxies (Leauthaud+2007): `ra, dec, zphot, gamma1, gamma2, weight, ...`. RA ≈ 150°, Dec ≈ +2.2°, ~1.4° wide.
- `planck/` (`--planck`, ~1.9 GB): SMICA CMB, **galactic** coords → rotate with `hp.Rotator(coord=['G','C'])`. No page uses it right now.

## SpacetimeDB shared view (cosmic web page)
The module is unchanged; views ride in the existing `update_view` fields (`src/cosmic/viewCodec.ts`):

| field | sim | box (3D map) | slices |
|---|---|---|---|
| `activeLayer` | 0 + 3·universe | 1 + 3·source (0 = COSMOS, 1 = sim) | 2 |
| `ra` / `dec` | S8 / Ωm | S8 / Ωm | patch centre |
| `spread` | time | σ threshold (COSMOS) or clump volume (sim) | slice spacing |

The camera (yaw/pitch/zoom) is shared relative to each view's orbit target. Haze settings and panning are not shared. The server's `MAX_LAYERS` = 16 limits `activeLayer`. The cosmic page joins `penumbra-demo`, the layer viewer `penumbra-demo-layers`.

## Key facts that shape the design
- **COSMOS is NOT inside the DES footprint** (DES ≈ RA −60°..100°, Dec −65°..+5°). Never imply COSMOS is part of the DES map.
- Tomographic bins are **mass projected toward sources at that depth**, overlapping, not slices of space. Say "looking deeper", not "3D map". Only COSMOS has real (poor) depth resolution; clumps stretch along the distance axis.
- The COSMOS haze (~1σ up to the clump threshold) is mostly shape noise. Label it low-confidence, never "filaments".
- Shared sky frame: x = r·cosδ·cosα, y = r·cosδ·sinα, z = r·sinδ; distances log-compressed for display (label it).

## Honest-claims rules (UI text)
- "Projected mass map with layers that look progressively deeper", not "3D map of dark matter" (except COSMOS).
- Call the COSMOS map "our rebuild of the COSMOS 3D map", not the original.
- The maps come from lensing measurements; AI doesn't "find" dark matter. Claude's text is an "AI description of the map's shape", never a measurement, and never feeds S8/Ωm.
- Label toy data as toy (the stored `reader.json` and `inference.json` are both toy right now).
- The CMB is early-universe light, not dark matter (unless using the Planck lensing map).

## Testing
```bash
npm test && npx tsc --noEmit && npm run build
bin/penumbra-python -m pytest des_map/tests -q
(cd inference && ../bin/penumbra-python -m pytest tests -q)    # test_pipeline_smoke.py trains a real flow (~30 s)
npm run test:backend                                           # needs a running SpacetimeDB
```
Tests that read generated data (`manifest.test.ts`, `cosmos3d.test.ts`) skip when `data/` hasn't been built. The inference tests use a fixture manifest.

## Status (as of 25 Oct 2026)
Branch `integrate` (PR into `main`) merged `arnav_VLM_DES`, `merge-viewer-frontend`, `des-deproject` (without the Planck mock, which was removed) and `sbi`. `spacetimedb-start` was left out because later work replaced it. Verified: unit tests, type-check, build, reader tests, SBI smoke training, and all three pages in the browser.

Open items:
- **VLM on real DES:** not run. It needs `ANTHROPIC_API_KEY` in `.env` and survey-matched fiducial simulations to `freeze` a config (see `des_map/MAP_READER.md`). Until then `reader.json` is the toy run and the viewer warns that it doesn't match the map.
- **SBI card hidden:** `data/inference.json` is from the toy universe, so it doesn't match the real manifest. Rerun `inference/` on the real map.
- **SpacetimeDB not tested live** after the merge (no `spacetime` CLI on the test machine).
- **Git history still contains old data files** from earlier branches. Removing them needs a history rewrite and force-push.
- `inference/` and `des_map/pipeline/` hold diverged copies of the same science scripts; deduplicate.
- The `sky` chunk in the build is ~700 kB; it could be code-split.

## Key references
Jeffrey+2021 DES Y3 mass maps (arXiv:2105.13539); KaRMMa DES Y3 maps (zenodo.org/records/10668943; Fiedorowicz+2024); Massey+2007 COSMOS 3D map (astro-ph/0701480); Leauthaud+2007 COSMOS WL catalog (IRSA DOI 10.26131/IRSA163); Planck 2018 lensing (arXiv:1807.06210).
