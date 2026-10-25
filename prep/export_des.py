"""Export the real DES Y3 KaRMMa mass maps into the viewer's data contract.

Reads the 100 KaRMMa posterior samples (4 tomographic bins each), takes the
mean per bin, smooths it inside the survey mask, and writes for each bin:
  data/layer_bin{b}.png      RGBA, magma colormap, masked sky transparent
  data/layer_bin{b}.f16.bin  float16 grid, row-major (h, w), NaN = masked
plus data/manifest.json (same schema as the toy export, so the viewer needs no changes).

Usage:
  .venv/bin/python prep/export_des.py                 # defaults below
  .venv/bin/python prep/export_des.py --smoothing 20 --res 0.08
"""
import argparse
import glob
import json
import os

import healpy as hp
import numpy as np
from matplotlib import colormaps
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KARMMA = os.path.join(ROOT, "dark_universe_data/des_y3/karmma/desy3_karmma_maps")
OUT = os.path.join(ROOT, "data")
NSIDE = 256


def load_samples():
    mask = hp.read_map(os.path.join(KARMMA, "mask.fits")).astype(bool)
    files = sorted(glob.glob(os.path.join(KARMMA, "map_*.npy")))
    if not files:
        raise SystemExit(f"No KaRMMa samples in {KARMMA}. Run get_dark_matter_data.sh first.")
    stack = np.stack([np.load(f) for f in files])          # (n_samples, 4, n_in_mask)
    return mask, stack


def smooth_masked(values, mask, fwhm_arcmin):
    """Gaussian smoothing that ignores pixels outside the mask (no edge dimming)."""
    full = np.zeros(hp.nside2npix(NSIDE))
    full[mask] = values
    if fwhm_arcmin <= 0:
        return full
    fwhm = np.radians(fwhm_arcmin / 60)
    num = hp.smoothing(full, fwhm=fwhm)
    den = hp.smoothing(mask.astype(float), fwhm=fwhm)
    out = np.zeros_like(full)
    out[mask] = num[mask] / np.maximum(den[mask], 1e-3)
    return out


def find_peaks(full, mask, n):
    """Local maxima: higher than all 8 HEALPix neighbours, with every neighbour inside the mask."""
    pix = np.where(mask)[0]
    nb = hp.get_all_neighbours(NSIDE, pix)                  # (8, n)
    ok = np.all(nb >= 0, axis=0)
    nb_safe = np.where(nb >= 0, nb, 0)
    ok &= np.all(mask[nb_safe], axis=0)
    ok &= np.all(full[pix] > full[nb_safe], axis=0)
    peaks = pix[ok]
    return peaks[np.argsort(full[peaks])[::-1][:n]]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--smoothing", type=float, default=20.0, help="display smoothing FWHM, arcmin")
    ap.add_argument("--res", type=float, default=0.08, help="output pixel size, degrees")
    ap.add_argument("--peaks", type=int, default=40, help="peaks exported per bin")
    args = ap.parse_args()

    mask, stack = load_samples()
    n_samples, n_bins, _ = stack.shape
    mean, std = stack.mean(axis=0), stack.std(axis=0)
    print(f"{n_samples} samples, {n_bins} bins, {mask.sum()} pixels in mask")

    # Bounds from the mask, padded and rounded to whole degrees. RA in (-180, 180].
    th, ph = hp.pix2ang(NSIDE, np.where(mask)[0])
    ra = np.degrees(ph); ra = np.where(ra > 180, ra - 360, ra)
    dec = 90 - np.degrees(th)
    b = dict(ra_min=float(np.floor(ra.min()) - 1), ra_max=float(np.ceil(ra.max()) + 1),
             dec_min=float(np.floor(dec.min()) - 1), dec_max=float(np.ceil(dec.max()) + 1))
    w = int(round((b["ra_max"] - b["ra_min"]) / args.res))
    h = int(round((b["dec_max"] - b["dec_min"]) / args.res))

    # Plate carrée pixel centres: column 0 = ra_max (east left), row 0 = dec_max.
    ras = b["ra_max"] - (np.arange(w) + 0.5) * args.res
    decs = b["dec_max"] - (np.arange(h) + 0.5) * args.res
    RA, DEC = np.meshgrid(ras, decs)
    theta, phi = np.radians(90 - DEC).ravel(), np.radians(RA % 360).ravel()
    mask_interp = hp.get_interp_val(mask.astype(float), theta, phi)
    inside = mask_interp > 0.5

    layers, peaks = [], []
    for bi in range(n_bins):
        full = smooth_masked(mean[bi], mask, args.smoothing)
        vals = full[mask]
        sigma = float(vals.std())
        grid = np.full(h * w, np.nan, dtype=np.float32)
        grid[inside] = hp.get_interp_val(full * mask, theta[inside], phi[inside]) / mask_interp[inside]
        grid = grid.reshape(h, w)

        vmin, vmax = np.nanpercentile(grid, [0.5, 99.5])
        t = np.clip((grid - vmin) / (vmax - vmin), 0, 1)
        rgba = (colormaps["magma"](np.nan_to_num(t)) * 255).astype(np.uint8)
        rgba[..., 3] = np.where(np.isnan(grid), 0, 255)
        Image.fromarray(rgba, "RGBA").save(os.path.join(OUT, f"layer_bin{bi}.png"), optimize=True)
        grid.astype(np.float16).tofile(os.path.join(OUT, f"layer_bin{bi}.f16.bin"))

        std_full = np.zeros(hp.nside2npix(NSIDE)); std_full[mask] = std[bi]
        for p in find_peaks(full, mask, args.peaks):
            t_, p_ = hp.pix2ang(NSIDE, p)
            peaks.append(dict(ra=round(float(np.degrees(p_)) % 360, 4), dec=round(90 - float(np.degrees(t_)), 4),
                              kappa=round(float(full[p]), 5), snr=round(float(full[p] / sigma), 2),
                              post_snr=round(float(full[p] / max(std_full[p], 1e-9)), 2), bin=bi))
        layers.append(dict(name=f"bin {bi}", png=f"layer_bin{bi}.png", raw=f"layer_bin{bi}.f16.bin",
                           shape=[h, w], vmin=float(vmin), vmax=float(vmax), sigma=sigma,
                           n_peaks_exported=args.peaks))
        print(f"bin {bi}: sigma={sigma:.5f}  range {vmin:.4f}..{vmax:.4f}")

    manifest = dict(
        source="DES Y3 KaRMMa mass maps (mean of %d posterior samples)" % n_samples,
        source_url="https://zenodo.org/records/10668943",
        smoothing_arcmin=args.smoothing, coord="C", nside=NSIDE, bounds=b,
        convention="plate carree; column 0 = ra_max (east left), row 0 = dec_max; RA may be negative (= RA+360)",
        layers=layers, peaks=peaks,
        note="Layers are mass projected toward more distant sources (overlapping), not depth slices. "
             "snr = kappa / layer sigma; post_snr = kappa / posterior std across the samples.",
    )
    with open(os.path.join(OUT, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=1)
    print(f"wrote {n_bins} layers ({h}x{w}) and {len(peaks)} peaks to {OUT}")


if __name__ == "__main__":
    main()
