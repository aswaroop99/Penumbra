# Handoff: Dark Universe 3D Viewer (Cal Hacks 2026)

*Summary of a claude.ai planning chat (Oct 24, 2026). Paste this into Claude Code, or keep it in the project folder next to `CLAUDE.md`.*

---

## 1. Project in one paragraph

"Mapping the Dark Universe" is a 3-person, 3-day, laptop-scale hackathon project. It takes public weak-lensing dark-matter maps (DES Y3), reads cosmological parameters (Ωm, S8) off them with simulation-based inference, compares the result to Planck, cross-checks against Galaxy Zoo DESI merger fractions, and wraps it all in an explorable fly-through viewer with an AI explainer. **This handoff is for the viewer lane:** a browser 3D scene that overlays the CMB, the DES dark-matter maps, and the famous COSMOS 3D dark-matter "clump" map on one shared sky.

## 2. What data exists, and in what form

### Early universe: the CMB (Planck)
Planck publishes, from rawest to most processed:
- time-ordered detector data
- maps for each frequency band
- foreground component maps (dust, synchrotron, etc.)
- clean CMB maps from 4 pipelines (COMMANDER, NILC, SEVEM, SMICA); HEALPix FITS, temperature at Nside 2048
- lensing products
- power spectra, likelihoods, and parameter tables

For dark matter, the relevant Planck product is the **CMB lensing map** (`COM_Lensing_4096_R3.00`): an all-sky projection of mass out to z ~ 2. It ships as spherical-harmonic coefficients (`dat_klm.fits`), not pixels; convert with `healpy.alm2map`. Planck maps are in **galactic** coordinates.

### Late universe: dark-matter density (weak lensing)
- **Raw-ish:** galaxy shape catalogs (ellipticity γ1, γ2, weight, photo-z per galaxy). DES Y3 has about 100M galaxies (hundreds of GB; avoid). COSMOS has 261k (small; we have it).
- **Processed:** convergence (κ) maps in HEALPix. DES Y3 has 4 tomographic redshift bins plus a combined map.
- **The famous 3D "clump" model** is the Hubble COSMOS 3D dark-matter map (Massey et al. 2007): HST images → galaxy shapes (Leauthaud et al. 2007 catalog) → split by photo-z → a mass map per slice → stacked into 3D.

## 3. What's downloaded (in the repo at `dark_universe_data/`, git-ignored)

| Path | Contents | Status |
|---|---|---|
| `des_y3/karmma/desy3_karmma_maps/map_0..99.npy` | 100 KaRMMa DES Y3 mass-map samples, each (4, 78091) float64: 4 tomographic bins × in-mask pixels. κ ≈ −0.016 to +0.032, std ≈ 0.004 | ✅ verified |
| `des_y3/karmma/desy3_karmma_maps/mask.fits` | HEALPix **Nside 256** mask (equatorial). Rebuild: `m = zeros((4, 12*256**2)); m[:, mask] = sample` | ✅ |
| `des_y3/karmma/desy3_karmma_maps/get_hp_map.py` | reference reconstruction script | ✅ |
| `des_y3/karmma/__MACOSX/` | Mac metadata junk (220-byte `._*` files); ignore | — |
| `cosmos/cosmos_wl_source_catalog.csv` | 261,123 galaxies. Columns: `ra, dec, zphot, zp2, photoz_low, gamma1, gamma2, weight, x, y, z, spt_ind, htm20, cntr` | ✅ verified |
| `planck/` | empty. Run `bash get_dark_matter_data.sh --planck` for `COM_CMB_IQU-smica_2048_R3.00_full.fits` (~1.9 GB) | ⏳ not fetched |

**Download script:** `get_dark_matter_data.sh`. It skips existing files and resumes partial ones.
**Sources:**
- KaRMMa maps: zenodo.org/records/10668943 (md5 `55fbef2740c1f41f594334ab14cb0f14`)
- COSMOS catalog: IRSA `cosmoswlsc`, DOI 10.26131/IRSA163
- SMICA map: irsa.ipac.caltech.edu/data/Planck/release_3/all-sky-maps/maps/component-maps/cmb/
- Planck lensing map: pla.esac.esa.int (Maps → Lensing)

**Not yet obtained:**
- Official DES Y3 Kaiser–Squires maps (Nside 1024). They're on des.ncsa.illinois.edu/releases/y3a2 and couldn't be reached from the chat sandbox.
- Galaxy Zoo DESI (zenodo.org/records/8360385).
- CosmoGridV1 sims (cosmogrid.ai, via Globus).

## 4. Design decisions for the viewer

1. **One shared frame.** The observer is at the origin. Direction = (RA, Dec) in equatorial coordinates. Radius = comoving distance from redshift.
   - Log-compress the radius for display (DES ~1–2.5 Gpc vs CMB ~14 Gpc), and label it as compressed.
   - Use one shared conversion in both Python and JS: `x = r·cosδ·cosα, y = r·cosδ·sinα, z = r·sinδ`.
2. **COSMOS is NOT in the DES footprint.** COSMOS is at RA 150°, Dec +2°; DES covers roughly RA −60° to 100°, Dec −65° to +5°. Planck is all-sky.
   - So the layout is: the CMB sphere surrounds everything, the DES patch covers one region of sky, and the COSMOS cone sits elsewhere.
   - Add a "Go to COSMOS" camera preset; at full-sky scale the cone is tiny.
3. **Layers**

   | Layer | Shape in 3D | Distance |
   |---|---|---|
   | CMB (SMICA; Planck lensing κ as an alternate texture) | sphere, texture on the inside | outermost |
   | DES (mean of the 100 KaRMMa samples; std as an uncertainty toggle) | 4 semi-transparent partial shells | ~z 0.2, 0.3, 0.4, 0.5 (approximate lensing-sensitivity peaks) |
   | COSMOS | galaxy point cloud + rebuilt 3D mass "clumps" | each galaxy at its `zphot` |

4. **Rotate Planck from galactic to equatorial** (`hp.Rotator(coord=['G','C'])`). If you skip this, the CMB is silently misaligned.

## 5. Build plan

### Step 1: Python prep (`prep/` → `viewer/public/data/`)
Dependencies: `healpy numpy scipy astropy pillow pandas`.

**DES**
1. Rebuild the full-sky maps and take the mean and std across the 100 samples.
2. Smooth ~10–20′ for display.
3. Write a plate-carrée RGBA PNG per bin (masked sky transparent).
4. Write float16 grids and a `manifest.json` with bounds, value ranges, and the top-N peaks (RA/Dec) for labels.

**Planck**
1. `ud_grade` to Nside 256.
2. Rotate G→C.
3. Write a 2048×1024 equirectangular PNG.

**COSMOS 3D rebuild**
1. Split by `zphot`, e.g. edges 0.3, 0.5, 0.7, 0.9, 1.1, 1.5.
2. Put weighted γ1, γ2 on a ~0.5′ flat grid per slice.
3. Run FFT Kaiser–Squires:
   ```python
   k1, k2 = np.meshgrid(np.fft.fftfreq(nx), np.fft.fftfreq(ny), indexing="xy")
   k2sum = k1**2 + k2**2; k2sum[0, 0] = 1
   kap = np.fft.ifft2(((k1**2 - k2**2)*np.fft.fft2(g1) + 2*k1*k2*np.fft.fft2(g2)) / k2sum).real
   ```
4. Smooth ~1′.
5. Difference consecutive slices to isolate the mass within each slice (each raw slice map holds all mass in front of its galaxies).
6. Save a 3D float32 grid plus the galaxy xyz positions as float32.
7. **Sanity check:** the known COSMOS cluster at z ≈ 0.73 should be a peak. If it's a hole, flip a γ sign.

### Step 2: Viewer (`viewer/`): Vite + three.js
- CMB: a big `SphereGeometry` with `side: BackSide`.
- DES: partial-sphere patches (phi/theta ranges from the manifest), a κ colormap, an opacity slider per shell, and a mean/uncertainty toggle.
- COSMOS: `THREE.Points` for the galaxies; clumps as a volume render or marching-cubes isosurfaces (three.js examples).
- Controls: layer toggles, scroll to fly outward through the shells, a "Go to COSMOS" button, hover readouts of RA/Dec/κ, and peak labels.
- Fallback if time runs short: Plotly 3D handles the COSMOS cone quickly, but it's weak at textured shells.

## 6. Wording rules (judges will probe these)

| Avoid | Say |
|---|---|
| "3D map of dark matter" (for DES) | "Projected mass maps; each layer looks through to more distant galaxies." The layers overlap; they are not slices of space. |
| "The COSMOS 3D map" | "Our rebuild of the COSMOS 3D map from the public Hubble shape catalog" |
| CMB layer = dark matter | The CMB is early-universe light; only the Planck *lensing* map traces dark matter |
| COSMOS is part of the DES map | It's a separate, much smaller and deeper field elsewhere on the sky |
| "AI found dark matter" | "The maps come from lensing measurements; AI reads parameters from their statistics" |

## 7. Suggested first prompts for Claude Code

1. > Read CLAUDE.md and HANDOFF.md. Do Step 1: write the prep script in `prep/`, set up a Python env, run it on the KaRMMa maps and COSMOS catalog (skip Planck for now), and show me a preview PNG of each layer.
2. > Do Step 2: build the Vite + three.js viewer that loads `viewer/public/data/`, with layer toggles, per-shell opacity, and a "Go to COSMOS" button. Start the dev server.
3. > Add the Planck layer once `planck/` has the SMICA file. Rotate to equatorial and check alignment by overlaying the DES footprint outline.

## 8. Key references
- Jeffrey et al. 2021, DES Y3 mass maps (arXiv:2105.13539)
- KaRMMa DES Y3 maps (zenodo.org/records/10668943; code github.com/Supranta/karmma)
- Massey et al. 2007, COSMOS 3D dark-matter map (astro-ph/0701480)
- Leauthaud et al. 2007, COSMOS weak-lensing catalog (IRSA DOI 10.26131/IRSA163)
- Planck 2018 VIII, Gravitational lensing (arXiv:1807.06210)
- Jeffrey et al. 2024, DES Y3 SBI (the "answer key"; S8 ≈ 0.80)
- Walmsley et al. 2023, Galaxy Zoo DESI (zenodo.org/records/8360385)
