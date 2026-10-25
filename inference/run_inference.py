#!/usr/bin/env python3
"""Run inference once per dataset; reuse the stored result afterwards.

  python run_inference.py --train work/train.npz --observed work/toy/obs.npz \
      --config work/cfg.json --manifest ../data/manifest.json --out ../data/inference.json \
      [--fiducial work/fid.npz] [--workdir work] [--force] [--skip-train]

The stored result IS the pair of cosmological parameters: data/inference.json holds
Omega_m and S8 (median + 68%/95% intervals) plus the checks around them. It also
records a fingerprint (sha256) of everything that determines the posterior: the
observed map, the frozen summary config and the training summaries.

  cache hit   fingerprint matches the stored result -> print it and exit (no training)
  cache miss  train (isolated subprocess) -> Planck comparison -> publish (stamps the fingerprint)

--force        ignore the cache and recompute
--skip-train   reuse <workdir>/posterior.json instead of training (e.g. after a crash)

Training runs in a child process with single-threaded BLAS/OpenMP and a writable
matplotlib cache: native-library aborts on macOS then fail that one stage cleanly
instead of killing the whole run.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import planck_compare  # noqa: E402
import publish_results  # noqa: E402


def fingerprint(*paths) -> str:
    """sha256 over the contents of the input files, in order (names are not hashed)."""
    h = hashlib.sha256()
    for p in paths:
        p = Path(p)
        if not p.exists():
            raise FileNotFoundError(f"input not found: {p}")
        h.update(p.read_bytes())
        h.update(b"\x00")
    return h.hexdigest()


def load_cached(out, fp):
    """Return the stored artifact if it exists, parses, and matches `fp`; else None."""
    out = Path(out)
    if not out.exists():
        return None
    try:
        art = json.loads(out.read_text())
    except (OSError, ValueError):
        return None
    return art if isinstance(art, dict) and art.get("fingerprint") == fp else None


def child_env():
    env = dict(os.environ)
    for k in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS", "VECLIB_MAXIMUM_THREADS"):
        env.setdefault(k, "1")
    env.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
    env.setdefault("MPLCONFIGDIR", str(HERE / "work" / ".mpl"))
    return env


def run_stage(argv, what):
    r = subprocess.run([sys.executable, *map(str, argv)], env=child_env())
    if r.returncode != 0:
        why = f"signal {-r.returncode}" if r.returncode < 0 else f"exit code {r.returncode}"
        raise SystemExit(f"{what} failed ({why}). Re-run; if it keeps aborting, see inference/README.md.")


def describe(art):
    s, o = art["S8"], art["Omega_m"]
    return (f"S8 = {s['median']:.3f} +{s['hi68'] - s['median']:.3f} -{s['median'] - s['lo68']:.3f}, "
            f"Omega_m = {o['median']:.3f} +{o['hi68'] - o['median']:.3f} -{o['median'] - o['lo68']:.3f} "
            f"({art['method']}{'; synthetic data' if art.get('synthetic') else ''})")


def _main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--train", required=True, help="summary_stats.py batch output for the training sims")
    ap.add_argument("--observed", required=True, help="map .npz (or summary JSON) to infer from")
    ap.add_argument("--config", required=True)
    ap.add_argument("--manifest", required=True, help="data/manifest.json of the map being described")
    ap.add_argument("--out", required=True, help="e.g. data/inference.json (also the cache)")
    ap.add_argument("--fiducial", default=None)
    ap.add_argument("--workdir", default=str(HERE / "work"))
    ap.add_argument("--n-samples", type=int, default=20000)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--mcmc", action="store_true", help="also run the emcee baseline and include it")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--skip-train", action="store_true")
    a = ap.parse_args(argv)

    fp = fingerprint(a.observed, a.config, a.train)
    if not a.force:
        hit = load_cached(a.out, fp)
        if hit:
            print(f"cache hit ({fp[:12]}): {a.out}\n  {describe(hit)}\n  inference not re-run (use --force to recompute)")
            return hit

    w = Path(a.workdir)
    w.mkdir(parents=True, exist_ok=True)
    post = w / "posterior.json"
    common = ["--train", a.train, "--observed", a.observed, "--config", a.config, "--seed", str(a.seed)]
    if a.fiducial:
        common += ["--fiducial", a.fiducial]

    if a.skip_train:
        if not post.exists():
            raise SystemExit(f"--skip-train needs {post}")
        print(f"reusing {post}")
    else:
        run_stage([HERE / "train_sbi.py", *common, "--out", post, "--n-samples", a.n_samples], "SBI training")

    compare = []
    if a.mcmc:
        run_stage([HERE / "mcmc_baseline.py", *common, "--out", w / "posterior_mcmc.json"], "MCMC baseline")
        compare = ["--compare", str(w / "posterior_mcmc.json")]
    elif a.skip_train and (w / "posterior_mcmc.json").exists():
        # only with an explicitly reused run: a stale baseline from another dataset must not sneak in
        compare = ["--compare", str(w / "posterior_mcmc.json")]
    planck_compare._main(["--posterior", str(post), "--out", str(w / "results"), *compare])

    truth_map = a.observed if str(a.observed).endswith(".npz") else None
    art = publish_results.publish(post, w / "results" / "s8_comparison.json", a.manifest, a.out,
                                  truth_map=truth_map, fingerprint=fp)
    print(f"stored {a.out} ({fp[:12]})\n  {describe(art)}")
    return art


if __name__ == "__main__":
    _main()
