"""Build a 3D volume (RA x Dec x distance) from the DES Y3 KaRMMa kappa maps for the
volumetric viewer (viewer/des-volume.html).

Same idea as deproject_des.py, but with many thin shells, evenly spaced in comoving
distance, and a prior that is smooth along the line of sight:
    delta_hat = S Q^T (Q S Q^T + N)^-1 kappa        (Wiener filter, data-space form)
  Q[i, l]  lensing weight of source bin i over thin shell l
  S[l, l'] = A s_l s_l' exp(-(chi_l - chi_l')^2 / 2 corr^2)   smooth depth prior
  N        posterior noise covariance between bins (spread across KaRMMa samples)
Only 4 bins go in, so every depth profile is a blend of 4 basic shapes. Structures come
out stretched along depth; the resolution matrix W Q records how much.

Outputs to data/des_volume/:
  volume.u8.bin  uint8, (nchi, ny, nx, 2) C-order: channel 0 = mean delta, channel 1 = S/N
                 (byte b -> (b - 128) / 127.5 * scale; scales in volume.json)
                 x: column 0 = ra_max (east left); y: row 0 = dec_min; nchi: near -> far
  mask.u8.bin    uint8 (ny, nx), 255 inside the DES footprint
  volume.json    grid, scales, z <-> distance table, 3D peaks, depth resolution

Usage:  bin/penumbra-python prep/des_volume.py [--res 0.25] [--nchi 32] [--nz des_2pt.fits]
"""
import argparse
import json
import os
import sys

import healpy as hp
import numpy as np
from astropy.cosmology import Planck18 as COSMO
from scipy.ndimage import maximum_filter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from deproject_des import lensing_kernels, load_nz, slice_matrix, smooth_all  # noqa: E402
from export_des import NSIDE, ROOT, load_samples  # noqa: E402

OUT = os.path.join(ROOT, "data", "des_volume")


def growth(z):
    """Linear growth factor D(z), normalised to 1 today (flat LCDM, Carroll+1992 fit)."""
    om0 = COSMO.Om0
    a = 1 / (1 + z)
    om = om0 / (om0 + (1 - om0) * a ** 3)
    ol = 1 - om
    g = 2.5 * om / (om ** (4 / 7) - ol + (1 + om / 2) * (1 + ol / 70))
    g0 = 2.5 * om0 / (om0 ** (4 / 7) - (1 - om0) + (1 + om0 / 2) * (1 + (1 - om0) / 70))
    return a * g / g0


def sky_grid(mask, res):
    th, ph = hp.pix2ang(NSIDE, np.where(mask)[0])
    ra = np.degrees(ph); ra = np.where(ra > 180, ra - 360, ra)
    dec = 90 - np.degrees(th)
    b = dict(ra_min=float(np.floor(ra.min()) - 1), ra_max=float(np.ceil(ra.max()) + 1),
             dec_min=float(np.floor(dec.min()) - 1), dec_max=float(np.ceil(dec.max()) + 1))
    nx = int(round((b["ra_max"] - b["ra_min"]) / res))
    ny = int(round((b["dec_max"] - b["dec_min"]) / res))
    ras = b["ra_max"] - (np.arange(nx) + 0.5) * res           # column 0 = ra_max
    decs = b["dec_min"] + (np.arange(ny) + 0.5) * res         # row 0 = dec_min
    RA, DEC = np.meshgrid(ras, decs)
    theta, phi = np.radians(90 - DEC).ravel(), np.radians(RA % 360).ravel()
    # Interpolation weights once, reused for every shell.
    pix, wts = hp.get_interp_weights(NSIDE, theta, phi)       # (4, n)
    in_idx = np.full(hp.nside2npix(NSIDE), -1); in_idx[mask] = np.arange(mask.sum())
    li = in_idx[pix]
    w = np.where(li >= 0, wts, 0)
    wsum = w.sum(axis=0)
    inside = wsum > 0.5
    return b, nx, ny, li, w, wsum, inside


def to_sky(vals, li, w, wsum, inside, ny, nx):
    """In-mask values (..., P) -> (..., ny, nx); outside the mask = 0."""
    v = np.take(vals, np.maximum(li, 0), axis=-1)             # (..., 4, n)
    out = (v * w).sum(axis=-2) / np.maximum(wsum, 1e-9)
    out = np.where(inside, out, 0)
    return out.reshape(vals.shape[:-1] + (ny, nx))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--res", type=float, default=0.25, help="sky pixel size, degrees")
    ap.add_argument("--nchi", type=int, default=32, help="number of depth shells")
    ap.add_argument("--zmin", type=float, default=0.02)
    ap.add_argument("--zmax", type=float, default=1.3)
    ap.add_argument("--corr", type=float, default=300.0, help="depth correlation length of the prior, Mpc")
    ap.add_argument("--smoothing", type=float, default=30.0, help="FWHM arcmin")
    ap.add_argument("--nz", default=None, help="DES Y3 2pt FITS with an nz_source extension")
    ap.add_argument("--samples", type=int, default=100)
    args = ap.parse_args()
    os.makedirs(OUT, exist_ok=True)

    # --- depth grid, even in comoving distance ---------------------------------
    z = np.linspace(0, 2.5, 1001)
    chi_z = COSMO.comoving_distance(z).value
    nz, nz_src = load_nz(args.nz, z)
    q = lensing_kernels(z, nz)
    chi_e = np.linspace(np.interp(args.zmin, z, chi_z), np.interp(args.zmax, z, chi_z), args.nchi + 1)
    z_e = np.interp(chi_e, chi_z, z)
    chi_c = 0.5 * (chi_e[1:] + chi_e[:-1])
    z_c = np.interp(chi_c, chi_z, z)
    Q = slice_matrix(z, q, z_e)                                # (4, nchi)

    # --- maps ---------------------------------------------------------------
    mask, stack = load_samples()
    stack = stack[: args.samples]
    print(f"smoothing {stack.shape[0]}x{stack.shape[1]} maps at {args.smoothing}'")
    sm = smooth_all(stack, mask, args.smoothing)               # (S, 4, P)
    resid = sm - sm.mean(axis=0, keepdims=True)
    N = np.einsum("sip,sjp->ij", resid, resid) / (resid.shape[0] * resid.shape[2])
    cen = sm - sm.mean(axis=2, keepdims=True)
    C = np.einsum("sip,sjp->ij", cen, cen) / (cen.shape[0] * cen.shape[2])

    # --- prior: smooth along depth; thin-shell amplitude ~ growth, falls slowly with distance
    s = growth(z_c) * (chi_c / 1000.0) ** -0.5
    S0 = np.outer(s, s) * np.exp(-0.5 * ((chi_c[:, None] - chi_c[None, :]) / args.corr) ** 2)
    M = Q @ S0 @ Q.T
    A = max(np.sum(M * C) / np.sum(M * M), 1e-12)              # fit amplitude: Q S Q^T ~ C
    S = A * S0
    W = S @ Q.T @ np.linalg.inv(Q @ S @ Q.T + N)              # (nchi, 4)
    R = W @ Q                                                  # resolution matrix
    print(f"prior amplitude A={A:.3g}; fit residual {np.linalg.norm(A*M - C)/np.linalg.norm(C):.2f} of |C|")

    # Depth resolution: for a point mass at shell l, where does the estimate land?
    res_rows = []
    for l in range(args.nchi):
        col = np.abs(R[:, l])
        if col.max() <= 0:
            res_rows.append(None); continue
        above = np.where(col >= 0.5 * col.max())[0]
        res_rows.append(dict(z_true=round(float(z_c[l]), 3), z_peak=round(float(z_c[np.argmax(col)]), 3),
                             z_half_lo=round(float(z_e[above[0]]), 3), z_half_hi=round(float(z_e[above[-1] + 1]), 3)))
    for r in res_rows[::6]:
        if r: print("  mass at z={z_true}: appears at z={z_peak} (half-max {z_half_lo}-{z_half_hi})".format(**r))

    # --- per-shell estimate on every sample -> mean, std ----------------------
    b, nx, ny, li, w, wsum, inside = sky_grid(mask, args.res)
    vol_d = np.zeros((args.nchi, ny, nx), np.float32)
    vol_s = np.zeros((args.nchi, ny, nx), np.float32)
    for l in range(args.nchi):
        d = np.einsum("i,sip->sp", W[l], sm)                   # (S, P)
        mean, std = d.mean(axis=0), d.std(axis=0)
        vol_d[l] = to_sky(mean, li, w, wsum, inside, ny, nx)
        vol_s[l] = to_sky(mean / np.maximum(std, 1e-12), li, w, wsum, inside, ny, nx)
    ins = inside.reshape(ny, nx)
    print(f"volume {nx}x{ny}x{args.nchi}; |S/N|>2 in {100*np.mean(np.abs(vol_s[:, ins]) > 2):.1f}% of voxels, "
          f">3 in {100*np.mean(np.abs(vol_s[:, ins]) > 3):.2f}%")
    for l in range(0, args.nchi, 4):
        print(f"  z={z_c[l]:.2f}: median|S/N|={np.median(np.abs(vol_s[l, ins])):.2f}  max S/N={vol_s[l, ins].max():.1f}")

    # --- quantise and write ---------------------------------------------------
    d_scale = float(np.percentile(np.abs(vol_d[:, ins]), 99.8))
    s_scale = 5.0
    q8 = lambda v, sc: np.clip(np.round(v / sc * 127.5 + 128), 0, 255).astype(np.uint8)
    vol = np.stack([q8(vol_d, d_scale), q8(vol_s, s_scale)], axis=-1)    # (nchi, ny, nx, 2)
    vol.tofile(os.path.join(OUT, "volume.u8.bin"))
    (ins * 255).astype(np.uint8).tofile(os.path.join(OUT, "mask.u8.bin"))

    # --- 3D peaks: local maxima in S/N --------------------------------------
    snr = np.where(ins[None], vol_s, -99)
    is_max = (snr == maximum_filter(snr, size=(5, 9, 9))) & (snr > 2.5)
    idx = np.argwhere(is_max)
    idx = idx[np.argsort(-snr[tuple(idx.T)])][:25]
    peaks = []
    for l, y, x in idx:
        peaks.append(dict(ra=round(float((b["ra_max"] - (x + 0.5) * args.res) % 360), 3),
                          dec=round(float(b["dec_min"] + (y + 0.5) * args.res), 3),
                          z=round(float(z_c[l]), 3), chi_mpc=round(float(chi_c[l]), 1),
                          delta=round(float(vol_d[l, y, x]), 4), snr=round(float(snr[l, y, x]), 2)))
    print(f"{len(peaks)} peaks with S/N > 2.5; top: " + ", ".join(f"z={p['z']} {p['snr']}σ" for p in peaks[:5]))

    zt = np.linspace(0, 1.5, 61)
    meta = dict(
        source="DES Y3 KaRMMa mass maps (%d posterior samples), Wiener-filtered into depth shells" % stack.shape[0],
        source_url="https://zenodo.org/records/10668943",
        nz=nz_src, smoothing_arcmin=args.smoothing, prior_corr_mpc=args.corr,
        shape=dict(nx=nx, ny=ny, nchi=args.nchi), res_deg=args.res, bounds=b,
        chi_min_mpc=float(chi_e[0]), chi_max_mpc=float(chi_e[-1]),
        z_edges=np.round(z_e, 4).tolist(), z_centers=np.round(z_c, 4).tolist(),
        z_table=dict(z=zt.round(3).tolist(), chi_mpc=np.interp(zt, z, chi_z).round(1).tolist()),
        delta_scale=d_scale, snr_scale=s_scale,
        layout="volume.u8.bin is (nchi, ny, nx, 2) uint8, C order; ch0 delta, ch1 S/N; byte b -> (b-128)/127.5*scale. "
               "x col 0 = ra_max; y row 0 = dec_min; shells near -> far, even in comoving distance.",
        depth_resolution=[r for r in res_rows if r], peaks=peaks,
        note="Built from 4 projected lensing maps, so depth is heavily blurred: a single clump shows up "
             "stretched over a few tenths in redshift. Brightness follows posterior S/N. Not a true 3D map.",
    )
    with open(os.path.join(OUT, "volume.json"), "w") as f:
        json.dump(meta, f, indent=1)
    print(f"wrote {os.path.getsize(os.path.join(OUT, 'volume.u8.bin'))/1e6:.1f} MB volume to {OUT}")


if __name__ == "__main__":
    main()
