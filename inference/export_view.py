#!/usr/bin/env python3
"""Export a mass map as image layers + metadata for the fly-through viewer.

  python export_view.py --map data.npz --out viewer_data/ [--smoothing 15] \
      [--ra -65 105 --dec -70 10] [--width 2400] [--peaks 50] [--mergers mergers.csv]

Writes, per tomographic bin:
  layer_bin{b}.png      RGBA, masked sky transparent, colour = smoothed kappa
  layer_bin{b}.f16.bin  raw float16 grid (row-major, height x width, NaN = masked)
                        for shaders / custom colormaps / hover values
and manifest.json with geographic bounds, the pixel->RA/Dec convention, value
ranges, the top peaks (clusters) and optional merger points.

Image convention: astronomical (east left). Column 0 is the HIGHEST RA (ra_max),
row 0 is the HIGHEST Dec. manifest["convention"] repeats this for the frontend.

Tomographic layers are mass projected toward progressively more distant source
galaxies, not slices in depth; they overlap. Label them as "looking deeper".
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
from summary_stats import erode_mask, find_peaks, smooth  # noqa: E402


def project(m, mask, ra_range, dec_range, width):
    """Plate carree grid. Returns (img[h, w], ra_axis, dec_axis); NaN outside mask."""
    nside = hp.npix2nside(m.size)
    height = int(round(width * (dec_range[1] - dec_range[0]) / (ra_range[1] - ra_range[0])))
    ra = np.linspace(ra_range[1], ra_range[0], width)          # east-left: high RA first
    dec = np.linspace(dec_range[1], dec_range[0], height)      # north-up: high Dec first
    RA, DEC = np.meshgrid(ra, dec)
    pix = hp.ang2pix(nside, RA % 360.0, DEC, lonlat=True)
    img = np.where(mask[pix], m[pix], np.nan)
    return img, ra, dec


def to_rgba(img, vmin, vmax, cmap="magma"):
    import matplotlib
    cm = matplotlib.colormaps[cmap]
    norm = np.clip((img - vmin) / (vmax - vmin), 0, 1)
    rgba = cm(np.nan_to_num(norm))
    rgba[..., 3] = np.where(np.isnan(img), 0.0, 1.0)
    return (rgba * 255).astype(np.uint8)


def _main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--map", required=True)
    ap.add_argument("--out", default="viewer_data")
    ap.add_argument("--smoothing", type=float, default=15.0, help="arcmin; ~10-20 for display")
    ap.add_argument("--ra", type=float, nargs=2, default=[-65.0, 105.0], help="RA range in deg (may be negative)")
    ap.add_argument("--dec", type=float, nargs=2, default=[-70.0, 10.0])
    ap.add_argument("--width", type=int, default=2400)
    ap.add_argument("--peaks", type=int, default=50)
    ap.add_argument("--mergers", default=None, help="CSV with ra,dec[,label] to overlay")
    ap.add_argument("--cmap", default="magma")
    ap.add_argument("--layer-names", nargs="*", default=None)
    a = ap.parse_args(argv)

    import matplotlib.pyplot as plt
    k, mask, meta = load_map(a.map)
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    region = erode_mask(mask, a.smoothing)
    layers, all_peaks = [], []
    for b in range(k.shape[0]):
        ms = smooth(k[b], mask, a.smoothing)
        sig = ms[region].std()
        img, ra_ax, dec_ax = project(ms, mask, a.ra, a.dec, a.width)
        vmin, vmax = np.nanpercentile(img, [1, 99.7])
        plt.imsave(out / f"layer_bin{b}.png", to_rgba(img, vmin, vmax, a.cmap))
        img.astype(np.float16).tofile(out / f"layer_bin{b}.f16.bin")
        pk = find_peaks(ms, region)
        pk = pk[np.argsort(ms[pk])[::-1][: a.peaks]]
        pra, pdec = hp.pix2ang(hp.npix2nside(ms.size), pk, lonlat=True)
        peaks = [{"ra": round(float(r), 4), "dec": round(float(d), 4), "kappa": round(float(ms[p]), 5),
                  "snr": round(float(ms[p] / sig), 2), "bin": b} for p, r, d in zip(pk, pra, pdec)]
        all_peaks += peaks
        name = a.layer_names[b] if a.layer_names and b < len(a.layer_names) else f"bin {b}"
        layers.append({"name": name, "png": f"layer_bin{b}.png", "raw": f"layer_bin{b}.f16.bin",
                       "shape": list(img.shape), "vmin": float(vmin), "vmax": float(vmax),
                       "sigma": float(sig), "n_peaks_exported": len(peaks)})
    manifest = {
        "source": meta.get("source"), "smoothing_arcmin": a.smoothing, "coord": meta.get("coord", "C"),
        "bounds": {"ra_min": a.ra[0], "ra_max": a.ra[1], "dec_min": a.dec[0], "dec_max": a.dec[1]},
        "convention": "plate carree; column 0 = ra_max (east left), row 0 = dec_max; RA may be negative (= RA+360)",
        "layers": layers,
        "peaks": all_peaks,
        "note": "Layers are mass projected toward more distant sources (overlapping), not depth slices.",
    }
    if a.mergers:
        import pandas as pd
        df = pd.read_csv(a.mergers)
        manifest["mergers"] = df.head(20000).to_dict(orient="records")
    (out / "manifest.json").write_text(json.dumps(manifest, indent=1))
    print(f"wrote {len(layers)} layer(s), {len(all_peaks)} peaks to {out}/")


if __name__ == "__main__":
    _main()
