import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from map_reader.export_site import SCHEMA, build_payload, export_site


def _obj(i, kind, ra, dec, k):
    return {"id": f"{kind}:bin0:{i}", "kind": kind, "bin": 0, "pixel_ring": i,
            "ra_deg": ra, "dec_deg": dec, "kappa": k, "kappa_over_reference_rms": k / .01}


EVIDENCE = {
    "source": "TOY test map", "coord": "C", "nside": 32, "nbins": 1,
    "map_sha256": "m", "config_sha256": "c", "limitations": ["Projected map."],
    "summary": {"names": ["peaks_a", "peaks_b"], "values": [1.0, 2.0]},
    "layers": [{"id": "image:bin0", "bin": 0}],
    "objects": [_obj(0, "peak", 350.0, -40.0, .04), _obj(0, "trough", 20.0, -30.0, -.02)],
}
DESCRIPTION = {
    "overview": "A toy map.", "abstained": False, "limitations": ["Toy only."],
    "features": [
        {"kind": "measured_extremum", "description": "Highest peak.",
         "evidence_ids": ["peak:bin0:0", "image:bin0"], "requires_followup": True},
        {"kind": "quality_concern", "description": "Clumpy.",
         "evidence_ids": ["summary:1", "trough:bin0:0"], "requires_followup": True},
    ],
}
VLM = {"mode": "pretrained_vlm", "vlm_ran": True, "provider": "anthropic", "model": "claude-x",
       "response_id": "msg_1", "description": DESCRIPTION}


def _manifest(source="TOY test map", peak=(-10.02, -40.01)):
    return {"source": source, "coord": "C",
            "bounds": {"ra_min": -65.0, "ra_max": 105.0, "dec_min": -70.0, "dec_max": 10.0},
            "layers": [{"name": "bin 0"}],
            "peaks": [{"ra": 100.0, "dec": -20.0, "kappa": .05, "snr": 5, "bin": 0},
                      {"ra": peak[0], "dec": peak[1], "kappa": .04, "snr": 4, "bin": 0}]}


def _run(tmp_path, analysis, evidence=EVIDENCE):
    (tmp_path / "evidence.json").write_text(json.dumps(evidence))
    (tmp_path / "analysis.json").write_text(json.dumps(analysis))
    return tmp_path


def test_resolves_ids_and_matches_aligned_site_peak_across_ra_wrap(tmp_path):
    p = build_payload(_run(tmp_path, VLM), _manifest())
    assert p["schema"] == SCHEMA and p["status"] == "ok" and p["is_toy"]
    assert p["alignment"] == {"aligned": True, "reasons": []}
    f0, f1 = p["features"]
    # RA 350 lies inside a manifest range that starts negative (-65..105).
    assert f0["targets"][0]["ra"] == 350.0 and f0["targets"][0]["site_peak"]["index"] == 1
    assert f0["refs"] == [{"id": "image:bin0", "label": "image:bin0"}]
    assert f1["refs"] == [{"id": "summary:1", "label": "peaks_b"}]
    assert f1["targets"][0]["type"] == "trough" and f1["targets"][0]["site_peak"] is None
    assert p["model"]["response_id"] == "msg_1" and "outside_site_bounds" not in p["alignment"]


def test_misaligned_maps_never_claim_site_peaks(tmp_path):
    p = build_payload(_run(tmp_path, VLM), _manifest(source="different map"))
    assert not p["alignment"]["aligned"] and p["alignment"]["reasons"]
    assert all("site_peak" not in t for f in p["features"] for t in f["targets"])


def test_distant_peak_is_not_matched(tmp_path):
    p = build_payload(_run(tmp_path, VLM), _manifest(peak=(-5.0, -40.0)))
    assert p["features"][0]["targets"][0]["site_peak"] is None


def test_local_only_and_failed_runs_export_measurements_without_prose(tmp_path):
    local = {"mode": "local_measurements_only", "vlm_ran": False}
    p = build_payload(_run(tmp_path, local))
    assert p["status"] == "local_only" and p["features"] == [] and p["overview"] is None
    assert len(p["objects"]) == 2 and p["alignment"]["aligned"] is False
    p = build_payload(_run(tmp_path, {**local, "vlm_attempted": True, "vlm_error": "HTTP 401"}))
    assert p["status"] == "vlm_failed" and "HTTP 401" not in json.dumps(p)


def test_export_writes_strict_json_and_flags_out_of_bounds(tmp_path):
    ev = {**EVIDENCE, "objects": EVIDENCE["objects"] + [_obj(1, "peak", 150.0, 2.0, .03)]}
    run = _run(tmp_path, VLM, ev)
    (tmp_path / "manifest.json").write_text(json.dumps(_manifest()))
    out = tmp_path / "site" / "reader.json"
    export_site(run, out, tmp_path / "manifest.json")
    p = json.loads(out.read_text())
    assert p["alignment"]["outside_site_bounds"] == ["peak:bin0:1"]
    assert not (tmp_path / "site" / "reader.json.tmp").exists()
