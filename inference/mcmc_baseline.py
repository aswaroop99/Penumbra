#!/usr/bin/env python3
"""Classic baseline: Gaussian likelihood + emcee on the SAME summary vectors.

Mean model: per-feature quadratic emulator in (Omega_m, S8) fit to training sims.
Covariance: from fiducial-cosmology sims with the Hartlap correction (requires
n_fiducial > n_features + 5; see preprocess.hartlap_inverse), or (if too few
fiducial sims for the vector length) from emulator residuals - cruder, flagged.
Split, z-scoring and prior support come from preprocess.prepare, identical to
train_sbi.py (pass the same --seed / --heldout-frac).
If this and SBI disagree by more than ~1 sigma, investigate before demoing either.

  python mcmc_baseline.py --train train.npz --observed data.npz --config cfg.json \
      --out posterior_mcmc.json [--fiducial fid.npz]
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import emcee
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from contracts import save_posterior  # noqa: E402
from preprocess import MIN_TRAIN, check_observed, hartlap_inverse, prepare  # noqa: E402
from train_sbi import observed_vector  # noqa: E402


def design(theta):
    om, s8 = theta[:, 0], theta[:, 1]
    return np.c_[np.ones_like(om), om, s8, om**2, s8**2, om * s8]


def _main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--train", required=True)
    ap.add_argument("--observed", required=True)
    ap.add_argument("--config", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--fiducial", default=None)
    ap.add_argument("--steps", type=int, default=3000)
    ap.add_argument("--data-label", default="observed map")
    ap.add_argument("--heldout-frac", type=float, default=0.1, help="must match train_sbi.py")
    ap.add_argument("--seed", type=int, default=0, help="must match train_sbi.py")
    ap.add_argument("--min-train", type=int, default=MIN_TRAIN)
    a = ap.parse_args(argv)

    cfg = json.loads(Path(a.config).read_text())
    # Same split, z-scoring and prior support as train_sbi.py, so the two are comparable.
    prep = prepare(a.train, cfg, a.heldout_frac, a.seed, min_train=a.min_train)
    theta, z = prep.theta[prep.tr], prep.z[prep.tr]
    mu, sd = prep.mu, prep.sd
    A = design(theta)
    coef, *_ = np.linalg.lstsq(A, z, rcond=None)
    resid = z - A @ coef
    p = z.shape[1]

    icov = None
    cov_source = "emulator residuals (crude: includes cosmology dependence)"
    if a.fiducial:
        zf = (np.load(a.fiducial)["x"] - mu) / sd
        if zf.shape[1] != p:
            raise SystemExit(f"fiducial summaries have {zf.shape[1]} features, training has {p}")
        icov, note = hartlap_inverse(zf)
        if icov is None:
            print(f"{note}; falling back to emulator residuals")
        else:
            cov_source = note
    if icov is None:
        cov = np.cov(resid, rowvar=False) + 1e-6 * np.eye(p)
        icov = np.linalg.inv(cov)

    zo = (observed_vector(a.observed, cfg) - mu) / sd
    far, worst, ood = check_observed(zo, prep.names)
    if ood:
        print(f"WARNING: observed summary is {far:.1f} sd from the sim cloud in feature {worst}.")
    lo, hi = prep.lo_hi

    def logp(t):
        if np.any(t < lo) or np.any(t > hi):
            return -np.inf
        r = zo - design(t[None])[0] @ coef
        return -0.5 * r @ icov @ r

    nw = 32
    rng = np.random.default_rng(0)
    # start the walkers at the best-fitting training thetas, with a little jitter
    start = theta[np.argsort([-logp(t) for t in theta])[:nw]] + 1e-3 * rng.normal(size=(nw, 2))
    start = np.clip(start, lo + 1e-6, hi - 1e-6)
    sampler = emcee.EnsembleSampler(nw, 2, logp)
    sampler.run_mcmc(start, a.steps, progress=False)
    try:
        tau = float(np.max(sampler.get_autocorr_time(tol=0)))
    except Exception:
        tau = float("nan")
    chain = sampler.get_chain(discard=a.steps // 3, thin=max(1, int(tau // 2) if np.isfinite(tau) else 5), flat=True)
    save_posterior(a.out, chain, "gaussian-likelihood emcee", a.data_label,
                   meta={"cov_source": cov_source, "n_train": int(len(prep.tr)), "seed": int(a.seed), "autocorr_time": round(tau, 1),
                         "acceptance": round(float(sampler.acceptance_fraction.mean()), 3)})
    q = np.quantile(chain[:, 1], [0.16, 0.5, 0.84])
    print(f"S8 = {q[1]:.3f} +{q[2]-q[1]:.3f} -{q[1]-q[0]:.3f}  (cov: {cov_source}; tau={tau:.0f}, steps={a.steps})")
    if np.isfinite(tau) and a.steps < 50 * tau:
        print("note: chain shorter than 50 autocorrelation times; increase --steps for a final number")


if __name__ == "__main__":
    _main()
