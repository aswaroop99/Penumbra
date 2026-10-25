"""Rebuild a 3D dark-matter map of the COSMOS field from the public HST shear catalog.

Our simplified version of the Massey et al. (2007) idea, using the Leauthaud et al. (2007)
weak-lensing catalog:
  1. Split galaxies into source-redshift slices by photo-z.
  2. Per slice: smooth the weighted shears onto a flat grid, then Kaiser-Squires -> kappa (E mode)
     and the B mode (a noise estimate; real lensing makes no B mode).
  3. Per sky pixel, solve a regularised linear inversion
         kappa_s = sum_l Q[s, l] * delta_l + noise
     for structure on lens planes at fixed redshifts. Q is the lensing efficiency of lens
     plane l for the galaxies in source slice s. Default: a tomographic matched filter (the
     significance of a single lens at each redshift), which places the known z~0.73 cluster
     at z~0.7. METHOD=wiener gives a regularised density estimate instead, but it biases
     structures toward low redshift.
  4. Resample the cube for the viewer and write data/cosmos/.

Line-of-sight resolution of 3D lensing is poor: clumps come out stretched along redshift.
That's physics, not a bug; the viewer says so.

Usage:  .venv/bin/python prep/cosmos_3d.py
"""
import json
import os

import numpy as np
import pandas as pd
from scipy.integrate import quad
from scipy.ndimage import binary_erosion, gaussian_filter, maximum_filter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CAT = os.path.join(ROOT, "dark_universe_data/cosmos/cosmos_wl_source_catalog.csv")
OUT = os.path.join(ROOT, "data/cosmos")

OM, H = 0.315, 0.674
C_KMS = 299792.458
PIX_ARCMIN = 0.5           # analysis grid
SMOOTH_ARCMIN = 2.0        # Gaussian sigma applied to the shear field
SOURCE_EDGES = [0.2, 0.45, 0.7, 0.95, 1.2, 1.6, 2.2, 3.0]
LENS_Z = np.round(np.arange(0.1, 1.31, 0.1), 2)   # lens-plane centres, width 0.1
METHOD = os.environ.get("METHOD", "mf")  # "mf" (matched filter) or "wiener"
PRIOR_SIGMA = float(os.environ.get("PRIOR_SIGMA", 0.5))         # prior rms of smoothed delta at z=0 (Wiener regulariser)
VIEW_DEPTH, VIEW_SIDE = 128, 40                    # viewer grid: redshift cells x sky cells


def comoving(z):
    """Comoving distance in Mpc, flat LCDM."""
    f = lambda zz: 1 / np.sqrt(OM * (1 + zz) ** 3 + 1 - OM)
    return C_KMS / (100 * H) * quad(f, 0, z)[0]


def growth(z):
    a3 = (1 + z) ** 3; e2 = OM * a3 + 1 - OM
    om, ol = OM * a3 / e2, (1 - OM) / e2
    g = lambda om_, ol_: 2.5 * om_ / (om_ ** (4 / 7) - ol_ + (1 + om_ / 2) * (1 + ol_ / 70))
    return g(om, ol) / (g(OM, 1 - OM) * (1 + z))


Z_WIDTH = 0.05   # display width (sigma) of a placed lens along redshift


def place_lenses(profile, zc):
    """Matched-filter significance vs. lens redshift is very broad, so drawing it directly gives
    long tubes. Instead put each local maximum of the profile at its most likely redshift
    (parabolic refinement between planes) as a Gaussian of height = its significance."""
    out = np.zeros_like(zc)
    p = profile
    for l in range(len(p)):
        left = p[l - 1] if l > 0 else -np.inf
        right = p[l + 1] if l < len(p) - 1 else -np.inf
        if p[l] <= 0 or p[l] < left or p[l] < right:
            continue
        z_pk, h = LENS_Z[l], p[l]
        if 0 < l < len(p) - 1:
            den = left - 2 * p[l] + right
            if den < 0:
                off = 0.5 * (left - right) / den
                z_pk += off * (LENS_Z[1] - LENS_Z[0]); h = p[l] - 0.25 * (left - right) * off
        out = np.maximum(out, h * np.exp(-0.5 * ((zc - z_pk) / Z_WIDTH) ** 2))
    return out


def kaiser_squires(g1, g2):
    """Flat-sky KS on a zero-padded grid. Returns (kappa_E, kappa_B)."""
    ny, nx = g1.shape
    py, px = 2 * ny, 2 * nx
    G1 = np.fft.fft2(g1, s=(py, px)); G2 = np.fft.fft2(g2, s=(py, px))
    k1, k2 = np.meshgrid(np.fft.fftfreq(px), np.fft.fftfreq(py))
    ksq = k1 ** 2 + k2 ** 2; ksq[0, 0] = 1
    c, s = (k1 ** 2 - k2 ** 2) / ksq, 2 * k1 * k2 / ksq
    kE = np.fft.ifft2(c * G1 + s * G2).real[:ny, :nx]
    kB = np.fft.ifft2(-s * G1 + c * G2).real[:ny, :nx]
    return kE, kB


def main():
    os.makedirs(OUT, exist_ok=True)
    d = pd.read_csv(CAT, usecols=["ra", "dec", "zphot", "zp2", "gamma1", "gamma2", "weight"])
    n_all = len(d)
    # Drop galaxies with a second photo-z solution (risky redshifts) and keep the usable range.
    d = d[d.zp2.isna() & (d.zphot > SOURCE_EDGES[0]) & (d.zphot < SOURCE_EDGES[-1])].reset_index(drop=True)
    print(f"{len(d)} of {n_all} galaxies kept")

    # Flat projection about the field centre. x grows westward so the image has east on the left.
    ra0, dec0 = d.ra.median(), d.dec.median()
    x = -(d.ra - ra0) * np.cos(np.radians(dec0)) * 60     # arcmin
    y = (d.dec - dec0) * 60
    half = max(np.abs(x).max(), np.abs(y).max()) + 1
    n = int(np.ceil(2 * half / PIX_ARCMIN))
    edges = np.linspace(-half, half, n + 1)
    hist = lambda v: np.histogram2d(y, x, bins=[edges, edges], weights=v)[0]   # rows = dec (increasing)
    sig = SMOOTH_ARCMIN / PIX_ARCMIN

    w = d.weight.values
    W_all = gaussian_filter(hist(w), sig)
    cover = W_all > 0.25 * np.median(W_all[W_all > 0])
    # Kaiser-Squires is unreliable within a couple of smoothing lengths of the field edge.
    inner = binary_erosion(cover, iterations=int(round(2 * sig)))

    def slice_kappa(sel, s1, s2):
        Ws = gaussian_filter(hist(w * sel), sig)
        g1 = gaussian_filter(hist(w * sel * s1 * d.gamma1.values), sig) / np.maximum(Ws, 1e-9)
        g2 = gaussian_filter(hist(w * sel * s2 * d.gamma2.values), sig) / np.maximum(Ws, 1e-9)
        g1[Ws <= 0] = 0; g2[Ws <= 0] = 0
        return kaiser_squires(g1, g2)

    # Pick the shear sign convention from the data: the right convention puts the signal in the
    # E mode (a wrong g2 sign leaks it into B), and clusters are positive peaks (fixes overall sign).
    allsel = np.ones(len(d))
    tests = {}
    for s1, s2 in [(1, 1), (1, -1), (-1, 1), (-1, -1)]:
        kE, kB = slice_kappa(allsel, s1, s2)
        e, b = kE[cover], kB[cover]
        skew = float(np.mean((e - e.mean()) ** 3) / e.std() ** 3)
        tests[(s1, s2)] = (float(e.var() / b.var()), skew)
        print(f"  signs g1*{s1:+d} g2*{s2:+d}: E/B variance ratio {e.var() / b.var():.2f}, E skewness {skew:+.2f}")
    s1, s2 = max(tests, key=lambda k: (round(tests[k][0], 2), tests[k][1]))
    print(f"using g1*{s1:+d}, g2*{s2:+d}")

    # Per source slice: kappa maps, noise level (from the B mode), and lensing efficiency.
    chi_l = np.array([comoving(z) for z in LENS_Z])
    dchi = np.array([comoving(z + 0.05) - comoving(z - 0.05) for z in LENS_Z])
    zgrid = np.linspace(0, 3.2, 641)
    chi_grid = np.array([comoving(z) for z in zgrid])
    chi_s_gal = np.interp(d.zphot.values, zgrid, chi_grid)
    pref = 1.5 * OM * (100 * H / C_KMS) ** 2

    kappas, noise, Q, counts = [], [], [], []
    for lo, hi in zip(SOURCE_EDGES[:-1], SOURCE_EDGES[1:]):
        sel = ((d.zphot >= lo) & (d.zphot < hi)).values.astype(float)
        kE, kB = slice_kappa(sel, s1, s2)
        kappas.append(kE); noise.append(kB[cover].var()); counts.append(int(sel.sum()))
        cs = chi_s_gal[sel > 0]; ws = w[sel > 0]
        eff = [np.average(np.clip((cs - cl) / cs, 0, None), weights=ws) for cl in chi_l]
        Q.append(pref * (1 + LENS_Z) * chi_l * dchi * np.array(eff))
    K = np.stack(kappas)                       # (n_s, ny, nx)
    Q = np.array(Q)                            # (n_s, n_l)
    Ninv = np.diag(1 / np.array(noise))
    Sinv = np.diag(1 / (PRIOR_SIGMA * np.array([growth(z) for z in LENS_Z])) ** 2)

    # Wiener-style linear inversion, same matrix for every pixel.
    if METHOD == "wiener":
        A = np.linalg.solve(Q.T @ Ninv @ Q + Sinv, Q.T @ Ninv)     # (n_l, n_s)
    else:
        # Tomographic matched filter: significance of a single lens at plane l, per pixel.
        A = (Q.T @ Ninv) / np.sqrt(np.einsum("sl,st,tl->l", Q, Ninv, Q))[:, None]
    delta = np.einsum("ls,syx->lyx", A, K)                      # (n_l, ny, nx)
    delta[:, ~cover] = 0

    # Crop to the covered area.
    rows, cols = np.where(cover)
    r0, r1, c0, c1 = rows.min(), rows.max() + 1, cols.min(), cols.max() + 1
    cube = delta[:, r0:r1, c0:c1]
    cov = cover[r0:r1, c0:c1]

    # 3D peaks (on the analysis cube) for labels and the sanity check.
    inner_c = inner[r0:r1, c0:c1]
    peak_mask = (cube == maximum_filter(cube, size=(3, 7, 7))) & inner_c[None] & (cube > 0)
    li, yi, xi = np.where(peak_mask)
    order = np.argsort(cube[li, yi, xi])[::-1][:12]
    ycen = (edges[:-1] + edges[1:]) / 2
    peaks = []
    for k in order:
        xa, ya = ycen[c0 + xi[k]], ycen[r0 + yi[k]]
        peaks.append(dict(ra=round(ra0 - xa / 60 / np.cos(np.radians(dec0)), 4), dec=round(dec0 + ya / 60, 4),
                          z=float(LENS_Z[li[k]]), value=round(float(cube[li[k], yi[k], xi[k]]), 3)))
    print("strongest 3D peaks:", peaks[:5])
    # Sanity check: kappa behind the strongest peak, per source slice. A real lens at z_L shows
    # ~0 for sources in front of it and a rising signal for sources behind it.
    if len(order):
        k0 = order[0]
        prof = [(f"{lo}-{hi}", round(float(K[s, r0 + yi[k0], c0 + xi[k0]]), 4), round(float(np.sqrt(noise[s])), 4))
                for s, (lo, hi) in enumerate(zip(SOURCE_EDGES[:-1], SOURCE_EDGES[1:]))]
        print("kappa vs source slice at strongest peak (slice, kappa, noise):", prof)

    # Resample for the viewer: depth (redshift) fastest, then sky x, then sky y.
    z_near, z_far = float(LENS_Z[0] - 0.05), float(LENS_Z[-1] + 0.05)
    zc = z_near + (np.arange(VIEW_DEPTH) + 0.5) / VIEW_DEPTH * (z_far - z_near)
    ny, nx = cube.shape[1:]
    yy = np.linspace(0, ny - 1, VIEW_SIDE); xx = np.linspace(0, nx - 1, VIEW_SIDE)
    small = np.empty((len(LENS_Z), VIEW_SIDE, VIEW_SIDE))
    for l in range(len(LENS_Z)):                        # sky: smooth to the new cell size, then sample
        sm = gaussian_filter(cube[l], max(ny, nx) / VIEW_SIDE / 2)
        small[l] = sm[np.ix_(np.round(yy).astype(int), np.round(xx).astype(int))]
    cov_small = cov[np.ix_(np.round(yy).astype(int), np.round(xx).astype(int))]
    view = np.empty((VIEW_SIDE, VIEW_SIDE, VIEW_DEPTH), dtype=np.float32)   # [y, x, depth]
    for j in range(VIEW_SIDE):
        for i in range(VIEW_SIDE):
            if not cov_small[j, i]:
                view[j, i] = 0
            elif METHOD == "wiener":
                view[j, i] = np.interp(zc, LENS_Z, small[:, j, i])
            else:
                view[j, i] = place_lenses(small[:, j, i], zc)
    view.tofile(os.path.join(OUT, "cosmos_3d.f32.bin"))

    meta = dict(
        source="COSMOS HST weak-lensing catalog (Leauthaud et al. 2007), our 3D rebuild",
        source_url="https://doi.org/10.26131/IRSA163",
        method=("Kaiser-Squires per photo-z slice, then a tomographic matched filter per pixel"
                if METHOD == "mf" else "Kaiser-Squires per photo-z slice, then a Wiener linear 3D inversion"),
        value=("significance (sigma) of a single lens at that redshift" if METHOD == "mf"
               else "density contrast averaged over 0.1-wide redshift slabs"),
        n_galaxies=int(len(d)), source_slices=SOURCE_EDGES, galaxies_per_slice=counts,
        lens_planes=LENS_Z.tolist(), smoothing_arcmin=SMOOTH_ARCMIN, shear_signs=[s1, s2],
        eb_ratio_all_sources=round(tests[(s1, s2)][0], 2),
        shape=[VIEW_SIDE, VIEW_SIDE, VIEW_DEPTH], layout="float32, index = depth + nd*(x + nx*y)",
        z_near=z_near, z_far=z_far,
        bounds=dict(ra_min=round(ra0 - ycen[c1 - 1] / 60 / np.cos(np.radians(dec0)), 4),
                    ra_max=round(ra0 - ycen[c0] / 60 / np.cos(np.radians(dec0)), 4),
                    dec_min=round(dec0 + ycen[r0] / 60, 4), dec_max=round(dec0 + ycen[r1 - 1] / 60, 4)),
        convention="x: column 0 = ra_max (east left); y: row 0 = dec_min; depth 0 = z_near",
        width_arcmin=round(float((c1 - c0) * PIX_ARCMIN), 1), peaks=peaks,
        note=("Line-of-sight resolution is poor. In the viewer grid each detected lens is drawn at its most "
              "likely redshift as a Gaussian of width %.2f in z; the real uncertainty is larger." % Z_WIDTH
              if METHOD == "mf" else "Line-of-sight resolution is poor: structures are smeared along redshift."),
    )
    with open(os.path.join(OUT, "cosmos_3d.json"), "w") as f:
        json.dump(meta, f, indent=1)
    print(f"wrote {OUT}/cosmos_3d.f32.bin {view.shape} and cosmos_3d.json")


if __name__ == "__main__":
    main()
