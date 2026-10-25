#!/usr/bin/env python3
"""Do Galaxy Zoo mergers prefer high dark-matter density? Merger fraction vs kappa.

  python mergers_vs_density.py --map data.npz --catalog gz_desi.parquet \
      --ra-col ra --dec-col dec --merger-col merging_merger_fraction \
      [--z-col redshift --zmin 0.1 --zmax 0.5] [--bin 0] [--smoothing 20] \
      [--quantiles 5] [--threshold 0.5] [--null-map bmode.npz] --out results/

Statistic: mean merger vote fraction (or fraction above --threshold) in kappa
quantile bins, and Delta = top bin minus bottom bin.
Errors: delete-one jackknife over ~50 deg^2 sky patches (galaxies and kappa are
spatially correlated, so naive per-galaxy errors are far too small).
Nulls:
  shuffle   permute merger values among the same galaxies. Positions unchanged,
            so it tests "mergers vs. galaxies in general"; p-value from N shuffles.
  null-map  rerun on a map with no lensing signal (B-mode or rotated map): any
            Delta there is a systematic, not dark matter.

Use FRACTIONS, never counts: all galaxy types crowd into high-kappa regions.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import healpy as hp
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from contracts import load_map  # noqa: E402
from summary_stats import erode_mask, smooth  # noqa: E402


def read_catalog(path, cols):
    p = str(path)
    if p.endswith(".parquet"):
        import pandas as pd
        df = pd.read_parquet(p, columns=[c for c in cols if c])
        return {c: df[c].to_numpy() for c in cols if c}
    import pandas as pd
    df = pd.read_csv(p, usecols=[c for c in cols if c])
    return {c: df[c].to_numpy() for c in cols if c}


def kappa_at(m, region, ra, dec):
    nside = hp.npix2nside(m.size)
    pix = hp.ang2pix(nside, ra, dec, lonlat=True)  # degrees
    inside = region[pix]
    return m[pix], inside


def binned(kv, val, q):
    edges = np.quantile(kv, np.linspace(0, 1, q + 1))
    idx = np.clip(np.searchsorted(edges, kv, side="right") - 1, 0, q - 1)
    means = np.array([val[idx == i].mean() for i in range(q)])
    kmeans = np.array([kv[idx == i].mean() for i in range(q)])
    counts = np.bincount(idx, minlength=q)
    return means, kmeans, counts, idx


def analyse(m, region, ra, dec, val, q, patch_nside=8, n_shuffle=500, seed=0):
    kv, inside = kappa_at(m, region, ra, dec)
    kv, val, ra_i, dec_i = kv[inside], val[inside], ra[inside], dec[inside]
    means, kmeans, counts, idx = binned(kv, val, q)
    delta = means[-1] - means[0]

    patches = hp.ang2pix(patch_nside, ra_i, dec_i, lonlat=True)
    ups = np.unique(patches)
    jk_means = []
    for p in ups:
        keep = patches != p
        jm, *_ = binned(kv[keep], val[keep], q)
        jk_means.append(jm)
    jk_means = np.array(jk_means)
    n = len(ups)
    jk_err = np.sqrt((n - 1) / n * ((jk_means - jk_means.mean(0)) ** 2).sum(0))
    jk_delta = jk_means[:, -1] - jk_means[:, 0]
    delta_err = float(np.sqrt((n - 1) / n * ((jk_delta - jk_delta.mean()) ** 2).sum()))

    rng = np.random.default_rng(seed)
    null = np.empty(n_shuffle)
    for i in range(n_shuffle):
        sv = rng.permutation(val)
        null[i] = sv[idx == q - 1].mean() - sv[idx == 0].mean()
    p_shuffle = float((np.abs(null) >= abs(delta)).mean())

    return {
        "n_galaxies": int(inside.sum()),
        "n_patches": int(n),
        "kappa_bin_mean": kmeans.tolist(),
        "merger_mean": means.tolist(),
        "merger_err_jackknife": jk_err.tolist(),
        "galaxies_per_bin": counts.tolist(),
        "delta_top_minus_bottom": float(delta),
        "delta_err_jackknife": delta_err,
        "delta_significance_sigma": float(delta / delta_err) if delta_err > 0 else None,
        "shuffle_null_p_value": p_shuffle,
        "shuffle_null_std": float(null.std()),
    }


def verdict(r):
    s = r["delta_significance_sigma"] or 0
    if abs(s) < 2:
        return ("No significant difference in merger fraction between low- and high-density regions at this "
                "sensitivity. Projection along the line of sight and the redshift mismatch dilute the signal; "
                "a null here is a legitimate result.")
    sign = "higher" if s > 0 else "lower"
    return (f"Merger fraction is {sign} in the highest-density part of the map than the lowest "
            f"({s:.1f} sigma, jackknife), consistent with mergers preferring dense environments. Correlation, "
            "not causation; check the null-map result before presenting.")


def _main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--map", required=True)
    ap.add_argument("--catalog", required=True)
    ap.add_argument("--ra-col", default="ra")
    ap.add_argument("--dec-col", default="dec")
    ap.add_argument("--merger-col", required=True, help="e.g. merging_merger_fraction (check the header)")
    ap.add_argument("--z-col", default=None)
    ap.add_argument("--zmin", type=float, default=None)
    ap.add_argument("--zmax", type=float, default=None)
    ap.add_argument("--bin", type=int, default=0, help="tomographic bin of the map to use")
    ap.add_argument("--smoothing", type=float, default=20.0, help="arcmin; raw kappa is noise-dominated")
    ap.add_argument("--quantiles", type=int, default=5)
    ap.add_argument("--threshold", type=float, default=None, help="use 1[vote >= t] instead of the vote fraction")
    ap.add_argument("--null-map", default=None)
    ap.add_argument("--n-shuffle", type=int, default=500)
    ap.add_argument("--out", default="results")
    a = ap.parse_args(argv)

    k, mask, meta = load_map(a.map)
    if meta.get("coord", "C") != "C":
        sys.exit("map is not in equatorial (C) coordinates; Galaxy Zoo RA/Dec are equatorial. Rotate first.")
    region = erode_mask(mask, a.smoothing)
    ms = smooth(k[a.bin], mask, a.smoothing)
    cat = read_catalog(a.catalog, [a.ra_col, a.dec_col, a.merger_col, a.z_col])
    ra, dec, val = (np.asarray(cat[c], float) for c in (a.ra_col, a.dec_col, a.merger_col))
    sel = np.isfinite(ra) & np.isfinite(dec) & np.isfinite(val)
    if a.z_col:
        z = np.asarray(cat[a.z_col], float)
        sel &= np.isfinite(z)
        if a.zmin is not None:
            sel &= z >= a.zmin
        if a.zmax is not None:
            sel &= z < a.zmax
    ra, dec, val = ra[sel], dec[sel], val[sel]
    if a.threshold is not None:
        val = (val >= a.threshold).astype(float)
    if ra.max() <= 2 * np.pi + 1e-6 and np.abs(dec).max() <= np.pi / 2 + 1e-6:
        print("warning: RA/Dec look like radians; ang2pix here expects degrees")

    res = {"settings": vars(a), "main": analyse(ms, region, ra, dec, val, a.quantiles, n_shuffle=a.n_shuffle)}
    if res["main"]["n_galaxies"] < 1000:
        print(f"warning: only {res['main']['n_galaxies']} galaxies inside the footprint; check coordinates/footprint overlap")
    if a.null_map:
        kn, mn, _ = load_map(a.null_map)
        msn = smooth(kn[a.bin], mn, a.smoothing)
        res["null_map"] = analyse(msn, erode_mask(mn, a.smoothing), ra, dec, val, a.quantiles, n_shuffle=50)
    res["verdict"] = verdict(res["main"])

    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "mergers_vs_density.json").write_text(json.dumps(res, indent=1, default=str))

    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    fig, ax = plt.subplots(figsize=(5.5, 4))
    r = res["main"]
    ax.errorbar(r["kappa_bin_mean"], r["merger_mean"], yerr=r["merger_err_jackknife"], fmt="o-", label="DES mass map")
    if "null_map" in res:
        rn = res["null_map"]
        ax.errorbar(rn["kappa_bin_mean"], rn["merger_mean"], yerr=rn["merger_err_jackknife"], fmt="s--", alpha=0.6, label="null map")
    ax.set_xlabel(f"smoothed convergence kappa ({a.smoothing:g}' smoothing)")
    ax.set_ylabel("mean merger " + ("fraction" if a.threshold is not None else "vote fraction"))
    ax.legend(fontsize=8)
    fig.tight_layout()
    fig.savefig(out / "mergers_vs_density.png", dpi=150)
    print(json.dumps({k: r[k] for k in ("n_galaxies", "delta_top_minus_bottom", "delta_err_jackknife",
                                         "delta_significance_sigma", "shuffle_null_p_value")}, indent=1))
    print(res["verdict"])


if __name__ == "__main__":
    _main()
