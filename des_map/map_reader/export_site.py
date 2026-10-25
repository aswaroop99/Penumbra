"""Export a reader run as one browser-safe JSON file for the Penumbra viewer.

Output (``data/reader.json``) is static: the VLM runs offline and the site only
fetches this file, so no API key or model call ever reaches the browser.

Every evidence ID the model cited is resolved to measured sky coordinates.
Pins are matched to site-manifest peaks only when the reader analysed the same
map as the site (same ``source`` and coordinate system); otherwise the payload
says why not, so the viewer never presents two different maps' features as one.
"""
from __future__ import annotations

import json
import math
from datetime import datetime, timezone
from pathlib import Path

SCHEMA = "penumbra.reader/1"
DISCLAIMER = ("AI-written description of map morphology, checked only for valid references to "
              "measured features. It is not a measurement and is never used for cosmological inference.")
MAX_TEXT = 2000


def _text(value):
    return str(value)[:MAX_TEXT]


def _ra_in_bounds(ra, lo, hi):
    """Manifest RA ranges may start negative (= RA+360); test the wrapped value."""
    return any(lo <= r <= hi for r in (ra, ra - 360.0, ra + 360.0))


def _sep_deg(ra1, dec1, ra2, dec2):
    r1, d1, r2, d2 = map(math.radians, (ra1, dec1, ra2, dec2))
    c = math.sin(d1) * math.sin(d2) + math.cos(d1) * math.cos(d2) * math.cos(r1 - r2)
    return math.degrees(math.acos(max(-1.0, min(1.0, c))))


def _target(obj):
    return {"id": obj["id"], "type": obj["kind"], "bin": int(obj["bin"]),
            "ra": round(float(obj["ra_deg"]), 5), "dec": round(float(obj["dec_deg"]), 5),
            "kappa": float(obj["kappa"]),
            "kappa_over_reference_rms": float(obj["kappa_over_reference_rms"])}


def alignment(evidence, manifest):
    """Decide whether reader targets may be identified with site-manifest peaks."""
    if manifest is None:
        return {"aligned": False, "reasons": ["No site manifest supplied"]}
    reasons = []
    if evidence.get("source") != manifest.get("source"):
        reasons.append(f"Reader analysed '{evidence.get('source')}', site shows '{manifest.get('source')}'")
    if evidence.get("coord", "C") != manifest.get("coord", "C"):
        reasons.append("Coordinate systems differ")
    if evidence.get("nbins", 1) > len(manifest.get("layers", [])):
        reasons.append("Reader has more tomographic bins than the site")
    return {"aligned": not reasons, "reasons": reasons}


def _match(target, manifest, tolerance_deg):
    best = None
    for i, p in enumerate(manifest.get("peaks", [])):
        if int(p.get("bin", 0)) != target["bin"]:
            continue
        sep = _sep_deg(target["ra"], target["dec"], p["ra"], p["dec"])
        if sep <= tolerance_deg and (best is None or sep < best[1]):
            best = (i, sep)
    return None if best is None else {"index": best[0], "sep_deg": round(best[1], 4)}


def build_payload(analysis_dir, manifest=None, now=None):
    d = Path(analysis_dir)
    evidence = json.loads((d / "evidence.json").read_text())
    analysis = json.loads((d / "analysis.json").read_text())
    objects = {o["id"]: o for o in evidence["objects"]}
    names = evidence["summary"]["names"]
    align = alignment(evidence, manifest)
    # One pixel at the analysis resolution: the coarsest position the reader resolves.
    tol = math.degrees(math.sqrt(4 * math.pi / (12 * evidence["nside"] ** 2)))
    if manifest is not None:
        b = manifest["bounds"]
        outside = [o["id"] for o in evidence["objects"]
                   if not (_ra_in_bounds(o["ra_deg"], b["ra_min"], b["ra_max"])
                           and b["dec_min"] <= o["dec_deg"] <= b["dec_max"])]
        if outside:
            align.setdefault("outside_site_bounds", outside)

    def resolve(ids):
        targets, refs = [], []
        for ref in ids:
            if ref in objects:
                t = _target(objects[ref])
                if align["aligned"] and manifest is not None:
                    t["site_peak"] = _match(t, manifest, tol) if t["type"] == "peak" else None
                targets.append(t)
            elif ref.startswith("summary:"):
                refs.append({"id": ref, "label": names[int(ref.split(":", 1)[1])]})
            else:
                refs.append({"id": ref, "label": ref})
        return targets, refs

    payload = {
        "schema": SCHEMA,
        "generated_at": (now or datetime.now(timezone.utc)).isoformat(timespec="seconds"),
        "source": evidence["source"],
        "is_toy": "TOY" in evidence["source"].upper(),
        "coord": evidence.get("coord", "C"),
        "map_sha256": evidence["map_sha256"],
        "config_sha256": evidence["config_sha256"],
        "alignment": align,
        "objects": [_target(o) for o in evidence["objects"]],
        "measurement_limitations": [_text(x) for x in evidence["limitations"]],
        "disclaimer": DISCLAIMER,
    }
    if analysis.get("vlm_ran"):
        desc = analysis["description"]
        features = []
        for f in desc["features"]:
            targets, refs = resolve(f["evidence_ids"])
            features.append({"kind": f["kind"], "text": _text(f["description"]),
                             "requires_followup": bool(f["requires_followup"]),
                             "targets": targets, "refs": refs})
        payload.update(status="abstained" if desc["abstained"] else "ok",
                       model={"provider": analysis["provider"], "model": analysis["model"],
                              "response_id": analysis["response_id"]},
                       overview=_text(desc["overview"]), features=features,
                       model_limitations=[_text(x) for x in desc["limitations"]])
    else:
        payload.update(status="vlm_failed" if analysis.get("vlm_attempted") else "local_only",
                       model=None, overview=None, features=[], model_limitations=[])
    return payload


def export_site(analysis_dir, out, manifest_path=None):
    manifest = json.loads(Path(manifest_path).read_text()) if manifest_path else None
    payload = build_payload(analysis_dir, manifest)
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(out.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=1, allow_nan=False))
    tmp.replace(out)  # atomic: the dev server never serves a half-written file
    return payload
