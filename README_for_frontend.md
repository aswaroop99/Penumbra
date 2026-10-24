# Sample viewer data — build the fly-through against this

This is **toy (fake-but-realistic) data** with a known answer, so the explorer can be built
before the real DES maps arrive. The file shapes and `manifest.json` schema are the **real
contract** — when real data lands, these same files get regenerated with identical structure,
and your frontend keeps working unchanged. Build to the manifest, not to the pixels.

## Files (per depth layer, 4 layers = bin0..bin3)
- `layer_bin{b}.png`  — RGBA image, colour = smoothed dark-matter density (κ). **Masked sky is transparent.** Drop straight onto a plane/quad.
- `layer_bin{b}.f16.bin` — raw float16 grid (row-major, height × width, NaN = masked). Use for shaders, custom colormaps, or hover-to-read-value. Shape is in the manifest.
- `manifest.json` — everything you need to place and label it.

## manifest.json schema
- `bounds`: `{ra_min, ra_max, dec_min, dec_max}` in degrees — the geographic extent of every layer.
- `convention`: plate carrée; **column 0 = ra_max (east-left, astronomical), row 0 = dec_max**. RA may be negative (= RA+360). Read this before mapping pixels↔sky.
- `layers[]`: each has `name`, `png`, `raw`, `shape:[h,w]`, `vmin`, `vmax`, `sigma`. Use vmin/vmax for colour scaling if you render from the raw grid.
- `peaks[]`: `{ra, dec, kappa, snr, bin}` — the clusters. Label/flag these in the UI; they're the "fly to a landmark" targets and the hooks for the citizen-annotation layer.
- `coord`: `C` = equatorial (celestial). `smoothing_arcmin`: display smoothing applied.

## Fly-through notes (honest)
- The 4 layers are **mass projected toward progressively more distant galaxies**, not slices of 3D space — they overlap heavily. Label the depth axis "looking deeper / toward more distant sources," NOT "slices through space." Stacking them with parallax still gives a great pseudo-3D fly-through; just don't claim it's a literal 3D volume.
- Masked (transparent/NaN) regions are outside the survey footprint — render them as empty space, not zero-density.

## When real data arrives
Nothing changes on your side. The pipeline reruns `export_view.py` on the real map and overwrites
these files with the same names/schema. Your viewer should read `manifest.json` at load time and
never hard-code bounds, shapes, or layer counts.
