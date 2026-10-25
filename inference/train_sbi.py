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
import json
import pickle
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from contracts import load_map, save_posterior  # noqa: E402
from preprocess import MIN_TRAIN, check_observed, prepare  # noqa: E402

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
        k, m, _ = load_map(p)
        return compute_summary(k, m, cfg)[0]
    return np.asarray(json.loads(Path(p).read_text())["values"], dtype=float)


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
    ap.add_argument("--min-train", type=int, default=MIN_TRAIN,
                    help="refuse to train on fewer sims than this (lower only for smoke tests)")
    a = ap.parse_args(argv)

    cfg = json.loads(Path(a.config).read_text())
    prep = prepare(a.train, cfg, a.heldout_frac, a.seed, min_train=a.min_train)  # shared with mcmc_baseline.py
    x, theta, z, tr, ho, mu, sd = prep.x, prep.theta, prep.z, prep.tr, prep.ho, prep.mu, prep.sd
    if prep.n_dropped:
        print(f"dropped {prep.n_dropped} simulations with non-finite theta or summaries")
    print(f"training on {len(tr)} sims x {x.shape[1]} features, holding out {len(ho)}")

    posts = [train(theta[tr], z[tr], seed=a.seed + i) for i in range(a.ensemble)]

    xo = observed_vector(a.observed, cfg)
    zo = (xo - mu) / sd
    far, worst, ood = check_observed(zo, prep.names)
    if ood:
        print(f"WARNING: observed summary is {far:.1f} sd from the sim cloud in feature {worst}. "
              "Likely a data/sim mismatch; see 'Debugging table' in SKILL.md.")
    samples = sample(posts, zo, a.n_samples)

    cov = coverage(posts, theta[ho], z[ho])
    cov["out_of_distribution"] = {"max_abs_z": round(far, 2), "feature": worst, "flagged": ood}
    if a.fiducial:
        f = np.load(a.fiducial)
        if f["x"].shape[1] != x.shape[1]:
            raise SystemExit(f"fiducial summaries have {f['x'].shape[1]} features, training has {x.shape[1]}")
        meds = np.array([np.median(sample(posts, (xx - mu) / sd, 500)[:, 1]) for xx in f["x"]])
        truth = float(np.nanmedian(f["theta"][:, 1]))
        cov["fiducial_S8_bias"] = {"truth": truth, "mean_of_medians": float(meds.mean()),
                                   "scatter": float(meds.std()), "n": int(len(meds))}

    out = Path(a.out)
    save_posterior(out, samples, f"sbi-NPE x{a.ensemble}", a.data_label, meta={
        "n_train": int(len(tr)), "n_heldout": int(len(ho)), "seed": int(a.seed),
        "n_features": int(x.shape[1]), "config": str(a.config), "max_abs_z_observed": round(float(far), 2), "coverage_68_S8": cov["empirical"]["S8"][1]})
    out.with_name(out.stem + "_coverage.json").write_text(json.dumps(cov, indent=1))
    with open(out.with_name(out.stem + "_estimator.pkl"), "wb") as fh:
        pickle.dump({"posteriors": posts, "mu": mu, "sd": sd, "names": cfg["names"]}, fh)
    q = np.quantile(samples[:, 1], [0.16, 0.5, 0.84])
    print(f"S8 = {q[1]:.3f} +{q[2]-q[1]:.3f} -{q[1]-q[0]:.3f}")
    print(f"held-out coverage S8 @68%: {cov['empirical']['S8'][1]} (ideal 0.68 +/- {cov['binomial_1sigma_at_68']})")


if __name__ == "__main__":
    _main()
