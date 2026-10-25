#!/usr/bin/env python3
"""Make a simulated convergence map look like the survey data.

Survey-matching steps (keep them identical to how the data map was made):
  1. ud_grade to the analysis nside
  2. rotate the full-sky sim so a different patch lands on the survey footprint
     (several disjoint footprints per full-sky sim = more training data, free)
  3. add per-pixel Gaussian shape noise: sigma_pix = sigma_e / sqrt(n_eff * A_pix)
  4. zero everything outside the survey mask, subtract in-mask mean

Approximations (state them in the write-up): white Gaussian noise ignores the
noise correlations that Kaiser-Squires + masking introduce, and the sim n(z)
must match the data's redshift bins. If the data's B-mode map or randomly
rotated shear maps are available, measure the noise level from them instead.

CLI:
  python forward_model.py --sim cosmo_0001.npy --mask-from data.npz \
      --omega-m 0.31 --s8 0.79 --rotations 4 --out-prefix sims/cosmo_0001
  (sim: .npy/.npz with (nbins, npix) or (npix,), or a HEALPix .fits)
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import healpy as hp
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from contracts import load_map, save_map  # noqa: E402

DES_Y3_SIGMA_E = 0.26   # per-component shape noise, approx.; verify (Gatti+2021, arXiv:2011.03408)
DES_Y3_N_EFF = 5.6      # effective sources per arcmin^2, all bins combined, approx.; verify


def pixel_noise_sigma(nside, sigma_e=DES_Y3_SIGMA_E, n_eff=DES_Y3_N_EFF):
    a_pix = hp.nside2pixarea(nside, degrees=True) * 3600.0  # arcmin^2
    return sigma_e / np.sqrt(n_eff * a_pix)


def _rotator(rot):
    return hp.Rotator(rot=list(rot), deg=True)


def rotated_footprint(mask, rot):
    """Where on the sky the footprint samples the sim under rotation `rot`."""
    m = _rotator(rot).rotate_map_pixel(mask.astype(float))
    return m > 0.5


def find_disjoint_rotations(mask, n_max=4, step_deg=20):
    """Greedy search for rotations whose sampled patches don't overlap."""
    taken = np.zeros_like(mask, dtype=bool)
    chosen = []
    cands = [(float(lon), float(lat), float(psi)) for psi in (0, 180) for lat in (0, 60, -60, 90)
             for lon in np.arange(0, 360, step_deg)]
    for rot in cands:
        fp = mask if rot == (0.0, 0.0, 0.0) else rotated_footprint(mask, rot)
        if fp.sum() < 0.9 * mask.sum():
            continue
        if not np.any(fp & taken):
            chosen.append(rot)
            taken |= fp
        if len(chosen) == n_max:
            return chosen
    return chosen


def rotate_sim(m, rot, method="pixel"):
    """Rotate a sim so the patch at rotated_footprint(mask, rot) lands on `mask`.
    'alm' is exact for band-limited maps but slower; 'pixel' interpolates."""
    if rot == (0.0, 0.0, 0.0):
        return m
    r = hp.Rotator(rot=list(rot), deg=True, inv=True)
    return r.rotate_map_alms(m) if method == "alm" else r.rotate_map_pixel(m)


def survey_map(sim, mask, noise_sigma, rot=(0.0, 0.0, 0.0), seed=None, method="pixel"):
    """sim: (nbins, npix) at the mask's nside. noise_sigma: float or per-bin list."""
    sim = np.atleast_2d(sim).astype(np.float64)
    rng = np.random.default_rng(seed)
    sig = np.broadcast_to(np.asarray(noise_sigma, dtype=float), (sim.shape[0],))
    out = np.zeros_like(sim)
    for b in range(sim.shape[0]):
        m = rotate_sim(sim[b], rot, method)
        m = m + rng.normal(0.0, sig[b], size=m.size)
        m = np.where(mask, m, 0.0)
        m[mask] -= m[mask].mean()
        out[b] = m
    return out


def load_sim(path, nside_out):
    p = str(path)
    if p.endswith(".fits"):
        m = np.atleast_2d(hp.read_map(p, field=None))
    else:
        d = np.load(p)
        m = np.atleast_2d(d[d.files[0]] if hasattr(d, "files") else d)
    if hp.npix2nside(m.shape[-1]) != nside_out:
        m = np.array([hp.ud_grade(b, nside_out) for b in m])
    return m


def _main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--sim", required=True)
    ap.add_argument("--mask-from", required=True, help="map contract .npz whose mask/nside to match (the data)")
    ap.add_argument("--omega-m", type=float, required=True)
    ap.add_argument("--s8", type=float, required=True)
    ap.add_argument("--rotations", type=int, default=4)
    ap.add_argument("--noise-sigma", type=float, nargs="+", default=None,
                    help="per-pixel noise per bin; default from DES Y3 sigma_e, n_eff")
    ap.add_argument("--method", choices=["pixel", "alm"], default="pixel")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--out-prefix", required=True)
    a = ap.parse_args(argv)

    _, mask, meta = load_map(a.mask_from)
    nside = meta["nside"]
    sim = load_sim(a.sim, nside)
    sig = a.noise_sigma or pixel_noise_sigma(nside)
    rots = find_disjoint_rotations(mask, a.rotations)
    Path(a.out_prefix).parent.mkdir(parents=True, exist_ok=True)
    for i, rot in enumerate(rots):
        k = survey_map(sim, mask, sig, rot, seed=a.seed * 1000 + i, method=a.method)
        out = f"{a.out_prefix}_r{i}.npz"
        save_map(out, k.squeeze(), mask, {
            "source": f"sim:{a.sim}", "rotation": rot, "bins": k.shape[0],
            "theta": {"Omega_m": a.omega_m, "S8": a.s8}, "noise_sigma": np.ravel(sig).tolist(),
            "coord": meta.get("coord", "C"),
        })
        print("wrote", out)
    if len(rots) < a.rotations:
        print(f"note: only {len(rots)} disjoint footprints fit on the sphere")


if __name__ == "__main__":
    _main()
