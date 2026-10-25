"""Shared, frozen map-to-evidence path for observations and simulations."""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

import healpy as hp
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "pipeline"))
from contracts import load_map, validate_summary
from summary_stats import compute_summary, erode_mask, find_peaks, make_config, smooth


def digest(obj):
    return hashlib.sha256(json.dumps(obj, sort_keys=True, allow_nan=False).encode()).hexdigest()


def mask_digest(mask):
    return hashlib.sha256(np.asarray(mask, dtype=np.uint8).tobytes()).hexdigest()


def file_digest(path):
    h = hashlib.sha256()
    with open(path, "rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def freeze_config(paths, smoothing, n_ell=8, width=1200, ra=(-65, 105), dec=(-68, 8)):
    """Use fiducial simulations only, never fit scaling on an observed map."""
    if not paths:
        raise ValueError("At least one fiducial simulation is required")
    _, mask, meta = load_map(paths[0])
    if meta.get("coord") != "C":
        raise ValueError("Convert maps to equatorial coordinates first")
    if not smoothing or min(smoothing) < 2 * hp.nside2resol(meta["nside"], arcmin=True):
        raise ValueError("Smoothing must be at least twice the HEALPix pixel size")
    if not (ra[0] < ra[1] and -90 <= dec[0] < dec[1] <= 90 and width >= 128):
        raise ValueError("Invalid image bounds or width")
    sources = []
    for path in paths:
        _, other, info = load_map(path)
        if not isinstance(info.get("theta"), dict):
            raise ValueError(f"{path}: fiducial maps need known meta.theta")
        if info.get("coord") != "C" or not np.array_equal(other, mask):
            raise ValueError(f"{path}: fiducials must share coordinates and survey mask")
        sources.append(str(info.get("source", "unspecified")))
    interiors = [{"smoothing_arcmin": float(s), "pixels": int(erode_mask(mask, s).sum())} for s in smoothing]
    if any(x["pixels"] == 0 for x in interiors):
        raise ValueError("No usable eroded interior at a requested smoothing scale; use a better-resolved mask or smaller resolved smoothing scale")
    cfg = make_config(paths, smoothing_arcmin=smoothing, n_ell=n_ell)
    if not np.all(np.isfinite(cfg["sigma_ref"])) or np.min(cfg["sigma_ref"]) <= 0:
        raise ValueError("No usable interior/reference variance; check mask and smoothing")
    cfg["map_reader"] = {
        "version": 1, "mask_sha256": mask_digest(mask), "coord": "C",
        "reference_sources": sources,
        "interior_pixels_by_scale": interiors,
        "render": {"ra": list(ra), "dec": list(dec), "width": width,
                   "scale_index": 0, "sigma_limits": [-4, 4]},
        "warning": "Reference RMS is not a noise-only sigma; kappa/RMS is not detection significance.",
    }
    return cfg


def extract(path, cfg, top_k=8):
    if not 1 <= top_k <= 50:
        raise ValueError("top_k must be between 1 and 50")
    kappa, mask, meta = load_map(path)
    frozen = cfg["map_reader"]
    if mask_digest(mask) != frozen["mask_sha256"]:
        raise ValueError("Survey mask differs from frozen config; forward-model sims to the data mask")
    if meta.get("coord") != frozen["coord"]:
        raise ValueError("Coordinates differ from frozen config")
    values, names = compute_summary(kappa, mask, cfg)
    validate_summary(values, names, cfg["length"])
    if names != cfg["names"]:
        raise ValueError("Feature names differ from frozen config")
    objects, layers = [], []
    j = frozen["render"]["scale_index"]
    scale = cfg["smoothing_arcmin"][j]
    region = erode_mask(mask, scale)
    if not region.any():
        raise ValueError("Eroded mask is empty; reduce smoothing or use a larger footprint")
    for b, m in enumerate(kappa):
        ms = smooth(m, mask, scale)
        sig = cfg["sigma_ref"][b][j]
        layers.append({"id": f"image:bin{b}", "bin": b, "smoothing_arcmin": scale,
                       "reference_rms": sig, "interior_pixels": int(region.sum())})
        for kind, signed in (("peak", ms), ("trough", -ms)):
            idx = find_peaks(signed, region)
            idx = idx[np.argsort(-signed[idx], kind="stable")][:top_k]
            ra, dec = hp.pix2ang(meta["nside"], idx, lonlat=True)
            for rank, (pixel, lon, lat) in enumerate(zip(idx, ra, dec)):
                objects.append({"id": f"{kind}:bin{b}:{rank}", "kind": kind, "bin": b,
                                "pixel_ring": int(pixel), "ra_deg": float(lon), "dec_deg": float(lat),
                                "kappa": float(ms[pixel]), "kappa_over_reference_rms": float(ms[pixel] / sig)})
    # Never expose simulation truth to the language model.
    warnings = list(meta.get("analysis_warnings", []))
    for interior in frozen["interior_pixels_by_scale"]:
        if interior["pixels"] < .05 * mask.sum():
            warnings.append(f"Only {interior['pixels']} interior pixels survive mask erosion at {interior['smoothing_arcmin']:g} arcmin (under 5% of survey pixels); feature information is severely limited.")
    return {
        "schema_version": 1, "map_sha256": file_digest(path), "config_sha256": digest(cfg),
        "source": str(meta.get("source", "unspecified")), "nside": meta["nside"],
        "mask_source": meta.get("mask_source", meta.get("header", {}).get("mask_source", "map contract mask")),
        "reference_sources": frozen["reference_sources"],
        "interior_pixels_by_scale": frozen["interior_pixels_by_scale"],
        "coord": "C", "ordering": "RING", "nbins": int(kappa.shape[0]),
        "area_deg2": float(mask.sum() * hp.nside2pixarea(meta["nside"], degrees=True)),
        "summary": {"names": names, "values": values.tolist()}, "objects": objects, "layers": layers,
        "limitations": warnings + [
            "Projected convergence map; source-redshift layers overlap and are not independent 3D slices.",
            "Extrema are map features, not confirmed clusters or voids; apparent bridges are not confirmed filaments.",
            "Reference RMS is not a noise-only uncertainty; no detection significance is measured.",
            "Pseudo power uses an approximate sky-fraction correction, shared by data and sims.",
            "No cosmological posterior or coverage validation is supplied to this reader.",
        ],
    }


def render(path, cfg, evidence, out):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from export_view import project

    out = Path(out)
    kappa, mask, _ = load_map(path)
    rc = cfg["map_reader"]["render"]
    j = rc["scale_index"]
    scale = cfg["smoothing_arcmin"][j]
    image_paths = []
    for b, m in enumerate(kappa):
        ms = smooth(m, mask, scale)
        image, _, _ = project(ms, mask, rc["ra"], rc["dec"], rc["width"])
        lim = np.array(rc["sigma_limits"]) * cfg["sigma_ref"][b][j]
        fig, ax = plt.subplots(figsize=(12, 5.8), layout="constrained")
        ax.set_facecolor("#777777")
        cm = plt.get_cmap("RdBu_r").with_extremes(bad="#777777")
        im = ax.imshow(image, extent=[rc["ra"][1], rc["ra"][0], rc["dec"][0], rc["dec"][1]],
                       vmin=lim[0], vmax=lim[1], cmap=cm, aspect="auto", interpolation="nearest")
        for obj in evidence["objects"]:
            lon = ((obj["ra_deg"] - rc["ra"][0]) % 360) + rc["ra"][0]
            if obj["bin"] != b or not rc["ra"][0] <= lon <= rc["ra"][1]:
                continue
            if not rc["dec"][0] <= obj["dec_deg"] <= rc["dec"][1]:
                continue
            label = obj["id"].replace(f":bin{b}:", ":")
            ax.plot(lon, obj["dec_deg"], "o", ms=5, mfc="none", mec="black")
            ax.annotate(label, (lon, obj["dec_deg"]), fontsize=7, xytext=(3, 3), textcoords="offset points")
        reference_note = " | TOY reference scale; uncalibrated" if any(
            "toy" in s.lower() for s in cfg["map_reader"]["reference_sources"]) else ""
        ax.set(title=f"Projected convergence | bin {b} | {scale:g} arcmin | gray = unobserved{reference_note}",
               xlabel="RA [deg], east left (negative RA wraps +360)", ylabel="Dec [deg]")
        fig.colorbar(im, ax=ax, label="Convergence kappa (fixed fiducial scale)", shrink=.8)
        target = out / f"map_bin{b}.png"
        fig.savefig(target, dpi=110)
        plt.close(fig)
        image_paths.append(target)
    return image_paths
