"""Turn the site's displayed DES layers (data/manifest.json + float16 grids) into a
HEALPix map contract, so the reader analyses exactly the map visitors see.

The viewer grids are plate carree (column 0 = ra_max, row 0 = dec_max, NaN = outside
the survey). Each HEALPix pixel centre is bilinearly sampled from the finite neighbouring
grid cells only; a pixel is kept when at least half of its interpolation weight lies on
observed cells in every bin, so no value is invented outside the footprint.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import healpy as hp
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "pipeline"))
from contracts import save_map

MIN_OBSERVED_WEIGHT = 0.5
RESAMPLE_NOTE = ("Resampled from the website's display grids (float16, plate carree, already smoothed "
                 "{smooth:g} arcmin), not the original HEALPix release files.")


def load_grids(manifest_path):
    manifest_path = Path(manifest_path)
    manifest = json.loads(manifest_path.read_text())
    grids = []
    for layer in manifest["layers"]:
        name = layer["raw"]
        if "/" in name or "\\" in name or ".." in name:
            raise ValueError(f"Unsafe grid file name in manifest: {name}")
        h, w = layer["shape"]
        raw = np.fromfile(manifest_path.parent / name, dtype="<f2")
        if raw.size != h * w:
            raise ValueError(f"{name}: expected {h}x{w} values, found {raw.size}")
        grids.append(raw.reshape(h, w).astype(np.float64))
    return manifest, grids


def sample_healpix(manifest, grids, nside):
    b = manifest["bounds"]
    h, w = grids[0].shape
    lon, lat = hp.pix2ang(nside, np.arange(hp.nside2npix(nside)), lonlat=True)
    center = (b["ra_min"] + b["ra_max"]) / 2
    ra = center + ((lon - center + 180.0) % 360.0 - 180.0)  # same branch as the bounds
    inside = (ra >= b["ra_min"]) & (ra <= b["ra_max"]) & (lat >= b["dec_min"]) & (lat <= b["dec_max"])
    col = (b["ra_max"] - ra) / (b["ra_max"] - b["ra_min"]) * (w - 1)
    row = (b["dec_max"] - lat) / (b["dec_max"] - b["dec_min"]) * (h - 1)
    c0 = np.clip(np.floor(col).astype(int), 0, w - 2)
    r0 = np.clip(np.floor(row).astype(int), 0, h - 2)
    fc, fr = col - c0, row - r0
    weights = [(1 - fr) * (1 - fc), (1 - fr) * fc, fr * (1 - fc), fr * fc]
    kappa = np.zeros((len(grids), col.size))
    mask = inside.copy()
    for i, g in enumerate(grids):
        corners = [g[r0, c0], g[r0, c0 + 1], g[r0 + 1, c0], g[r0 + 1, c0 + 1]]
        good = [np.isfinite(c) for c in corners]
        wsum = sum(np.where(ok, wt, 0.0) for ok, wt in zip(good, weights))
        vsum = sum(np.where(ok, np.nan_to_num(c) * wt, 0.0) for ok, c, wt in zip(good, corners, weights))
        # Keep a pixel only when most of its interpolation weight is on observed cells;
        # empty cells are skipped, never treated as zero.
        mask &= wsum >= MIN_OBSERVED_WEIGHT
        kappa[i] = np.where(wsum > 0, vsum / np.maximum(wsum, 1e-12), 0.0)
    kappa = np.where(mask, kappa, 0.0)
    if not mask.any():
        raise ValueError("No HEALPix pixel centre falls inside the viewer footprint")
    return kappa, mask


def viewer_to_map(manifest_path, out, nside=256):
    manifest, grids = load_grids(manifest_path)
    if manifest.get("coord", "C") != "C":
        raise ValueError("Viewer manifest must be equatorial (coord C)")
    kappa, mask = sample_healpix(manifest, grids, nside)
    for k in kappa:
        k[mask] -= k[mask].mean()
    warnings = [RESAMPLE_NOTE.format(smooth=manifest.get("smoothing_arcmin", 0))]
    if "mean" in manifest.get("source", "").lower():
        warnings.append("A posterior-mean map is smoother and lower in amplitude than any single realization; "
                        "small or faint features are suppressed.")
    Path(out).parent.mkdir(parents=True, exist_ok=True)
    save_map(out, kappa, mask, {
        "coord": "C", "nside": nside, "source": manifest["source"],
        "mask_source": "Website layer footprint (finite viewer-grid pixels)",
        "analysis_warnings": warnings,
        "layer_names": [layer["name"] for layer in manifest["layers"]],
    })
    return out
