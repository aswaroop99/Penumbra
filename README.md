# Penumbra

**Mapping the Dark Universe** (Cal Hacks 2026). We take public weak-lensing dark-matter maps (DES Y3), read cosmological parameters (Ωm, S8) off them with simulation-based inference, compare the result to Planck, and wrap it all in a 3D fly-through viewer.

The viewer puts three datasets on one shared sky:

- **Planck CMB**: early-universe light, drawn as the outermost sphere.
- **DES Y3 mass maps**: four partial shells, one per tomographic redshift bin. Each shell is mass projected toward more distant galaxies. The shells overlap; they are not slices of space.
- **COSMOS**: a small, deep Hubble field (RA 150°, Dec +2°), outside the DES footprint. It holds a galaxy point cloud and our rebuild of the Massey et al. 2007 3D mass map.

## Repo layout

| Path | What it is |
|---|---|
| `viewer/index.html` | three.js fly-through viewer (no build step; loads three from a CDN) |
| `viewer/cosmic-web.html` | Cosmic web simulator in the style of NASA's Hubble cosmic-web page: a live Zel'dovich simulation, a Massey-style 3D clump map, and the survey layers as line-of-sight slices. Each view shows where its data comes from |
| `data/` | Exported viewer data: the real DES Y3 layers (PNGs, float16 grids, `manifest.json`) and the COSMOS 3D grid in `data/cosmos/`. See `data/README_for_frontend.md` |
| `prep/export_des.py` | Builds the DES layers in `data/` from the 100 KaRMMa map samples |
| `prep/cosmos_3d.py` | Rebuilds a 3D mass map of the COSMOS field from the galaxy-shape catalog into `data/cosmos/` |
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

## Rebuilding the viewer data

`data/` is committed, so you only need this after changing the prep scripts or the raw data. Set up a Python environment once (Python 3.12):

```bash
python3.12 -m venv .venv && .venv/bin/pip install numpy scipy healpy astropy pillow pandas matplotlib
```

Then run the two prep scripts:

```bash
.venv/bin/python prep/export_des.py
```

```bash
.venv/bin/python prep/cosmos_3d.py
```

What they do:

- **`export_des.py`** averages the 100 KaRMMa samples per bin, smooths the result (20′ by default) inside the survey mask, and writes plate-carrée PNGs, float16 grids and `manifest.json` (bounds and the top 40 peaks per bin). In the manifest, `snr` is peak height in units of the map's spread, and `post_snr` is peak height over the spread across the 100 samples. `post_snr` is the better measure of how certain a peak is (the top peaks are about 2–4σ).
- **`cosmos_3d.py`** splits galaxies into 7 photo-z slices and makes a Kaiser–Squires mass map per slice. It picks the shear sign convention from the data with an E/B-mode test, then runs a tomographic matched filter per sky pixel to find lenses in depth. Values in the grid are detection significance (σ), and each detected lens is drawn at its most likely redshift. Check: the strongest structure is at RA 149.93°, Dec 2.51°, z ≈ 0.7 (4.2σ), matching the known COSMOS cluster at z ≈ 0.73. Depth resolution is poor, so treat redshifts as approximate. `METHOD=wiener` gives a regularised density estimate instead, but it pulls structures toward low redshift.

## Running the viewer

Serve the repo root (the viewer loads `../data/`), then open the viewer page:

```bash
python3 -m http.server 8000
```

Open http://localhost:8000/viewer/ for the layer viewer, or http://localhost:8000/viewer/cosmic-web.html for the cosmic web simulator.

## Data sources

- DES Y3 KaRMMa maps: [zenodo.org/records/10668943](https://zenodo.org/records/10668943)
- COSMOS weak-lensing catalog (Leauthaud et al. 2007): IRSA `cosmoswlsc`, DOI 10.26131/IRSA163
- Planck 2018 SMICA map: [IRSA Planck archive](https://irsa.ipac.caltech.edu/data/Planck/release_3/all-sky-maps/maps/component-maps/cmb/)

Key papers: Jeffrey et al. 2021 (DES Y3 mass maps, arXiv:2105.13539), Massey et al. 2007 (COSMOS 3D map, astro-ph/0701480), Planck 2018 VIII (lensing, arXiv:1807.06210).
