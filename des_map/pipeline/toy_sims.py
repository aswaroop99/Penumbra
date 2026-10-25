#!/usr/bin/env python3
"""Toy universe: lognormal convergence maps with known (Omega_m, S8).

NOT physics. The power-spectrum amplitude grows with S8, its slope and the
lognormal skewness depend on Omega_m, so both parameters are recoverable and
the whole pipeline (stats -> SBI -> Planck comparison -> viewer) can be built
and tested end to end before real data or CosmoGrid downloads arrive.

Writes: sim_XXXX.npz (prior draws), fid_XXX.npz (fiducial cosmology),
        obs.npz (one held-out "observation", truth stored in meta)

  python toy_sims.py --n 300 --n-fid 20 --nside 128 --bins 1 --out toy/
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import healpy as hp
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from contracts import des_like_mask, save_map  # noqa: E402
from forward_model import pixel_noise_sigma, survey_map  # noqa: E402

PRIOR = {"Omega_m": (0.15, 0.45), "S8": (0.60, 0.95)}
FIDUCIAL = {"Omega_m": 0.31, "S8": 0.78}
TRUTH_OBS = {"Omega_m": 0.29, "S8": 0.76}


def toy_kappa(om, s8, nside, nbins=1, seed=0):
    rng_seed = int(seed)
    ell = np.arange(3 * nside)
    out = []
    for b in range(nbins):
        depth = 1.0 + 0.5 * b  # deeper bins: more signal
        sigma_k = 0.012 * depth * (s8 / 0.78) ** 1.5
        lam = 0.03 * depth * (om / 0.3) ** -1.0  # lognormal shift: smaller -> more skewed
        slope = 1.2 + 2.0 * (om - 0.3)
        cl = (ell + 10.0) ** (-slope) * np.exp(-((ell / (2.0 * nside)) ** 2))
        cl[:2] = 0
        var_g = np.log(1 + (sigma_k / lam) ** 2)
        cl *= var_g / np.sum((2 * ell + 1) * cl / (4 * np.pi))
        np.random.seed(rng_seed + 7919 * b)
        g = hp.synfast(cl, nside, new=True)
        g *= np.sqrt(var_g) / g.std()
        out.append(lam * (np.exp(g - var_g / 2) - 1))
    return np.array(out)


def _main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--n", type=int, default=300)
    ap.add_argument("--n-fid", type=int, default=20)
    ap.add_argument("--nside", type=int, default=128)
    ap.add_argument("--bins", type=int, default=1)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--out", default="toy")
    a = ap.parse_args(argv)

    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    mask = des_like_mask(a.nside)
    sig = pixel_noise_sigma(a.nside)
    rng = np.random.default_rng(a.seed)

    def write(path, om, s8, seed):
        k = toy_kappa(om, s8, a.nside, a.bins, seed)
        k = survey_map(k, mask, sig, seed=seed + 1)
        save_map(path, k.squeeze(), mask, {"source": "toy_sims (not physics)", "bins": a.bins,
                                            "theta": {"Omega_m": float(om), "S8": float(s8)}})

    for i in range(a.n):
        om = rng.uniform(*PRIOR["Omega_m"])
        s8 = rng.uniform(*PRIOR["S8"])
        write(out / f"sim_{i:04d}.npz", om, s8, a.seed * 100000 + i)
    for i in range(a.n_fid):
        write(out / f"fid_{i:03d}.npz", FIDUCIAL["Omega_m"], FIDUCIAL["S8"], a.seed * 100000 + 50000 + i)
    write(out / "obs.npz", TRUTH_OBS["Omega_m"], TRUTH_OBS["S8"], 999999)
    print(f"wrote {a.n} sims, {a.n_fid} fiducial, 1 obs (truth {TRUTH_OBS}) to {out}/")


if __name__ == "__main__":
    _main()
