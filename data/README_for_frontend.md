# Viewer data

These are the **real DES Y3 mass maps**: the mean of the 100 KaRMMa posterior samples
(zenodo.org/records/10668943), written by `prep/export_des.py`. (An earlier version of this folder
held toy data with the same file shapes; the schema didn't change, so the viewers kept working.)
Build to the manifest, not to the pixels.

## Files (per depth layer, 4 layers = bin0..bin3)
- `layer_bin{b}.png`  — RGBA image, colour = smoothed dark-matter density (κ). **Masked sky is transparent.** Drop straight onto a plane/quad.
- `layer_bin{b}.f16.bin` — raw float16 grid (row-major, height × width, NaN = masked). Use for shaders, custom colormaps, or hover-to-read-value. Shape is in the manifest.
- `manifest.json` — everything you need to place and label it.

## manifest.json schema
- `bounds`: `{ra_min, ra_max, dec_min, dec_max}` in degrees — the geographic extent of every layer.
- `convention`: plate carrée; **column 0 = ra_max (east-left, astronomical), row 0 = dec_max**. RA may be negative (= RA+360). Read this before mapping pixels↔sky.
- `layers[]`: each has `name`, `png`, `raw`, `shape:[h,w]`, `vmin`, `vmax`, `sigma`. Use vmin/vmax for colour scaling if you render from the raw grid.
- `peaks[]`: `{ra, dec, kappa, snr, post_snr, bin}` — the clusters. `snr` = κ / layer sigma (peak height); `post_snr` = κ / posterior std across the samples (how certain the peak is, typically 2–4 for the top peaks). Label/flag these in the UI; they're the "fly to a landmark" targets and the hooks for the citizen-annotation layer.
- `coord`: `C` = equatorial (celestial). `smoothing_arcmin`: display smoothing applied.

## Fly-through notes (honest)
- The 4 layers are **mass projected toward progressively more distant galaxies**, not slices of 3D space — they overlap heavily. Label the depth axis "looking deeper / toward more distant sources," NOT "slices through space." Stacking them with parallax still gives a great pseudo-3D fly-through; just don't claim it's a literal 3D volume.
- Masked (transparent/NaN) regions are outside the survey footprint — render them as empty space, not zero-density.

## Regenerating
Run `.venv/bin/python prep/export_des.py` (see the main README for setup). It overwrites these files
with the same names and schema. Viewers should read `manifest.json` at load time and never hard-code
bounds, shapes, or layer counts.

## COSMOS 3D grid (`cosmos/`)
Written by `prep/cosmos_3d.py` from the COSMOS HST shear catalog (Leauthaud et al. 2007).
- `cosmos_3d.f32.bin` — float32 grid, shape and index layout in the JSON (`index = depth + nd*(x + nx*y)`).
  Values are lens-detection significance (σ); each detected lens is drawn at its most likely redshift.
- `cosmos_3d.json` — bounds, redshift range (`z_near`..`z_far`), method, galaxy counts, and the
  strongest 3D peaks `{ra, dec, z, value}`.
Depth resolution is poor; treat redshifts as approximate.
