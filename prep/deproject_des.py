"""Rough tomographic deprojection of the DES Y3 KaRMMa maps into a few broad lens slices.

Each DES map is projected mass toward one source bin:
    kappa_i(theta) = sum_l Q[i, l] * delta_l(theta)
where delta_l is the mean matter overdensity in lens slice l and Q[i, l] is the lensing
weight of source bin i integrated over slice l. With 4 bins and 2-4 broad slices this
can be inverted, but only with a prior. We use a Wiener-style estimator:
    delta_hat = (Q^T N^-1 Q + S^-1)^-1 Q^T N^-1 kappa
  N = posterior noise covariance between bins (spread across the 100 KaRMMa samples)
  S = signal variance per slice, fitted so Q S Q^T matches the map covariance
It's applied to every posterior sample, giving a mean and std per slice.

Prints the "resolution matrix" R = W Q: row k shows how much of each true slice
leaks into estimated slice k. Off-diagonal terms are the depth smearing.

Outputs (does not touch the viewer's main manifest):
  data/deproj/slice{l}.png / .f16.bin       mean delta per slice (diverging colormap)
  data/deproj/slice{l}_snr.f16.bin          mean / posterior std
  data/deproj/manifest_deproj.json
  data/deproj/diagnostics.png               kernels, Q, resolution matrix, maps

Usage:
  .venv/bin/python prep/deproject_des.py
  .venv/bin/python prep/deproject_des.py --edges 0 0.3 0.55 1.4 --smoothing 30
  .venv/bin/python prep/deproject_des.py --nz path/to/des_y3_2pt.fits   # official n(z)
"""
import argparse
import json
import os
import sys

import healpy as hp
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from astropy.cosmology import Planck18 as COSMO
from matplotlib import colormaps
from PIL import Image
from scipy.optimize import nnls

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from export_des import NSIDE, ROOT, find_peaks, load_samples  # noqa: E402

OUT = os.path.join(ROOT, "data", "deproj")
C_KMS = 299792.458

# Approximate DES Y3 source n(z) (Myles+2021): means ~0.34, 0.52, 0.74, 0.94.
# Modelled as Gaussians; replaced by the official n(z) when --nz is given.
APPROX_NZ = [(0.34, 0.12), (0.52, 0.13), (0.74, 0.13), (0.94, 0.17)]


def load_nz(path, z):
    if path:
        from astropy.io import fits
        with fits.open(path) as f:
            t = f["nz_source"].data
            zmid = t["Z_MID"]
            nz = np.array([np.interp(z, zmid, t[f"BIN{i}"], left=0, right=0) for i in range(1, 5)])
        src = f"official DES Y3 n(z) from {os.path.basename(path)}"
    else:
        nz = np.array([np.exp(-0.5 * ((z - m) / s) ** 2) for m, s in APPROX_NZ]) * (z > 0)
        src = "approximate Gaussian n(z) (means 0.34/0.52/0.74/0.94)"
    nz /= np.trapezoid(nz, z, axis=1)[:, None]
    return nz, src


def lensing_kernels(z, nz):
    """q_i(z) per unit z, so kappa_i = int q_i(z) delta(z) dz. Units of chi: Mpc."""
    chi = COSMO.comoving_distance(z).value
    h0 = COSMO.H0.value
    hz = COSMO.H(z).value
    pref = 1.5 * COSMO.Om0 * (h0 / C_KMS) ** 2 * (1 + z) * chi
    q = np.zeros_like(nz)
    for i in range(nz.shape[0]):
        for k in range(1, len(z)):
            zs, ns = z[k:], nz[i, k:]
            q[i, k] = pref[k] * np.trapezoid(ns * (chi[k:] - chi[k]) / chi[k:], zs)
    return q * C_KMS / hz    # dchi/dz = c / H(z)


def slice_matrix(z, q, edges):
    Q = np.zeros((q.shape[0], len(edges) - 1))
    for l, (a, b) in enumerate(zip(edges[:-1], edges[1:])):
        sel = (z >= a) & (z <= b)
        Q[:, l] = np.trapezoid(q[:, sel], z[sel], axis=1)
    return Q


def smooth_all(stack, mask, fwhm_arcmin):
    """Mask-aware Gaussian smoothing of every (sample, bin) map. Returns in-mask values."""
    fwhm = np.radians(fwhm_arcmin / 60)
    den = hp.smoothing(mask.astype(float), fwhm=fwhm)[mask]
    out = np.empty_like(stack)
    full = np.zeros(hp.nside2npix(NSIDE))
    n_s, n_b, _ = stack.shape
    for s in range(n_s):
        for b in range(n_b):
            full[:] = 0
            full[mask] = stack[s, b]
            out[s, b] = hp.smoothing(full, fwhm=fwhm)[mask] / np.maximum(den, 1e-3)
        if s % 20 == 0:
            print(f"  smoothed sample {s}/{n_s}", flush=True)
    return out


def to_grid(vals, mask, args, bounds):
    """In-mask HEALPix values -> plate-carree grid, same convention as export_des.py."""
    w = int(round((bounds["ra_max"] - bounds["ra_min"]) / args.res))
    h = int(round((bounds["dec_max"] - bounds["dec_min"]) / args.res))
    ras = bounds["ra_max"] - (np.arange(w) + 0.5) * args.res
    decs = bounds["dec_max"] - (np.arange(h) + 0.5) * args.res
    RA, DEC = np.meshgrid(ras, decs)
    th, ph = np.radians(90 - DEC).ravel(), np.radians(RA % 360).ravel()
    m = hp.get_interp_val(mask.astype(float), th, ph)
    inside = m > 0.5
    full = np.zeros(hp.nside2npix(NSIDE)); full[mask] = vals
    grid = np.full(h * w, np.nan, dtype=np.float32)
    grid[inside] = hp.get_interp_val(full, th[inside], ph[inside]) / m[inside]
    return grid.reshape(h, w)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--edges", type=float, nargs="+", default=[0.0, 0.3, 0.55, 1.4],
                    help="lens slice redshift edges")
    ap.add_argument("--smoothing", type=float, default=30.0, help="FWHM arcmin before deprojecting")
    ap.add_argument("--res", type=float, default=0.08, help="output pixel size, degrees")
    ap.add_argument("--nz", default=None, help="DES Y3 2pt FITS with an nz_source extension")
    ap.add_argument("--samples", type=int, default=100, help="use the first N posterior samples")
    args = ap.parse_args()
    os.makedirs(OUT, exist_ok=True)

    # --- Projection matrix -------------------------------------------------
    z = np.linspace(0, 2.5, 501)
    nz, nz_src = load_nz(args.nz, z)
    q = lensing_kernels(z, nz)
    edges = np.array(args.edges)
    Q = slice_matrix(z, q, edges)
    L = Q.shape[1]
    print(f"n(z): {nz_src}")
    print("Q (rows = source bins, cols = lens slices):\n", np.round(Q, 4))
    print(f"condition number of Q: {np.linalg.cond(Q):.1f}")

    # --- Maps --------------------------------------------------------------
    mask, stack = load_samples()
    stack = stack[: args.samples]
    print(f"smoothing {stack.shape[0]}x{stack.shape[1]} maps at {args.smoothing}'")
    sm = smooth_all(stack, mask, args.smoothing)            # (S, 4, P)

    # N: posterior noise covariance between bins, averaged over pixels.
    resid = sm - sm.mean(axis=0, keepdims=True)
    N = np.einsum("sip,sjp->ij", resid, resid) / (resid.shape[0] * resid.shape[2])
    # C: covariance of one sample across pixels ~ signal covariance (posterior draws look like the prior).
    cen = sm - sm.mean(axis=2, keepdims=True)
    C = np.einsum("sip,sjp->ij", cen, cen) / (cen.shape[0] * cen.shape[2])
    # Fit S >= 0 so that Q diag(S) Q^T ~ C (assumes broad slices are roughly independent).
    iu = np.triu_indices(4)
    A = np.stack([np.outer(Q[:, l], Q[:, l])[iu] for l in range(L)], axis=1)
    S, _ = nnls(A, C[iu])
    S = np.maximum(S, 1e-12)
    print("bin noise std:", np.round(np.sqrt(np.diag(N)), 5), " bin total std:", np.round(np.sqrt(np.diag(C)), 5))
    print("fitted slice delta std:", np.round(np.sqrt(S), 4))

    Ninv = np.linalg.inv(N)
    W = np.linalg.solve(Q.T @ Ninv @ Q + np.diag(1 / S), Q.T @ Ninv)   # (L, 4)
    R = W @ Q
    print("resolution matrix R = W Q (row k: contributions of true slices to estimate k):\n", np.round(R, 2))

    d = np.einsum("li,sip->slp", W, sm)                     # (S, L, P)
    d_mean, d_std = d.mean(axis=0), d.std(axis=0)
    snr = d_mean / np.maximum(d_std, 1e-12)
    corr = np.corrcoef(d_mean)

    # --- Export ------------------------------------------------------------
    th, ph = hp.pix2ang(NSIDE, np.where(mask)[0])
    ra = np.degrees(ph); ra = np.where(ra > 180, ra - 360, ra)
    dec = 90 - np.degrees(th)
    bounds = dict(ra_min=float(np.floor(ra.min()) - 1), ra_max=float(np.ceil(ra.max()) + 1),
                  dec_min=float(np.floor(dec.min()) - 1), dec_max=float(np.ceil(dec.max()) + 1))
    slices, peaks, grids = [], [], []
    for l in range(L):
        g = to_grid(d_mean[l], mask, args, bounds)
        gs = to_grid(snr[l], mask, args, bounds)
        lim = float(np.nanpercentile(np.abs(g), 99.5))
        t = np.clip(0.5 + 0.5 * g / lim, 0, 1)
        rgba = (colormaps["RdBu_r"](np.nan_to_num(t, nan=0.5)) * 255).astype(np.uint8)
        rgba[..., 3] = np.where(np.isnan(g), 0, 255)
        Image.fromarray(rgba, "RGBA").save(os.path.join(OUT, f"slice{l}.png"), optimize=True)
        g.astype(np.float16).tofile(os.path.join(OUT, f"slice{l}.f16.bin"))
        gs.astype(np.float16).tofile(os.path.join(OUT, f"slice{l}_snr.f16.bin"))
        grids.append((g, gs))

        full = np.full(hp.nside2npix(NSIDE), -np.inf); full[mask] = d_mean[l]
        pix_index = np.full(hp.nside2npix(NSIDE), -1); pix_index[mask] = np.arange(mask.sum())
        for p in find_peaks(full, mask, 20):
            t_, p_ = hp.pix2ang(NSIDE, p)
            peaks.append(dict(slice=l, ra=round(float(np.degrees(p_)) % 360, 4),
                              dec=round(90 - float(np.degrees(t_)), 4),
                              delta=round(float(full[p]), 5), snr=round(float(snr[l, pix_index[p]]), 2)))
        zc = 0.5 * (edges[l] + edges[l + 1])
        slices.append(dict(name=f"z {edges[l]:.2f}-{edges[l+1]:.2f}", z_min=float(edges[l]),
                           z_max=float(edges[l + 1]), z_display=float(zc),
                           png=f"slice{l}.png", raw=f"slice{l}.f16.bin", snr_raw=f"slice{l}_snr.f16.bin",
                           shape=list(g.shape), vmin=-lim, vmax=lim,
                           frac_pixels_snr_gt2=round(float(np.mean(np.abs(snr[l]) > 2)), 4),
                           median_abs_snr=round(float(np.median(np.abs(snr[l]))), 3),
                           self_weight=round(float(R[l, l]), 3)))
        print(f"slice {l} ({slices[-1]['name']}): self-weight R={R[l,l]:.2f}  "
              f"median|S/N|={slices[-1]['median_abs_snr']:.2f}  |S/N|>2 in {100*slices[-1]['frac_pixels_snr_gt2']:.1f}% of pixels")
    print("pixel correlation between slice means:\n", np.round(corr, 2))

    manifest = dict(
        source="Wiener-style deprojection of DES Y3 KaRMMa kappa maps (%d posterior samples)" % stack.shape[0],
        nz=nz_src, smoothing_arcmin=args.smoothing, edges=edges.tolist(), bounds=bounds,
        convention="plate carree; column 0 = ra_max (east left), row 0 = dec_max",
        Q=np.round(Q, 6).tolist(), W=np.round(W, 4).tolist(), resolution_matrix=np.round(R, 3).tolist(),
        slice_corr=np.round(corr, 3).tolist(), slices=slices, peaks=peaks,
        note="Rough tomographic deprojection with a prior; depth resolution is a few tenths in z. "
             "Values are mean matter overdensity delta in each slice. Row k of resolution_matrix shows how "
             "much of each true slice leaks into estimate k. Not a 3D map.",
    )
    with open(os.path.join(OUT, "manifest_deproj.json"), "w") as f:
        json.dump(manifest, f, indent=1)

    # --- Diagnostics figure -------------------------------------------------
    fig = plt.figure(figsize=(16, 4 + 3.2 * L))
    gsp = fig.add_gridspec(1 + L, 3)
    ax = fig.add_subplot(gsp[0, 0])
    for i in range(4):
        ax.plot(z, q[i], label=f"source bin {i}")
    for e in edges:
        ax.axvline(e, color="k", lw=0.6, ls=":")
    ax.set(xlabel="z", ylabel="lensing weight q(z)", title="Kernels and slice edges", xlim=(0, 1.6)); ax.legend(fontsize=8)
    for k, (M, title) in enumerate([(Q / Q.max(), "Q (normalised)"), (R, "Resolution R = W Q")]):
        ax = fig.add_subplot(gsp[0, 1 + k])
        im = ax.imshow(M, cmap="viridis", vmin=0, vmax=max(1, M.max()))
        for (i, j), v in np.ndenumerate(M):
            ax.text(j, i, f"{v:.2f}", ha="center", va="center", color="w", fontsize=9)
        ax.set(title=title, xlabel="true slice", ylabel="bin" if k == 0 else "estimated slice")
        fig.colorbar(im, ax=ax, shrink=0.8)
    ext = [bounds["ra_max"], bounds["ra_min"], bounds["dec_min"], bounds["dec_max"]]
    for l, (g, gs) in enumerate(grids):
        lim = slices[l]["vmax"]
        ax = fig.add_subplot(gsp[1 + l, 0:2])
        im = ax.imshow(g, cmap="RdBu_r", vmin=-lim, vmax=lim, extent=ext, aspect="auto")
        ax.set(title=f"slice {slices[l]['name']}: mean delta", xlabel="RA", ylabel="Dec"); fig.colorbar(im, ax=ax)
        ax = fig.add_subplot(gsp[1 + l, 2])
        ax.hist(np.abs(snr[l]), bins=60, range=(0, 5), color="C%d" % l)
        ax.set(title=f"|S/N| per pixel (median {slices[l]['median_abs_snr']:.2f})", xlabel="|mean / std|")
    fig.tight_layout()
    fig.savefig(os.path.join(OUT, "diagnostics.png"), dpi=90)
    print(f"wrote {L} slices + diagnostics to {OUT}")


if __name__ == "__main__":
    main()
