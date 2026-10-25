# Viewer data

These are the **real DES Y3 mass maps**: the mean of the 100 KaRMMa posterior samples
(zenodo.org/records/10668943), written by the `des_map/` pipeline
(`des_map/make_des_map.py` on the KaRMMa sample stack, which calls `des_map/pipeline/export_view.py`; 10′ display smoothing). (An earlier version of this folder
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
- `peaks[]`: `{ra, dec, kappa, snr, bin}`, plus optional `post_snr` — the clusters. `snr` = κ / layer sigma (peak height); `post_snr` (only written by `prep/export_des.py`) = κ / posterior std across the samples. Treat `post_snr` as optional. Label/flag these in the UI; they're the "fly to a landmark" targets and the hooks for the citizen-annotation layer.
- `coord`: `C` = equatorial (celestial). `smoothing_arcmin`: display smoothing applied.

## Fly-through notes (honest)
- The 4 layers are **mass projected toward progressively more distant galaxies**, not slices of 3D space — they overlap heavily. Label the depth axis "looking deeper / toward more distant sources," NOT "slices through space." Stacking them with parallax still gives a great pseudo-3D fly-through; just don't claim it's a literal 3D volume.
- Masked (transparent/NaN) regions are outside the survey footprint — render them as empty space, not zero-density.

## Regenerating
The pipeline reruns `export_view.py` and overwrites these files with the same names and schema.
`prep/export_des.py` (Ethan's script, 20′ smoothing, adds `post_snr`) writes the same schema and can be
used instead. Either way, viewers read `manifest.json` at load time and never hard-code bounds,
shapes, or layer counts. **After regenerating, re-run `./run-vlm-demo`** so `reader.json` matches the new map.

## Optional: `reader.json` (AI map-reader layer)

Written offline by `./run-vlm-demo` (or `./run-reader export-site --analysis <run> --manifest ../data/manifest.json --out ../data/reader.json`).
Served at `/data/reader.json` like every other file here. Load it with `loadReader()` from `src/lib/reader.ts`;
it resolves to `null` if the file is absent, so the viewer must work without it. No API key or model call
ever reaches the browser.

- `status`: `ok` | `abstained` | `local_only` (no model run) | `vlm_failed`. Show the overview/features only for `ok`.
- `overview`, `features[]`: Claude's text. Each feature has `kind` (`measured_extremum`, `visual_hypothesis`,
  `quality_concern`), `text`, `requires_followup`, `targets[]` and `refs[]`.
- `targets[]`: `{id, type: peak|trough, bin, ra, dec, kappa, kappa_over_reference_rms}`, real measured positions
  for every ID Claude cited. Use these as pins / "fly to" targets.
- `alignment.aligned`: `true` only if the reader analysed the **same map** as `manifest.json`. Then
  `target.site_peak.index` points into `manifest.peaks` (or is `null` if no site peak lies within one reader pixel).
  If `false`, read `alignment.reasons` and draw the pins as their own markers, not as site peaks.
- `objects[]`: all measured extrema, available even when no model ran.
- `measurement_limitations`, `model_limitations`, `disclaimer`, `is_toy`, `source`: show the disclaimer next to
  any AI text, and label toy data as toy.

Rules: render every string with `textContent` (never `innerHTML`). `kappa_over_reference_rms` is **not** a
detection significance. Call Claude's text "AI description of the map's shape", never a measurement, and
never show it next to S8/Ωm as if it fed the inference.

## COSMOS 3D grid (`cosmos/`)
Written by `prep/cosmos_3d.py` from the COSMOS HST shear catalog (Leauthaud et al. 2007).
- `cosmos_3d.f32.bin` — float32 grid, shape and index layout in the JSON (`index = depth + nd*(x + nx*y)`).
  Values are lens-detection significance (σ); each detected lens is drawn at its most likely redshift.
- `cosmos_3d.json` — bounds, redshift range (`z_near`..`z_far`), method, galaxy counts, and the
  strongest 3D peaks `{ra, dec, z, value}`.
- `cosmos_3d_faint.f32.bin` — same layout; the lenses drawn wider in redshift, for the low-confidence
  "haze" isosurface (~1σ up to the clump threshold). Largely noise; label it that way.
Depth resolution is poor; treat redshifts as approximate.
