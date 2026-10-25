from __future__ import annotations

import argparse
import glob
import json
import sys
from pathlib import Path

import numpy as np

from .science import digest, extract, freeze_config, load_map, render


def write_json(path, obj):
    Path(path).write_text(json.dumps(obj, indent=2, allow_nan=False))


def expand(patterns):
    paths = sorted({p for pattern in patterns for p in (glob.glob(pattern) or [pattern])})
    if not paths or any(not Path(p).is_file() for p in paths):
        raise ValueError("Input patterns must match existing files")
    return paths


def analyze(path, cfg, out, model=None, question="What map features are visible, and what needs follow-up?", top_k=8, provider="openai"):
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    evidence = extract(path, cfg, top_k=top_k)
    images = render(path, cfg, evidence, out)
    write_json(out / "config.json", cfg)
    write_json(out / "evidence.json", evidence)
    write_json(out / "summary.json", {**evidence["summary"], "map": str(path),
                                    "config_sha256": evidence["config_sha256"],
                                    "map_sha256": evidence["map_sha256"]})
    local = {"mode": "local_measurements_only", "vlm_ran": False,
             "notice": "No language model was called. Features below are numerical measurements.",
             "n_summary_features": len(evidence["summary"]["names"]), "objects": evidence["objects"],
             "limitations": evidence["limitations"]}
    write_json(out / "analysis.json", local)
    lines = ["# Dark matter map reader", "", f"Source: {evidence['source']}", "",
             "Local measurements complete. No cosmological inference has been performed.", "",
             f"Survey area: {evidence['area_deg2']:.1f} deg²; nside: {evidence['nside']}; "
             f"SBI summary: {len(evidence['summary']['names'])} features.", "",
             "Reference sources: " + "; ".join(evidence["reference_sources"]), "",
             "## Map features", "", "| ID | RA [deg] | Dec [deg] | κ |", "|---|---:|---:|---:|"]
    lines.extend(f"| {o['id']} | {o['ra_deg']:.3f} | {o['dec_deg']:.3f} | {o['kappa']:.6f} |" for o in evidence["objects"])
    lines += ["", "## Limitations", ""] + [f"- {x}" for x in evidence["limitations"]]
    for image in images:
        lines += ["", f"![Projected convergence]({image.resolve()})"]
    # Save a usable report even when credentials or the provider fail.
    write_report = lambda: (out / "report.md").write_text("\n".join(lines) + "\n")
    write_report()
    if model:
        from .vision import describe
        try:
            result = describe(evidence, images, model, out / "cache", question, provider=provider)
        except ValueError as exc:
            local.update(vlm_attempted=True, vlm_error=str(exc),
                         notice="VLM interpretation was requested but no accepted result was returned. Numerical measurements remain available.")
            write_json(out / "analysis.json", local)
            lines += ["", "## VLM unavailable", "", str(exc)]
            write_report()
            raise
        write_json(out / "analysis.json", result)
        desc = result["description"]
        lines += ["", "## VLM interpretation (unvalidated hypotheses)", "", desc["overview"], ""]
        lines += [f"- {f['description']} ({', '.join(f['evidence_ids'])})" for f in desc["features"]]
        lines += ["", "Model limitations:", ""] + [f"- {x}" for x in desc["limitations"]]
        write_report()
    print(f"Saved {out}/report.md, evidence.json, summary.json, analysis.json and {len(images)} image(s)")


def main():
    ap = argparse.ArgumentParser(description="DES map reader: numerical features + optional pretrained VLM")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("ingest", help="Use existing DES ingestion helpers; no viewer or download")
    p.add_argument("fits")
    p.add_argument("--field", default="0")
    p.add_argument("--nside", type=int, default=128)
    p.add_argument("--coord", choices=["C", "G"])
    p.add_argument("--mask")
    p.add_argument("--note", action="append", default=[], help="Provenance/validation warning carried into reports")
    p.add_argument("--out", required=True)
    p = sub.add_parser("freeze", help="Freeze feature/scaling config on fiducial simulations")
    p.add_argument("--fiducials", nargs="+", required=True)
    p.add_argument("--smoothing", nargs="+", type=float, default=[60, 90])
    p.add_argument("--n-ell", type=int, default=8)
    p.add_argument("--out", required=True)
    p = sub.add_parser("analyze")
    p.add_argument("--map", required=True)
    p.add_argument("--config", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--model", help="Opt in to a vision model supporting structured outputs")
    p.add_argument("--provider", choices=["openai", "anthropic"], default="openai")
    p.add_argument("--question", default="What map features are visible, and what needs follow-up?")
    p.add_argument("--top-k", type=int, default=8)
    p = sub.add_parser("batch", help="Export fixed numerical features for existing train_sbi.py")
    p.add_argument("--maps", nargs="+", required=True)
    p.add_argument("--config", required=True)
    p.add_argument("--out", required=True)
    p = sub.add_parser("export-site", help="Write the browser JSON (data/reader.json) for the viewer")
    p.add_argument("--analysis", required=True, help="An analyze --out directory")
    p.add_argument("--manifest", help="Site manifest.json, used to decide whether pins match site peaks")
    p.add_argument("--out", required=True)
    p = sub.add_parser("site-des", help="Analyse the DES layers the website shows and refresh data/reader.json")
    p.add_argument("--manifest", default="../data/manifest.json")
    p.add_argument("--out", default="reader_runs/des_site")
    p.add_argument("--site-out", default="../data/reader.json")
    p.add_argument("--nside", type=int, default=512)
    p.add_argument("--smoothing", nargs="+", type=float, default=[15, 20])
    p.add_argument("--top-k", type=int, default=6)
    p.add_argument("--model", help="Vision model; omit for local measurements only")
    p.add_argument("--provider", choices=["openai", "anthropic"], default="anthropic")
    p.add_argument("--question", default="Describe the most prominent projected-mass peaks, troughs and any "
                   "bridge-like structures in each layer of this DES Y3 map. What is uncertain?")
    p = sub.add_parser("demo", help="Small reproducible TOY demonstration; not a DES result")
    p.add_argument("--out", default="reader_runs/toy")
    a = ap.parse_args()

    if a.cmd == "ingest":
        sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
        from make_des_map import read_any, build_mask, to_equatorial, degrade
        from contracts import save_map
        field = tuple(int(x) for x in a.field.split(","))
        maps, info = read_any(a.fits, field[0] if len(field) == 1 else field)
        if a.coord:
            info["coordsys"] = a.coord
        if info.get("coordsys") not in ("C", "G"):
            raise ValueError("Missing/unsupported COORDSYS; specify --coord C or G after verifying provenance")
        mask = build_mask(maps, info, a.mask)
        if not a.mask and mask.mean() > 0.5:
            raise ValueError("This DES input has valid values over most of the sky. Supply --mask from the survey release; finite reconstruction values do not define its footprint")
        maps, mask = to_equatorial(maps, mask, info)
        maps, mask = degrade(maps, mask, a.nside)
        for b in maps:
            b[mask] -= b[mask].mean()
        Path(a.out).parent.mkdir(parents=True, exist_ok=True)
        save_map(a.out, maps, mask, {"coord": "C", "nside": a.nside, "source": str(a.fits),
                                   "mask_source": str(a.mask) if a.mask else info["mask_source"],
                                   "analysis_warnings": a.note,
                                   "header": info})
        print(f"Saved map contract to {a.out}")
    elif a.cmd == "freeze":
        cfg = freeze_config(expand(a.fiducials), a.smoothing, a.n_ell)
        Path(a.out).parent.mkdir(parents=True, exist_ok=True)
        write_json(a.out, cfg)
        print(f"Frozen {cfg['length']} features: {digest(cfg)}")
    elif a.cmd == "analyze":
        analyze(a.map, json.loads(Path(a.config).read_text()), a.out, a.model, a.question, a.top_k, provider=a.provider)
    elif a.cmd == "export-site":
        from .export_site import export_site
        payload = export_site(a.analysis, a.out, a.manifest)
        aligned = "matched to site peaks" if payload["alignment"]["aligned"] else "standalone pins (map differs from site)"
        print(f"Saved {a.out}: status={payload['status']}, {len(payload['features'])} feature(s), {aligned}")
    elif a.cmd == "site-des":
        from .viewer_source import viewer_to_map
        from .export_site import export_site
        out = Path(a.out)
        out.mkdir(parents=True, exist_ok=True)
        obs = viewer_to_map(a.manifest, out / "des_site.npz", nside=a.nside)
        cfg = freeze_config([str(obs)], a.smoothing, n_ell=6, display_only=True)
        write_json(out / "config.json", cfg)
        analysis = out / "analysis"
        try:
            analyze(str(obs), cfg, analysis, a.model, a.question, a.top_k, provider=a.provider)
        finally:
            # Refresh the site even if the model call fails, so it never shows stale toy text.
            if (analysis / "analysis.json").exists():
                payload = export_site(analysis, a.site_out, a.manifest)
                aligned = "linked to site peaks" if payload["alignment"]["aligned"] else "standalone pins"
                print(f"Saved {a.site_out}: status={payload['status']}, {len(payload['features'])} feature(s), {aligned}")
    elif a.cmd == "batch":
        cfg = json.loads(Path(a.config).read_text())
        if cfg.get("map_reader", {}).get("display_only"):
            raise ValueError("This config is display-only (scaled from an observed map) and cannot be used for SBI")
        paths = expand(a.maps)
        rows, theta = [], []
        for path in paths:
            _, _, meta = load_map(path)
            t = meta.get("theta", {})
            pair = [t.get("Omega_m", np.nan), t.get("S8", np.nan)]
            if not np.isfinite(pair).all():
                raise ValueError(f"{path}: batch training requires known finite Omega_m and S8")
            rows.append(extract(path, cfg, top_k=1)["summary"]["values"])
            theta.append(pair)
        Path(a.out).parent.mkdir(parents=True, exist_ok=True)
        np.savez(a.out, x=np.asarray(rows), theta=np.asarray(theta), names=np.array(cfg["names"]),
                 files=np.array(paths), config_sha256=digest(cfg))
        print(f"Saved {len(rows)} x {cfg['length']} SBI matrix to {a.out}; no VLM calls")
    else:
        from contracts import des_like_mask, save_map
        from toy_sims import toy_kappa
        from forward_model import pixel_noise_sigma, survey_map
        root = Path(a.out)
        root.mkdir(parents=True, exist_ok=True)
        nside, scale = 32, [240, 360]
        mask = des_like_mask(nside)
        fids = []
        for i in range(4):
            path = root / f"fid_{i}.npz"
            k = survey_map(toy_kappa(.31, .78, nside, seed=100+i), mask, pixel_noise_sigma(nside), seed=200+i)
            save_map(path, k, mask, {"source": "TOY lognormal simulation; not physics or DES",
                                    "theta": {"Omega_m": .31, "S8": .78}})
            fids.append(str(path))
        obs = root / "obs.npz"
        k = survey_map(toy_kappa(.29, .76, nside, seed=900), mask, pixel_noise_sigma(nside), seed=901)
        save_map(obs, k, mask, {"source": "TOY held-out map; not DES", "theta": {"Omega_m": .29, "S8": .76}})
        cfg = freeze_config(fids, scale, n_ell=4)
        write_json(root / "config.json", cfg)
        analyze(str(obs), cfg, root / "analysis")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError) as exc:
        raise SystemExit(f"Map reader: {exc}") from None
