#!/usr/bin/env python3
"""Bundle the inference outputs into the one small file the viewer loads.

  python publish_results.py --posterior work/posterior.json \
      --comparison work/results/s8_comparison.json \
      --manifest ../data/manifest.json --out ../data/inference.json \
      [--coverage work/posterior_coverage.json] [--truth work/toy/obs.npz]

Reads   posterior.json            (train_sbi.py; the posterior contract)
        posterior_coverage.json   (train_sbi.py; held-out trust check)
        s8_comparison.json        (planck_compare.py; Planck / DES / MCMC, honest wording)
Writes  data/inference.json       (schema: data/README_for_frontend.md)
and adds `"inference": "inference.json"` to the manifest. The pointer is not part
of the manifest version hash computed by the viewer, so existing rooms stay valid.

The artifact records which map it was computed from (`map.source`); the viewer
ignores it if that does not match the loaded manifest. Posterior samples are
downsampled deterministically (quantiles are computed from the full set first).
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from contracts import load_map, load_posterior  # noqa: E402

SCHEMA_VERSION = 1
LEVEL_KEYS = ("0.5", "0.68", "0.9", "0.95")


def interval(samples):
    q = np.quantile(samples, [0.025, 0.16, 0.5, 0.84, 0.975])
    return {"median": float(q[2]), "lo68": float(q[1]), "hi68": float(q[3]),
            "lo95": float(q[0]), "hi95": float(q[4])}


def sigma8_from(samples):
    """sigma8 per posterior sample, from S8 = sigma8 * sqrt(Omega_m / 0.3).

    Done sample by sample (not from the two medians) so the Omega_m-S8 correlation
    carries through into the sigma8 interval."""
    return samples[:, 1] / np.sqrt(samples[:, 0] / 0.3)


def _read(path, what):
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(f"{what} not found: {p}")
    return json.loads(p.read_text())


def build_artifact(posterior_path, comparison_path, manifest, coverage_path=None, truth=None,
                   max_points=1500, seed=0, fingerprint=None):
    samples, post = load_posterior(posterior_path)
    comp = _read(comparison_path, "comparison")
    if coverage_path is None:
        guess = Path(posterior_path).with_name(Path(posterior_path).stem + "_coverage.json")
        coverage_path = guess if guess.exists() else None
    cov = _read(coverage_path, "coverage") if coverage_path else None

    meta = post.get("meta", {})
    source = manifest.get("source") or "unknown"
    refs = comp["references"]
    trust = None
    if cov:
        levels = cov["levels"]
        trust = {
            "n_heldout": int(cov["n_heldout"]),
            "levels": levels,
            "coverage_S8": cov["empirical"]["S8"],
            "coverage_Omega_m": cov["empirical"]["Omega_m"],
            "coverage_68_S8": cov["empirical"]["S8"][levels.index(0.68)],
            "binomial_1sigma_at_68": cov["binomial_1sigma_at_68"],
            "S8_rank_histogram": cov["S8_rank_histogram"],
            "max_abs_z_observed": cov.get("out_of_distribution", {}).get("max_abs_z", meta.get("max_abs_z_observed")),
            "out_of_distribution": bool(cov.get("out_of_distribution", {}).get("flagged", False)),
            "fiducial_S8_bias": cov.get("fiducial_S8_bias"),
        }

    rng = np.random.default_rng(seed)
    idx = np.sort(rng.choice(len(samples), min(max_points, len(samples)), replace=False))
    pts = np.round(samples[idx], 4).tolist()

    mcmc = comp.get("comparison_posterior")
    art = {
        "version": SCHEMA_VERSION,
        "method": post["method"],
        "data": post["data"],
        "map": {"source": source, "n_layers": len(manifest.get("layers", []))},
        "synthetic": "toy" in source.lower(),
        "S8": interval(samples[:, 1]),
        "Omega_m": interval(samples[:, 0]),
        "sigma8": interval(sigma8_from(samples)),
        "training": {"n_train": meta.get("n_train"), "n_heldout": meta.get("n_heldout"),
                     "n_features": meta.get("n_features"), "n_samples": int(len(samples))},
        "trust": trust,
        "comparison": {
            "planck": {"label": refs["planck2018"]["label"], "S8": refs["planck2018"]["S8"],
                       "err": refs["planck2018"]["err"], "Omega_m": refs["planck2018"].get("Omega_m"),
                       "Omega_m_err": refs["planck2018"].get("Omega_m_err")},
            "des_y3": {"label": refs["desy3_shear"]["label"], "S8": refs["desy3_shear"]["S8"],
                       "err_lo": refs["desy3_shear"]["err_lo"], "err_hi": refs["desy3_shear"]["err_hi"]},
            "tension_vs_planck_sigma": comp["tension_vs_planck_sigma_gaussian_approx"],
            "difference_vs_desy3_sigma": comp["difference_vs_desy3_sigma"],
            "mcmc": None if not mcmc else {
                "method": mcmc["method"], "S8": mcmc["S8"], "difference_sigma": mcmc["difference_sigma"]},
        },
        "statement": comp["statement"],
        "caveats": comp["caveats"],
        "truth": truth,
        "samples": pts,
    }
    if fingerprint:  # run_inference.py's cache key; the viewer ignores it
        art["fingerprint"] = fingerprint
    return art


def validate_artifact(a):
    """Cheap sanity checks before publishing; the viewer re-validates strictly."""
    for k in ("S8", "Omega_m", "sigma8"):
        s = a[k]
        if not (s["lo95"] <= s["lo68"] <= s["median"] <= s["hi68"] <= s["hi95"]):
            raise ValueError(f"{k} interval is not ordered: {s}")
    if not (0.2 < a["S8"]["median"] < 1.5):
        raise ValueError("S8 median implausible")
    if not a["samples"] or any(len(p) != 2 for p in a["samples"]):
        raise ValueError("samples must be [Omega_m, S8] pairs")
    if not a["statement"]:
        raise ValueError("missing statement")
    return True


def truth_from_map(path):
    _, _, meta = load_map(path)
    th = meta.get("theta")
    return None if not th else {"Omega_m": float(th["Omega_m"]), "S8": float(th["S8"])}


def publish(posterior, comparison, manifest_path, out, coverage=None, truth_map=None, max_points=1500,
            update_manifest=True, fingerprint=None):
    manifest_path = Path(manifest_path)
    manifest = json.loads(manifest_path.read_text())
    truth = truth_from_map(truth_map) if truth_map else None
    art = build_artifact(posterior, comparison, manifest, coverage, truth, max_points, fingerprint=fingerprint)
    validate_artifact(art)
    out = Path(out)
    out.write_text(json.dumps(art, separators=(",", ":")))
    if update_manifest:
        manifest["inference"] = out.name
        manifest_path.write_text(json.dumps(manifest, indent=1) + "\n")
    return art


def _main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--posterior", required=True)
    ap.add_argument("--comparison", required=True, help="results/s8_comparison.json from planck_compare.py")
    ap.add_argument("--coverage", default=None, help="default: <posterior>_coverage.json if present")
    ap.add_argument("--manifest", required=True, help="data/manifest.json of the map this posterior describes")
    ap.add_argument("--out", required=True, help="e.g. data/inference.json")
    ap.add_argument("--truth", default=None, help="map .npz with meta.theta (toy observations only)")
    ap.add_argument("--max-points", type=int, default=1500)
    ap.add_argument("--no-manifest-update", action="store_true")
    a = ap.parse_args(argv)
    art = publish(a.posterior, a.comparison, a.manifest, a.out, a.coverage, a.truth, a.max_points,
                  not a.no_manifest_update)
    s = art["S8"]
    print(f"wrote {a.out}: S8 = {s['median']:.3f} +{s['hi68'] - s['median']:.3f} -{s['median'] - s['lo68']:.3f} "
          f"({art['method']}; synthetic={art['synthetic']})")


if __name__ == "__main__":
    _main()
