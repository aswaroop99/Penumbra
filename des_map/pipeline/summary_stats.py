#!/usr/bin/env python3
"""Summary statistics for convergence maps: peak counts + binned power spectrum.

The SAME config must process real data and every simulation. Bin edges and the
reference noise levels are computed once from fiducial sims (`make-config`) and
then frozen; recomputing them per map would change what each vector entry means.

Vector layout (per tomographic bin, in order):
  for each smoothing scale s:  peak counts in S/N bins  (S/N = kappa_s / sigma_ref[bin][s])
  log10 of the band-averaged pseudo-C_ell of the unsmoothed map (auto-spectra;
  optional cross-spectra between bins with "cross": true)

CLI:
  python summary_stats.py make-config --maps 'fid_*.npz' --out cfg.json [--smoothing 5 10 20]
  python summary_stats.py one   --map data.npz --config cfg.json --out summary.json
  python summary_stats.py batch --maps 'sims/*.npz' --config cfg.json --out train.npz [--workers 4]

`batch` reads the true parameters from each map's meta["theta"] = {"Omega_m":..,"S8":..}
(toy_sims.py and forward_model.py write this) and saves x, theta, names, files.
"""
from __future__ import annotations

import argparse
import glob
import json
import sys
from multiprocessing import Pool
from pathlib import Path

import healpy as hp
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from contracts import load_map, validate_summary  # noqa: E402

ARCMIN = np.pi / (180 * 60)
DEFAULT_SNR_EDGES = [-1.0, 0.0, 1.0, 2.0, 3.0, 4.0, 1e9]  # 6 bins; last = "above 4"


# ---------------------------------------------------------------------- primitives
def demean(m, mask):
    out = np.where(mask, m, 0.0).astype(np.float64)
    out[mask] -= out[mask].mean()
    return out


def smooth(m, mask, fwhm_arcmin):
    """Zero-fill outside mask, Gaussian-smooth. Apply identically to data and sims."""
    m = demean(m, mask)
    if fwhm_arcmin <= 0:
        return m
    return hp.smoothing(m, fwhm=fwhm_arcmin * ARCMIN, use_pixel_weights=False, iter=0)


def erode_mask(mask, fwhm_arcmin, thresh=0.98):
    """Drop pixels near the mask edge, where smoothing mixes in the zero-fill."""
    if fwhm_arcmin <= 0:
        return mask.copy()
    s = hp.smoothing(mask.astype(float), fwhm=2 * fwhm_arcmin * ARCMIN, iter=0)
    return mask & (s > thresh)


def find_peaks(m, region):
    """Indices of pixels in `region` higher than all 8 neighbours."""
    nside = hp.npix2nside(m.size)
    idx = np.flatnonzero(region)
    nb = hp.get_all_neighbours(nside, idx)  # (8, n), -1 where missing
    vals = np.where(nb >= 0, m[np.clip(nb, 0, None)], -np.inf)
    return idx[m[idx] > vals.max(axis=0)]


def peak_counts(m_smoothed, region, sigma_ref, snr_edges):
    pk = find_peaks(m_smoothed, region)
    counts, _ = np.histogram(m_smoothed[pk] / sigma_ref, bins=snr_edges)
    return counts.astype(float)


def pseudo_cl(m1, mask, ell_edges, m2=None):
    """Band-averaged pseudo-C_ell with a simple 1/f_sky correction.
    Fine for SBI (sims get the same treatment); not a theory-comparable C_ell."""
    fsky = mask.mean()
    lmax = int(ell_edges[-1])
    a = demean(m1, mask)
    b = None if m2 is None else demean(m2, mask)
    cl = hp.anafast(a, b, lmax=lmax, use_pixel_weights=False, iter=0) / fsky
    ell = np.arange(cl.size)
    out = []
    for lo, hi in zip(ell_edges[:-1], ell_edges[1:]):
        sel = (ell >= lo) & (ell < hi)
        out.append(cl[sel].mean())
    return np.array(out)


# ------------------------------------------------------------------------ summary
def compute_summary(kappa, mask, cfg):
    """kappa: (nbins, npix). Returns (vector, names)."""
    kappa = np.atleast_2d(kappa)
    nside = hp.npix2nside(mask.size)
    if nside != cfg["nside"]:
        raise ValueError(f"map nside {nside} != config nside {cfg['nside']} - ud_grade first")
    if kappa.shape[0] != cfg["nbins"]:
        raise ValueError(f"map has {kappa.shape[0]} bins, config expects {cfg['nbins']}")
    vec, names = [], []
    edges = np.array(cfg["snr_edges"])
    ell_edges = np.array(cfg["ell_edges"])
    regions = {s: erode_mask(mask, s) for s in cfg["smoothing_arcmin"]}
    for b in range(cfg["nbins"]):
        for j, s in enumerate(cfg["smoothing_arcmin"]):
            ms = smooth(kappa[b], mask, s)
            c = peak_counts(ms, regions[s], cfg["sigma_ref"][b][j], edges)
            vec.extend(c)
            names.extend(f"bin{b}_peaks_{s}arcmin_snr[{lo:g},{hi:g})" for lo, hi in zip(edges[:-1], edges[1:]))
        cl = pseudo_cl(kappa[b], mask, ell_edges)
        vec.extend(np.log10(np.clip(cl, 1e-30, None)))
        names.extend(f"bin{b}_log10cl_ell[{int(lo)},{int(hi)})" for lo, hi in zip(ell_edges[:-1], ell_edges[1:]))
    if cfg.get("cross") and cfg["nbins"] > 1:
        for b1 in range(cfg["nbins"]):
            for b2 in range(b1 + 1, cfg["nbins"]):
                cl = pseudo_cl(kappa[b1], mask, ell_edges, kappa[b2])
                vec.extend(np.sign(cl) * np.log10(1 + np.abs(cl) * 1e10))  # cross can be negative
                names.extend(f"cross{b1}{b2}_slog_cl_ell[{int(lo)},{int(hi)})" for lo, hi in zip(ell_edges[:-1], ell_edges[1:]))
    vec = np.asarray(vec, dtype=float)
    validate_summary(vec, names, cfg.get("length"))
    return vec, names


def make_config(fid_paths, smoothing_arcmin=(5.0, 10.0, 20.0), n_ell=8, ell_min=30, snr_edges=None, cross=False):
    """Freeze nside, bins, reference noise levels and bin edges from fiducial maps."""
    kappa0, mask0, meta0 = load_map(fid_paths[0])
    nside, nbins = meta0["nside"], kappa0.shape[0]
    pix_arcmin = hp.nside2resol(nside, arcmin=True)
    if min(smoothing_arcmin) < 2 * pix_arcmin:
        print(f"warning: smoothing {min(smoothing_arcmin)}' is below 2x the {pix_arcmin:.1f}' pixel size; "
              "those scales add no information", file=sys.stderr)
    lmax = min(3 * nside - 1, 2048)
    ell_edges = np.unique(np.round(np.geomspace(ell_min, lmax, n_ell + 1)).astype(int)).tolist()
    sig = np.zeros((nbins, len(smoothing_arcmin)))
    for p in fid_paths:
        k, mk, _ = load_map(p)
        for b in range(nbins):
            for j, s in enumerate(smoothing_arcmin):
                ms = smooth(k[b], mk, s)
                sig[b, j] += ms[erode_mask(mk, s)].std() / len(fid_paths)
    cfg = {
        "nside": nside,
        "nbins": nbins,
        "smoothing_arcmin": list(map(float, smoothing_arcmin)),
        "sigma_ref": sig.tolist(),
        "snr_edges": list(snr_edges or DEFAULT_SNR_EDGES),
        "ell_edges": ell_edges,
        "cross": bool(cross),
        "made_from": [str(p) for p in fid_paths],
    }
    v, names = compute_summary(kappa0, mask0, cfg)
    cfg["length"], cfg["names"] = int(v.size), names
    return cfg


# ----------------------------------------------------------------------------- CLI
def _one(args):
    path, cfg = args
    k, m, meta = load_map(path)
    v, _ = compute_summary(k, m, cfg)
    th = meta.get("theta", {})
    return v, [th.get("Omega_m", np.nan), th.get("S8", np.nan)]


def _main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("make-config")
    c.add_argument("--maps", nargs="+", required=True, help="fiducial-cosmology maps (globs ok)")
    c.add_argument("--smoothing", type=float, nargs="+", default=[5.0, 10.0, 20.0])
    c.add_argument("--n-ell", type=int, default=8)
    c.add_argument("--cross", action="store_true")
    c.add_argument("--out", required=True)
    o = sub.add_parser("one")
    o.add_argument("--map", required=True)
    o.add_argument("--config", required=True)
    o.add_argument("--out", required=True)
    b = sub.add_parser("batch")
    b.add_argument("--maps", nargs="+", required=True)
    b.add_argument("--config", required=True)
    b.add_argument("--out", required=True)
    b.add_argument("--workers", type=int, default=1)
    a = ap.parse_args(argv)

    def expand(pats):
        return sorted({p for pat in pats for p in (glob.glob(pat) or [pat])})

    if a.cmd == "make-config":
        paths = expand(a.maps)
        cfg = make_config(paths, a.smoothing, a.n_ell, cross=a.cross)
        Path(a.out).write_text(json.dumps(cfg, indent=1))
        print(f"config: {cfg['length']} features, sigma_ref={np.round(cfg['sigma_ref'], 5).tolist()}")
    elif a.cmd == "one":
        cfg = json.loads(Path(a.config).read_text())
        k, m, meta = load_map(a.map)
        v, names = compute_summary(k, m, cfg)
        Path(a.out).write_text(json.dumps({"names": names, "values": v.tolist(), "map": a.map}))
        print(f"wrote {v.size}-entry summary to {a.out}")
    else:
        cfg = json.loads(Path(a.config).read_text())
        paths = expand(a.maps)
        jobs = [(p, cfg) for p in paths]
        if a.workers > 1:
            with Pool(a.workers) as pool:
                res = pool.map(_one, jobs)
        else:
            res = [_one(j) for j in jobs]
        x = np.array([r[0] for r in res])
        theta = np.array([r[1] for r in res])
        np.savez(a.out, x=x, theta=theta, names=np.array(cfg["names"]), files=np.array(paths))
        print(f"wrote {x.shape[0]} summaries x {x.shape[1]} features to {a.out}")


if __name__ == "__main__":
    _main()
