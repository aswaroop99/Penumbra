# Inference: reading Ωm and S8 off a map

Offline Python. Nothing here runs in the browser or in SpacetimeDB. The viewer only reads the
small result file this folder produces (`data/inference.json`).

```
map ─► summary stats ─► sbi (NPE flow) ─► posterior over (Ωm, S8) ─► Planck/DES comparison ─► data/inference.json
                    └─► emcee baseline (cross-check)
```

## Run it once per dataset

`run_inference.py` is the entry point. It fingerprints (sha256) the observed map, the frozen
summary config and the training summaries. If `data/inference.json` already holds a result
with the same fingerprint, it **loads that and exits without training**.

```bash
python run_inference.py --train work/train.npz --observed work/toy/obs.npz \
    --config work/cfg.json --manifest ../data/manifest.json --out ../data/inference.json \
    --fiducial work/fid.npz
```

| Flag | Effect |
|---|---|
| *(none)* | cache hit: print the stored result and stop. Cache miss: train → compare → publish |
| `--force` | ignore the cache and recompute |
| `--skip-train` | reuse `work/posterior.json` instead of training (e.g. after a crash) |
| `--mcmc` | also run the emcee baseline and include it as a cross-check |

Change the observed map, the config or the training sims and the fingerprint changes, so the
stored result is recomputed. Delete `data/inference.json` to force a fresh run.

The stored result **is** the pair of parameters: `Omega_m` and `S8` (median plus 68%/95%
intervals), and `sigma8` derived per posterior sample from S8 = σ8·√(Ωm/0.3).

## Install

Use the repo's conda env, which has torch, sbi and emcee from conda-forge (one OpenMP runtime):

```bash
conda env create -f environment.yml && conda activate penumbra
```

Without conda, a venv with the pinned set works too (the versions match the conda env):

```bash
python3.11 -m venv .venv && .venv/bin/pip install -r inference/requirements.txt
```

Don't pip-install torch into a conda env, and don't run a venv's Python while a different conda
env's libraries are on the path; `bin/penumbra-python` picks one environment and runs it cleanly.

Tests (these do not need torch): `python -m pytest inference/tests/test_contracts.py inference/tests/test_preprocess.py inference/tests/test_run_inference.py`.
`tests/test_pipeline_smoke.py` trains a real flow and needs a working torch/sbi install.

### If Python aborts or segfaults (macOS)

`Fatal Python error: Aborted` or exit 139 during training comes from native PyTorch/OpenMP code,
not from the pipeline logic. What helps: a venv (not global `site-packages`), single-threaded
BLAS/OpenMP, and a writable matplotlib cache. `run_inference.py` already runs training in a child
process with `OMP_NUM_THREADS=1`, `MKL_NUM_THREADS=1`, `PYTORCH_ENABLE_MPS_FALLBACK=1` and
`MPLCONFIGDIR=inference/work/.mpl`, so a native abort fails that one stage instead of the whole run.
Running `train_sbi.py` directly works too if you export the same variables first. Every stage
except training (`summary_stats`, `mcmc_baseline`, `planck_compare`, `publish_results`) is
torch-free.

## Step by step (toy universe)

```bash
cd inference
python toy_sims.py --n 300 --n-fid 30 --nside 128 --bins 4 --out work/toy     # known truth: Ωm 0.29, S8 0.76
python summary_stats.py make-config --maps 'work/toy/fid_*.npz' --smoothing 60 90 --out work/cfg.json
python summary_stats.py batch --maps 'work/toy/sim_*.npz' --config work/cfg.json --out work/train.npz
python summary_stats.py batch --maps 'work/toy/fid_*.npz' --config work/cfg.json --out work/fid.npz
python run_inference.py --train work/train.npz --observed work/toy/obs.npz --config work/cfg.json \
    --fiducial work/fid.npz --manifest ../data/manifest.json --out ../data/inference.json --mcmc
```

Smoothing scales must be at least about 2× the pixel size (27′ at nside 128).
Remove old `work/toy/` files before regenerating; stale `sim_*.npz` files get globbed into training.

## The three contracts

1. **Map** `.npz`: `kappa`, `mask`, `meta` (HEALPix, RING). See `contracts.py`.
2. **Summary**: a fixed-length vector plus names, from one frozen `cfg.json`.
3. **Posterior** JSON: samples over `["Omega_m", "S8"]`, `method`, `data`, `meta`.

`publish_results.py` then bundles the posterior, held-out coverage and the Planck comparison into
`data/inference.json` and adds `"inference": "inference.json"` to `data/manifest.json`. The viewer
fetches it from `data/inference.json` and ignores it if its `map.source` or layer count does not match
the loaded manifest. Schema: `data/README_for_frontend.md`.

## Trust criteria (what to check before showing a result)

- **Held-out coverage**: the true S8 should fall inside the 68% interval about 68% of the time, within
  about 2 binomial σ. The viewer flags it when it does not.
- **Out-of-distribution**: no observed summary more than ~5σ from the simulation cloud
  (`trust.out_of_distribution`).
- **Fiducial bias**: posterior medians on fiducial-cosmology sims should scatter around the known S8.
- **MCMC cross-check**: SBI and emcee should agree within about 1σ. If they do not, investigate before
  demoing either. The emcee covariance uses the Hartlap correction and is flagged as noisy when
  there are too few fiducial sims for the vector length.

## Honest claims

- Toy-data results are **not** science. The toy generator is not physics and its error bars are far
  tighter than real DES, so any "tension" with Planck on toy data is meaningless. The viewer labels
  it "Toy data" and hides the tension statement.
- Even on real data the claim is a validated reimplementation of a published-style analysis, not a new
  measurement. Say "reads the parameters off the map", not "AI found dark matter".

## Real-data cutover

The DES map and every simulation must share the same nside, mask, noise model, smoothing and mean
subtraction (`forward_model.py`, then one `cfg.json` for everything). Then replace the toy inputs
(`--observed` the real map, `--train` summaries of CosmoGrid sims, regenerate `data/manifest.json` with
`export_view.py`) and rerun `run_inference.py`. The new map changes `map.source`, so the toy result is
ignored automatically; the new fingerprint triggers a fresh run.
