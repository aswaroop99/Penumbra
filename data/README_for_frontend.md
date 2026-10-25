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

## inference.json (optional): the stored cosmology result

Produced offline by `inference/run_inference.py` (see `inference/README.md`) and loaded once per map. The
manifest points at it with `"inference": "inference.json"`; the pointer is not part of the manifest version,
so existing rooms stay valid. The viewer fetches it from `data/inference.json` (the dev/preview server only
serves `/manifest.json` and `/data/*`). If it is missing, malformed or computed from a different map, the viewer
simply hides the "Cosmology from this map" card. Parser: `src/lib/inference.ts`.

| Field | Meaning |
|---|---|
| `version` | schema version, currently `1` |
| `method`, `data` | e.g. `"sbi-NPE x1"` |
| `map` | `{source, n_layers}` of the map it was computed from; must equal the manifest's `source` and layer count |
| `synthetic` | `true` for toy observations: not a scientific result |
| `S8`, `Omega_m`, `sigma8` | `{median, lo68, hi68, lo95, hi95}`. `sigma8` is derived per sample from S8 = σ8·√(Ωm/0.3) |
| `training` | `n_train`, `n_heldout`, `n_features`, `n_samples` |
| `trust` | held-out coverage: `n_heldout`, `coverage_68_S8`, `binomial_1sigma_at_68`, `out_of_distribution`, ... (or `null`) |
| `comparison` | `planck`, `des_y3` references, `tension_vs_planck_sigma`, optional `mcmc` cross-check |
| `statement`, `caveats` | generated honest wording; the viewer shows `statement` only for non-synthetic maps |
| `truth` | known answer, toy observations only |
| `samples` | up to a few thousand `[Omega_m, S8]` posterior draws |
| `fingerprint` | cache key (sha256 of observed map + config + training summaries); ignored by the viewer |

## Fly-through notes (honest)
- The 4 layers are **mass projected toward progressively more distant galaxies**, not slices of 3D space — they overlap heavily. Label the depth axis "looking deeper / toward more distant sources," NOT "slices through space." Stacking them with parallax still gives a great pseudo-3D fly-through; just don't claim it's a literal 3D volume.
- Masked (transparent/NaN) regions are outside the survey footprint — render them as empty space, not zero-density.

## When real data arrives
Nothing changes on your side. The pipeline reruns `export_view.py` on the real map and overwrites
these files with the same names/schema. Your viewer should read `manifest.json` at load time and
never hard-code bounds, shapes, or layer counts.
