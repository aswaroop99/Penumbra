#!/usr/bin/env python3
"""Neural posterior estimation (sbi) for (Omega_m, S8) from map summaries,
plus the coverage "trust check" on held-out simulations.

  python train_sbi.py --train train.npz --observed data.npz --config cfg.json \
      --out posterior.json [--heldout-frac 0.1] [--ensemble 1] [--fiducial fid.npz]

--train     output of `summary_stats.py batch` (x, theta)
--observed  map contract (.npz map) or summary JSON from `summary_stats.py one`
--fiducial  optional `batch` output of fiducial-cosmology sims: reports the bias
            of posterior medians vs. the known fiducial S8

Writes posterior.json (posterior contract), posterior_coverage.json, and
posterior_estimator.pkl (reuse with pickle to sample new observations).

Effective prior = the distribution of training theta. The BoxUniform below only
bounds the support. CosmoGrid samples (Omega_m, sigma8) on a box, which is NOT a
box in (Omega_m, S8), so posteriors near the corners are prior-shaped: say so.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import pickle
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from contracts import load_map, save_posterior  # noqa: E402

LEVELS = [0.5, 0.68, 0.9, 0.95]


def _npe_class():
    try:
        from sbi.inference import NPE  # sbi >= 0.23
        return NPE
    except ImportError:
        from sbi.inference import SNPE  # older sbi
        return SNPE


def observed_vector(path, cfg):
    p = str(path)
    if p.endswith(".npz"):
        from summary_stats import compute_summary
        k, m, meta = load_map(p)
        if "map_reader" in cfg:
            frozen = cfg["map_reader"]
            mh = hashlib.sha256(m.astype(np.uint8).tobytes()).hexdigest()
            if mh != frozen["mask_sha256"] or meta.get("coord") != frozen["coord"]:
                raise ValueError("Observed mask/coordinates differ from frozen map-reader config")
        return compute_summary(k, m, cfg)[0]
    obj = json.loads(Path(p).read_text())
    if obj.get("names") != cfg["names"]:
        raise ValueError("Observed summary names differ from frozen config")
    if "map_reader" in cfg and obj.get("config_sha256") != config_digest(cfg):
        raise ValueError("Observed summary fingerprint differs from frozen config")
    vec = np.asarray(obj["values"], dtype=float)
    if vec.shape != (len(cfg["names"]),) or not np.isfinite(vec).all():
        raise ValueError("Observed summary has wrong shape or non-finite values")
    return vec


def config_digest(cfg):
    return hashlib.sha256(json.dumps(cfg, sort_keys=True, allow_nan=False).encode()).hexdigest()


def validate_training_config(d, cfg):
    if "names" not in d or d["names"].tolist() != cfg["names"]:
        raise ValueError("Training feature names differ from frozen config")
    if "map_reader" in cfg:
        if "config_sha256" not in d or str(d["config_sha256"]) != config_digest(cfg):
            raise ValueError("Training fingerprint differs from frozen map-reader config; use map_reader batch")


def train(theta, x, seed=0, density_estimator="maf", max_epochs=500):
    import torch
    from sbi.utils import BoxUniform
    torch.manual_seed(seed)
    lo, hi = theta.min(0), theta.max(0)
    pad = 0.02 * (hi - lo)
    prior = BoxUniform(low=torch.tensor(lo - pad, dtype=torch.float32),
                       high=torch.tensor(hi + pad, dtype=torch.float32))
    inf = _npe_class()(prior=prior, density_estimator=density_estimator)
    inf.append_simulations(torch.tensor(theta, dtype=torch.float32), torch.tensor(x, dtype=torch.float32))
    est = inf.train(validation_fraction=0.1, stop_after_epochs=20, max_num_epochs=max_epochs, show_train_summary=False)
    return inf.build_posterior(est)


def sample(posteriors, xz, n):
    import torch
    per = int(np.ceil(n / len(posteriors)))
    out = [p.sample((per,), x=torch.tensor(xz, dtype=torch.float32), show_progress_bars=False).numpy() for p in posteriors]
    return np.concatenate(out)[:n]


def coverage(posteriors, theta_ho, x_ho, n_samples=500):
    """Empirical coverage of central credible intervals, per parameter."""
    hits = {k: np.zeros((len(LEVELS),)) for k in ("Omega_m", "S8")}
    ranks = []
    for t, xx in zip(theta_ho, x_ho):
        s = sample(posteriors, xx, n_samples)
        for j, k in enumerate(("Omega_m", "S8")):
            for i, lev in enumerate(LEVELS):
                lo, hi = np.quantile(s[:, j], [(1 - lev) / 2, (1 + lev) / 2])
                hits[k][i] += lo <= t[j] <= hi
        ranks.append(float((s[:, 1] < t[1]).mean()))
    n = len(theta_ho)
    return {
        "n_heldout": n,
        "levels": LEVELS,
        "empirical": {k: (v / n).round(3).tolist() for k, v in hits.items()},
        "binomial_1sigma_at_68": round(float(np.sqrt(0.68 * 0.32 / n)), 3),
        "S8_rank_histogram": np.histogram(ranks, bins=10, range=(0, 1))[0].tolist(),
    }


def _main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--train", required=True)
    ap.add_argument("--observed", required=True)
    ap.add_argument("--config", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--heldout-frac", type=float, default=0.1)
    ap.add_argument("--ensemble", type=int, default=1, help="train N flows with different seeds and pool samples")
    ap.add_argument("--n-samples", type=int, default=20000)
    ap.add_argument("--fiducial", default=None)
    ap.add_argument("--data-label", default="observed map")
    ap.add_argument("--seed", type=int, default=0)
    a = ap.parse_args(argv)

    cfg = json.loads(Path(a.config).read_text())
    d = np.load(a.train)
    validate_training_config(d, cfg)
    x, theta = d["x"].astype(float), d["theta"].astype(float)
    if x.ndim != 2 or x.shape[1] != len(cfg["names"]):
        raise ValueError("Training feature matrix differs from frozen config")
    ok = np.all(np.isfinite(theta), 1) & np.all(np.isfinite(x), 1)
    x, theta = x[ok], theta[ok]
    if not 0 < a.heldout_frac < 1 or len(x) < 30:
        raise ValueError("Need at least 30 finite independent simulations and heldout-frac in (0,1)")
    rng = np.random.default_rng(a.seed)
    perm = rng.permutation(len(x))
    n_ho = max(10, int(a.heldout_frac * len(x)))
    ho, tr = perm[:n_ho], perm[n_ho:]
    if len(tr) < 20:
        raise ValueError("At least 20 simulations must remain for training")
    mu, sd = x[tr].mean(0), x[tr].std(0) + 1e-12  # z-score with TRAINING stats only
    z = (x - mu) / sd
    print(f"training on {len(tr)} sims x {x.shape[1]} features, holding out {n_ho}")

    xo = observed_vector(a.observed, cfg)
    posts = [train(theta[tr], z[tr], seed=a.seed + i) for i in range(a.ensemble)]
    zo = (xo - mu) / sd
    far = np.abs(zo).max()
    if far > 5:
        print(f"WARNING: observed summary is {far:.1f} sd from the sim cloud in at least one feature "
              "(feature {}). Likely a data/sim mismatch; see 'Debugging table' in SKILL.md.".format(
                  cfg["names"][int(np.abs(zo).argmax())]))
    samples = sample(posts, zo, a.n_samples)

    cov = coverage(posts, theta[ho], z[ho])
    if a.fiducial:
        f = np.load(a.fiducial)
        meds = np.array([np.median(sample(posts, (xx - mu) / sd, 500)[:, 1]) for xx in f["x"]])
        truth = float(np.nanmedian(f["theta"][:, 1]))
        cov["fiducial_S8_bias"] = {"truth": truth, "mean_of_medians": float(meds.mean()),
                                   "scatter": float(meds.std()), "n": int(len(meds))}

    out = Path(a.out)
    save_posterior(out, samples, f"sbi-NPE x{a.ensemble}", a.data_label, meta={
        "n_train": int(len(tr)), "n_features": int(x.shape[1]), "config": str(a.config),
        "max_abs_z_observed": round(float(far), 2), "coverage_68_S8": cov["empirical"]["S8"][1]})
    out.with_name(out.stem + "_coverage.json").write_text(json.dumps(cov, indent=1))
    with open(out.with_name(out.stem + "_estimator.pkl"), "wb") as fh:
        pickle.dump({"posteriors": posts, "mu": mu, "sd": sd, "names": cfg["names"]}, fh)
    q = np.quantile(samples[:, 1], [0.16, 0.5, 0.84])
    print(f"S8 = {q[1]:.3f} +{q[2]-q[1]:.3f} -{q[1]-q[0]:.3f}")
    print(f"held-out coverage S8 @68%: {cov['empirical']['S8'][1]} (ideal 0.68 +/- {cov['binomial_1sigma_at_68']})")


if __name__ == "__main__":
    _main()
