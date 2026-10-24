# Mapping the Dark Universe — 3D viewer (Cal Hacks 2026)

Context carried over from a claude.ai planning chat. Read this before doing anything.

## Goal of this folder
Build a browser 3D viewer that overlays three datasets on one shared sky:
1. **Planck CMB** (early universe) — outermost backdrop sphere.
2. **DES Y3 dark-matter (convergence, κ) maps** — 4 partial shells, one per tomographic redshift bin.
3. **COSMOS weak-lensing catalog** — a thin cone of galaxies plus a rebuilt 3D "clump" mass map (the famous Massey et al. 2007 Hubble 3D dark-matter map, re-derived by us).

Broader project (other lanes): SBI inference of Ωm/S8 from DES maps, Planck comparison, Galaxy Zoo DESI mergers-vs-density, LLM explainer. This folder is the viewer lane.

## Data already downloaded (in dark_universe_data)
- `des_y3/karmma/desy3_karmma_maps/`
  - `map_0.npy` … `map_99.npy`: 100 posterior samples, each shape (4, 78091) float64 = 4 tomographic bins × in-mask pixels. κ range ≈ −0.016..+0.032, std ≈ 0.004.
  - `mask.fits`: HEALPix **nside 256** boolean mask (RING assumed; check header). Full map: `hp_map = zeros((4, 12*256**2)); hp_map[:, mask] = sample`.
  - `get_hp_map.py`: reference reconstruction script. Ignore the `__MACOSX` folder (Mac metadata junk).
  - Equatorial coordinates (DES). Verify COORDSYS in header.
- `cosmos/cosmos_wl_source_catalog.csv`: 261,123 galaxies (Leauthaud+2007). Columns: `ra, dec, zphot, zp2, photoz_low, gamma1, gamma2, weight, x, y, z, ...`. RA≈150°, Dec≈+2.2°, ~1.4° wide.
- `planck/`: run `bash get_dark_matter_data.sh --planck` (in this folder) to fetch `COM_CMB_IQU-smica_2048_R3.00_full.fits` (~1.9 GB, from IRSA). Planck maps are **galactic** coords → rotate with `hp.Rotator(coord=['G','C'])`. Optional: Planck 2018 lensing map `COM_Lensing_4096_R3.00` (from pla.esac.esa.int) ships as alm (`dat_klm.fits`) → `hp.alm2map`.

## Key facts that shape the design
- **COSMOS is NOT inside the DES footprint** (DES ≈ RA −60°..100°, Dec −65°..+5°). Planck covers all sky. So: CMB sphere around everything, DES patch on one part of sky, COSMOS cone elsewhere with a "Go to COSMOS" camera preset. Never imply COSMOS is part of the DES map.
- Shared frame: observer at origin; direction = (RA, Dec) equatorial; radius = comoving distance from redshift, **log-compressed for display** (DES ~1–2.5 Gpc vs CMB ~14 Gpc). Label it compressed.
  - x = r·cosδ·cosα, y = r·cosδ·sinα, z = r·sinδ — one shared function in Python and JS.
- DES shell radii: place each bin at its approximate lensing-sensitivity peak, z ≈ 0.2, 0.3, 0.4, 0.5 (approximate; state as such).
- Tomographic bins are **mass projected toward sources at that depth**, overlapping — not slices of space. Say "looking deeper", not "3D map".
- Only the COSMOS cone has real depth resolution.

## Build plan
### Step 1 — Python prep (`prep/`), outputs to `viewer/public/data/`
- DES: mean and std over the 100 samples per bin → smooth ~10–20′ → plate-carrée RGBA PNG per bin (masked = transparent) + float16 grids + `manifest.json` (bounds, value ranges, top-N peaks with RA/Dec).
- Planck: ud_grade to nside 256, rotate G→C, write 2048×1024 equirectangular PNG.
- COSMOS:
  1. split by `zphot` into ~5 slices (e.g. edges 0.3, 0.5, 0.7, 0.9, 1.1, 1.5);
  2. per slice, weighted γ1, γ2 onto a ~0.5′ flat grid, FFT Kaiser–Squires:
     `kap = ifft2(((k1²−k2²)·fft2(g1) + 2·k1·k2·fft2(g2)) / (k1²+k2²)).real`;
  3. smooth ~1′; difference consecutive slices to isolate mass within each slice;
  4. write a small 3D float32 grid + galaxy positions (float32 xyz).
  - Sanity check: the known COSMOS cluster at z≈0.73 should be a peak; if it's a hole, flip a γ sign.
  - Call it "our rebuild of the COSMOS 3D map", not the original.
- Deps: `healpy numpy scipy astropy pillow pandas`.

### Step 2 — viewer (`viewer/`): Vite + three.js
- CMB: large sphere, texture on the inside (BackSide).
- DES: SphereGeometry partial patches (phi/theta ranges from manifest) per bin, semi-transparent; κ colormap; per-shell opacity slider; mean/uncertainty toggle.
- COSMOS: THREE.Points for galaxies; clumps as volume render or marching-cubes isosurfaces (three/examples).
- Controls: layer toggles, scroll = fly outward through shells, "Go to COSMOS" preset, hover RA/Dec/κ readout, peak labels.

## Honest-claims rules (use in UI text)
- "Projected mass map with redshift layers that look progressively deeper", not "3D map of dark matter" (except the COSMOS cone).
- The map comes from DES lensing measurements; AI doesn't "find" dark matter.
- CMB layer is early-universe light, not dark matter (unless using the Planck lensing map).

## Key references
Jeffrey+2021 DES Y3 mass maps (arXiv:2105.13539); KaRMMa DES Y3 maps (zenodo.org/records/10668943); Massey+2007 COSMOS 3D map (astro-ph/0701480); Leauthaud+2007 COSMOS WL catalog (IRSA DOI 10.26131/IRSA163); Planck 2018 lensing (arXiv:1807.06210).
