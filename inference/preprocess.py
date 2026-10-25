#!/usr/bin/env python3
"""Shared preprocessing for every estimator that reads training summaries.

SBI (train_sbi.py) and the MCMC baseline (mcmc_baseline.py) must see exactly the
same z-scored features, the same train/held-out split and the same prior bounds.
If they do not, their disagreement means nothing. Both import this module; do not
re-derive mu/sd or the split anywhere else.

Rules encoded here:
  * rows with non-finite theta or summaries are dropped (and counted);
  * the feature names of the training batch must equal the frozen config's names;
  * the held-out set is chosen once, deterministically from (n, frac, seed);
  * mu/sd come from the TRAINING split only;
  * too few simulations raise instead of silently training on nothing;
  * the covariance for the MCMC baseline is only trusted with enough fiducial sims.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

MIN_TRAIN = 50          # fewer training sims than this: refuse (the flow would just memorise)
MIN_HELDOUT = 5         # fewer held-out sims than this: coverage is meaningless
HARTLAP_MARGIN = 5      # fiducial sims must exceed n_features + this for a usable covariance
OOD_SIGMA = 5.0         # observed feature this many sd from the sim cloud => data/sim mismatch


class PreprocessError(ValueError):
    """Raised for inputs that would silently produce a wrong inference."""


@dataclass
class Prepared:
    x: np.ndarray         # (n, p) raw summaries, finite rows only
    theta: np.ndarray     # (n, 2) Omega_m, S8
    z: np.ndarray         # (n, p) z-scored with training statistics
    tr: np.ndarray        # indices of training sims
    ho: np.ndarray        # indices of held-out sims
    mu: np.ndarray
    sd: np.ndarray
    names: list
    n_dropped: int

    @property
    def lo_hi(self):
        """Support of the training thetas (training split only)."""
        t = self.theta[self.tr]
        return t.min(0), t.max(0)


def load_training(path, cfg):
    """Read `summary_stats.py batch` output; validate against the frozen config."""
    d = np.load(path, allow_pickle=False)
    x, theta = np.asarray(d["x"], dtype=float), np.asarray(d["theta"], dtype=float)
    if x.ndim != 2 or theta.ndim != 2 or theta.shape[1] != 2 or len(x) != len(theta):
        raise PreprocessError(f"bad shapes in {path}: x{x.shape} theta{theta.shape}")
    names = [str(n) for n in cfg["names"]]
    if x.shape[1] != len(names):
        raise PreprocessError(f"{path} has {x.shape[1]} features but the config freezes {len(names)}")
    if "names" in d.files and [str(n) for n in d["names"]] != names:
        raise PreprocessError(f"feature names in {path} differ from the config; regenerate with the same cfg.json")
    ok = np.all(np.isfinite(theta), 1) & np.all(np.isfinite(x), 1)
    return x[ok], theta[ok], names, int((~ok).sum())


def split_indices(n, heldout_frac=0.1, seed=0, min_train=MIN_TRAIN, min_heldout=MIN_HELDOUT):
    """Deterministic (train, held-out) split. Raises if either side would be too small."""
    if n < min_train + min_heldout:
        raise PreprocessError(
            f"{n} usable simulations is not enough: need at least {min_train} for training plus "
            f"{min_heldout} held out for the coverage check")
    n_ho = int(np.clip(round(heldout_frac * n), min_heldout, n - min_train))
    perm = np.random.default_rng(seed).permutation(n)
    return np.sort(perm[n_ho:]), np.sort(perm[:n_ho])


def prepare(train_path, cfg, heldout_frac=0.1, seed=0, min_train=MIN_TRAIN, min_heldout=MIN_HELDOUT):
    x, theta, names, dropped = load_training(train_path, cfg)
    tr, ho = split_indices(len(x), heldout_frac, seed, min_train, min_heldout)
    mu = x[tr].mean(0)
    sd = x[tr].std(0) + 1e-12  # constant features (e.g. an always-empty peak bin) stay finite
    return Prepared(x, theta, (x - mu) / sd, tr, ho, mu, sd, names, dropped)


def check_observed(zo, names, limit=OOD_SIGMA):
    """Return (max |z|, name of worst feature, is_out_of_distribution)."""
    zo = np.asarray(zo, dtype=float)
    if zo.shape != (len(names),):
        raise PreprocessError(f"observed summary has {zo.size} entries, config has {len(names)}")
    if not np.all(np.isfinite(zo)):
        raise PreprocessError("observed summary has non-finite entries")
    i = int(np.abs(zo).argmax())
    return float(abs(zo[i])), names[i], bool(abs(zo[i]) > limit)


def hartlap_inverse(z_fid):
    """Inverse covariance of fiducial summaries with the Hartlap correction.

    Returns (icov, description) or (None, reason) when there are too few fiducial
    sims for the vector length; the caller then falls back to something cruder and
    must say so."""
    n, p = z_fid.shape
    if n <= p + HARTLAP_MARGIN:
        return None, f"only {n} fiducial sims for {p} features (need > {p + HARTLAP_MARGIN})"
    cov = np.cov(z_fid, rowvar=False)
    factor = (n - p - 2) / (n - 1)
    note = f"{n} fiducial sims, Hartlap factor {factor:.2f}"
    if n < 2 * p:
        note += f" (n < 2p: covariance noisy; shorten the vector or add fiducial sims)"
    return factor * np.linalg.inv(cov), note
