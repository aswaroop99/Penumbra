# DES vision-language map reader

This is a working **pretrained VLM application**, with a numerical feature extractor
and an SBI handoff. It is not a newly trained astrophysics foundation model.
No simulation training set or calibrated posterior is bundled with this reader. Local extraction and the toy demo need no API access.

The numerical path uses the existing `pipeline/summary_stats.compute_summary`
for both observations and simulations. The language path sends annotated map
images plus measured evidence to a vision-capable Claude or OpenAI model using the
[Responses image-input API](https://developers.openai.com/api/docs/guides/images-vision)
and [structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs).
It describes morphology and proposes follow-up; it does not supply the SBI vector.

```text
DES FITS / forward-modeled simulations
    -> shared map contract + frozen summary config
       -> peak histograms + pseudo power -> train.npz / summary.json -> SBI
       -> measured extrema + annotated PNGs -> pretrained VLM -> cited hypotheses
```

## Run now

Use the repo's Python environment (the conda env `penumbra` from `environment.yml`,
which already has the reader SDKs; see the root README "Python environments"), then
run the launcher from the repo root:

```bash
cd /path/to/Penumbra
conda env create -f environment.yml     # once
./run-reader demo --out reader_runs/toy
```

`run-reader` sets `OMP_NUM_THREADS` and `MPLCONFIGDIR`, loads `.env`, and runs
`python -m map_reader` inside `des_map/` with the interpreter chosen by
`bin/penumbra-python`. In the commands below, `../bin/penumbra-python` (from
`des_map/`) is the same interpreter.

Open `reader_runs/toy/analysis/report.md`. This makes four low-resolution
fiducial **toy lognormal** maps, one independent toy observation, freezes a
16-feature summary, and produces a report and annotated map. These are software
demonstrations, not physical simulations or DES constraints. The demo does not
train SBI or establish parameter recovery.

Without conda, a reader-only venv still works (the launcher finds it):

```bash
python3.11 -m venv .venv-map-reader
.venv-map-reader/bin/python -m pip install -r des_map/requirements-reader.txt pytest
```

## Claude with hackathon API credits

No conversion of the key or balance is needed. Add `ANTHROPIC_API_KEY` to the
ignored repository-root `.env` file locally and set `VLM_PROVIDER=anthropic`
and `VLM_MODEL=claude-sonnet-5-5`. From the root, run `./run-vlm-demo`.
The model must be enabled on your API account; override `VLM_MODEL` if needed.
Direct CLI calls accept `--provider anthropic --model claude-sonnet-5-5`.

Claude uses Anthropic's [vision Messages API](https://platform.claude.com/docs/en/build-with-claude/vision)
and [structured JSON outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs).
The measured summaries, evidence schema, validation, and SBI handoff are shared.
Responses and errors are cached/reported separately by provider. The API key for
one service is never substituted for the other's; API failures do not trigger
cross-provider fallback. SDK error messages are redacted before display.
A live Claude request has not been verified without an Anthropic key.

## Enable the OpenAI VLM

Set `OPENAI_API_KEY` in your terminal environment, or in the ignored repository-root
`.env` file when using `./run-reader` from the root. The launcher loads it locally. Do not put a secret in source
files. Choose an available model that supports vision and structured outputs;
`--model` is explicit so account access and cost are under your control.

```bash
../bin/penumbra-python -m map_reader analyze \
  --map reader_runs/toy/obs.npz --config reader_runs/toy/config.json \
  --out reader_runs/toy/vlm --model YOUR_VISION_MODEL_ID \
  --question "Describe the extrema and possible bridge-like structures. What is uncertain?"
```

Omit `--model` for local measurements only. With `--model`, the rendered PNGs,
summary vector, extrema coordinates, and source metadata are sent to the API.
The full FITS file and simulation parameter labels are not sent. Requests use
`store=False`; this is not a claim about provider-wide data-retention policies.
Answers are cached on exact images, evidence, question, model, prompt and schema.
Missing credentials, refused responses and invalid results never become a fake
successful VLM analysis; local outputs remain available.

## Analyze real DES maps

Inspect the FITS columns and provenance first. The local KS FITS headers lack
`COORDSYS`; the DES project reference identifies them as equatorial, hence the
explicit `--coord C` below. Do not infer missing coordinate systems silently.
Use the full map already present; a partially downloaded tomographic file must
finish downloading before it is ingested.

```bash
../bin/penumbra-python -m map_reader ingest \
  des_data/des_y3/KS_full.fits --coord C --nside 128 \
  --mask release/DES_Y3_KS_mask.fits \
  --out reader_runs/des/data.npz
```

Replace `release/DES_Y3_KS_mask.fits` with the verified release mask. The local
KS file contains finite values across the full sky, so ingestion now refuses it
without an explicit mask. There is a local nside-256 KaRMMa mask: it is used only
for the original development smoke-test demonstration, with
an explicit warning that its agreement with the KS survey selection is unverified.
That development smoke report used nside 256, 30/45 arcmin smoothing and toy reference maps;
only a small interior survived mask erosion. The report and original FITS files
remain in the development workspace; they are not bundled into this repository.
The nside-128 version was rejected because no eroded interior survived.
Use `--note "..."` to carry such limitations into map metadata and VLM evidence.

Choose analysis resolution before forward modeling. At nside 128 use smoothing
of at least ~55 arcmin (60/90 in this example). For finer DES morphology use
nside 512 with appropriate smoothing and matching simulations. Never compare a
low-resolution demonstration to an unmatched high-resolution SBI training set.

Once **survey-matched fiducial simulations** are available:

```bash
../bin/penumbra-python -m map_reader freeze \
  --fiducials 'matched/fid_*.npz' --smoothing 60 90 \
  --out reader_runs/des/config.json

../bin/penumbra-python -m map_reader analyze \
  --map reader_runs/des/data.npz --config reader_runs/des/config.json \
  --out reader_runs/des/analysis
```

`freeze` reads known `meta.theta` from fiducial maps, fixes bins and reference RMS,
and hashes the survey mask. Analysis rejects differing masks, coordinates,
resolution, tomographic-bin count or feature names. Images use a diverging
colormap and fixed ±4 fiducial RMS at the first smoothing scale; gray is missing
sky. The numeric summaries include **all** configured smoothing scales.
The default image bounds cover DES; for a different footprint use the Python
`freeze_config(..., ra=..., dec=...)` interface.

Matching mask/metadata cannot prove matched noise or reconstruction. Before
scientific use, verify the same resolution, footprint, reconstruction, source
redshift distribution, smoothing, mean subtraction and noise process. Gaussian
white shape noise and generic Stage-III redshift bins are approximations.

## Connect to SBI

Every simulation map must have known `meta.theta.Omega_m` and `meta.theta.S8`.
Use `pipeline/forward_model.py` with the observed map's mask before extraction;
consult its `--help` for your simulation format. No CosmoGrid files are downloaded
automatically. Keep simulation identities so all rotations/noise versions of
one realization stay in the same train/validation/test partition.

```bash
../bin/penumbra-python -m map_reader batch \
  --maps 'matched/sim_*.npz' --config reader_runs/des/config.json \
  --out reader_runs/des/train.npz

# Install torch and sbi separately when the physical training set is available.
../bin/penumbra-python pipeline/train_sbi.py \
  --train reader_runs/des/train.npz \
  --observed reader_runs/des/analysis/summary.json \
  --config reader_runs/des/config.json --out reader_runs/des/posterior.json
```

Batch outputs preserve `x, theta, names, files`, adding a config fingerprint.
The SBI reader verifies names and fingerprints before accepting new-reader
inputs. Do not edit the config after extraction. Existing older configs still
work with their older batch outputs. The existing trainer randomly splits rows;
pass independent realizations, or implement a group-aware split before using
multiple rotations from one simulation. Report held-out coverage, fiducial bias,
and comparison to the MCMC baseline before interpreting DES cosmology. The
reader itself does not establish these validations.

## Publish to the viewer

`./run-vlm-demo` now also writes `data/reader.json`, the one file the website reads
(contract in `data/README_for_frontend.md`, loader in `src/lib/reader.ts`). For any other run:

```bash
./run-reader export-site --analysis reader_runs/des/analysis \
  --manifest ../data/manifest.json --out ../data/reader.json
```

Each cited evidence ID is resolved to measured RA/Dec. Pins are linked to site
peaks only if the reader and `export_view.py` analysed the same map (`source`
and coordinates match); otherwise the file says so and the viewer shows separate
markers. Provider error messages are never exported.

## Output contract

| File | Contents |
|---|---|
| `evidence.json` | Input/config hashes, measured summary, peak/trough IDs, coordinates, limitations |
| `summary.json` | Fixed names/values plus provenance; accepted by the existing SBI trainer |
| `map_binN.png` | Projected map, coordinate axes, fixed scale, extrema labels |
| `analysis.json` | Explicit local-only status, or a VLM response with model and response ID |
| `report.md` | Human-readable measurements, images, and optional model interpretation |
| `config.json` | Exact extraction and rendering config used |

The model schema distinguishes measured extrema, visual hypotheses and quality
concerns. Every model feature cites existing evidence IDs; invented IDs are
rejected. Visual hypotheses must request follow-up. This validates reference
structure, **not the truth of free text**: review prose before presenting it.
An extrema ID supplies a position, not a cluster catalog match or a detection.
Evidence includes retained interior-pixel counts at every smoothing scale;
empty interiors are rejected, and very sparse interiors carry a warning.

No VLM-estimated S8, masses, redshifts or significance enter the numerical path.
Reference RMS is not a noise-only sigma. Projected minima are not confirmed
voids, and visually apparent bridges are not confirmed filaments. Tomographic
layers look toward progressively more distant sources and overlap in depth.

## Verify

```bash
cd /path/to/Penumbra
OMP_NUM_THREADS=2 MPLCONFIGDIR=/tmp/dm-reader-mpl \
  bin/penumbra-python -m pytest des_map/tests -q
```

Tests check numerical parity, mass-sheet invariance, masking, coordinate
round-trips, simulation-truth leakage, mismatched configuration rejection,
structured evidence validation, cache invalidation and missing-key recovery.
API requests are mocked; a live model call requires your key and model access.
