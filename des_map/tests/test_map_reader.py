import copy
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import healpy as hp
import numpy as np
import pytest
from jsonschema import ValidationError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from map_reader.science import extract, freeze_config, load_map, render
from contracts import save_map
from summary_stats import compute_summary
from map_reader.vision import describe, validate_response


@pytest.fixture
def maps(tmp_path):
    rng = np.random.default_rng(17)
    mask = np.ones(hp.nside2npix(16), dtype=bool)
    paths = []
    for i in range(3):
        path = tmp_path / f"fid_{i}.npz"
        save_map(path, rng.normal(0, .01, mask.size), mask,
                 {"source": "TOY test", "theta": {"Omega_m": .31, "S8": .78}})
        paths.append(str(path))
    cfg = freeze_config(paths, [500], n_ell=3, width=256)
    return tmp_path, paths, cfg


def test_numerical_contract_and_no_truth_leak(maps):
    _, paths, cfg = maps
    ev = extract(paths[0], cfg)
    k, mask, _ = load_map(paths[0])
    values, names = compute_summary(k, mask, cfg)
    np.testing.assert_array_equal(ev["summary"]["values"], values)
    assert ev["summary"]["names"] == names == cfg["names"]
    assert "theta" not in json.dumps(ev)
    for o in ev["objects"]:
        assert hp.ang2pix(16, o["ra_deg"], o["dec_deg"], lonlat=True) == o["pixel_ring"]


def test_rejects_mask_coords_and_names(maps):
    root, paths, cfg = maps
    k, mask, meta = load_map(paths[0])
    mask[10] = False
    path = root / "wrong.npz"
    save_map(path, k, mask, meta)
    with pytest.raises(ValueError, match="mask differs"):
        extract(path, cfg)
    mask[10] = True
    save_map(path, k, mask, {**meta, "coord": "G"})
    with pytest.raises(ValueError, match="Coordinates differ"):
        extract(path, cfg)
    bad = copy.deepcopy(cfg)
    bad["names"][0] = "changed"
    with pytest.raises(ValueError, match="Feature names"):
        extract(paths[0], bad)


def test_mass_sheet_and_masked_values_do_not_change_features(maps):
    root, paths, cfg = maps
    k, mask, meta = load_map(paths[0])
    before = extract(paths[0], cfg)["summary"]["values"]
    path = root / "offset.npz"
    save_map(path, k + .125, mask, meta)
    after = extract(path, cfg)["summary"]["values"]
    # save_map is float32: allow rounding in tiny log powers, preserve peak counts.
    np.testing.assert_allclose(before, after, atol=1e-5, rtol=1e-5)
    mask[:100] = False
    save_map(path, k, mask, meta)
    new_cfg = freeze_config([str(path)], [500], n_ell=3)
    masked = extract(path, new_cfg)["summary"]["values"]
    k[:, ~mask] = np.nan
    save_map(path, k, mask, meta)
    np.testing.assert_array_equal(masked, extract(path, new_cfg)["summary"]["values"])


def test_config_needs_simulations_and_resolved_scales(maps):
    root, paths, _ = maps
    with pytest.raises(ValueError, match="pixel size"):
        freeze_config(paths, [15])
    k, mask, _ = load_map(paths[0])
    path = root / "observed.npz"
    save_map(path, k, mask, {"source": "observed"})
    with pytest.raises(ValueError, match="theta"):
        freeze_config([str(path)], [500])


def description(ev):
    return {"overview": "A projected map with visible extrema.", "abstained": False,
            "features": [{"kind": "measured_extremum", "description": "A local map maximum.",
                          "evidence_ids": [ev["objects"][0]["id"]], "requires_followup": True}],
            "limitations": ["No cosmological inference supplied."]}


def test_vlm_rejects_fabricated_evidence_and_false_measurements(maps):
    _, paths, cfg = maps
    ev = extract(paths[0], cfg)
    obj = description(ev)
    obj["features"][0]["evidence_ids"] = ["peak:invented"]
    with pytest.raises(ValidationError):
        validate_response(obj, ev)
    obj["features"][0]["evidence_ids"] = ["image:bin0"]
    with pytest.raises(ValueError, match="measured peak"):
        validate_response(obj, ev)
    obj["features"][0].update(kind="visual_hypothesis", requires_followup=False)
    with pytest.raises(ValueError, match="follow-up"):
        validate_response(obj, ev)


def test_api_payload_and_cache(maps):
    root, paths, cfg = maps
    ev = extract(paths[0], cfg)
    images = render(paths[0], cfg, ev, root)
    calls = []
    def create(**kwargs):
        calls.append(kwargs)
        return SimpleNamespace(status="completed", output_text=json.dumps(description(ev)), id="test-response")
    client = SimpleNamespace(responses=SimpleNamespace(create=create))
    first = describe(ev, images, "test-model", root / "cache", "Describe", client)
    second = describe(ev, images, "test-model", root / "cache", "Describe", client)
    assert not first["cached"] and second["cached"] and len(calls) == 1
    assert calls[0]["store"] is False
    content = calls[0]["input"][0]["content"]
    assert any(x["type"] == "input_image" and x["image_url"].startswith("data:image/png;base64,") for x in content)
    assert "theta" not in content[0]["text"]
    describe(ev, images, "test-model", root / "cache", "Different question", client)
    assert len(calls) == 2
    images[0].write_bytes(images[0].read_bytes() + b"changed")
    describe(ev, images, "test-model", root / "cache", "Describe", client)
    assert len(calls) == 3


def test_missing_key_keeps_local_report(maps, monkeypatch):
    from map_reader.__main__ import analyze
    root, paths, cfg = maps
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    out = root / "analysis"
    with pytest.raises(ValueError, match="OPENAI_API_KEY"):
        analyze(paths[0], cfg, out, model="test-model")
    assert json.loads((out / "analysis.json").read_text())["vlm_ran"] is False
    assert (out / "summary.json").is_file() and (out / "report.md").is_file()


def test_sbi_handoff_and_fingerprint_rejection(maps):
    from train_sbi import observed_vector, validate_training_config
    from map_reader.__main__ import analyze
    from map_reader.science import digest
    root, paths, cfg = maps
    out = root / "analysis"
    analyze(paths[0], cfg, out)
    observed = observed_vector(out / "summary.json", cfg)
    direct = observed_vector(paths[0], cfg)
    np.testing.assert_array_equal(observed, direct)
    train = {"names": np.array(cfg["names"]), "config_sha256": np.array(digest(cfg))}
    validate_training_config(train, cfg)
    bad = copy.deepcopy(cfg)
    bad["sigma_ref"][0][0] *= 2
    with pytest.raises(ValueError, match="fingerprint"):
        observed_vector(out / "summary.json", bad)
    with pytest.raises(ValueError, match="fingerprint"):
        validate_training_config(train, bad)


def test_real_sdk_serialization_without_network(maps):
    try:
        import httpx2
    except ImportError:
        import httpx as httpx2
    from openai import OpenAI, DefaultHttpxClient
    root, paths, cfg = maps
    ev = extract(paths[0], cfg)
    images = render(paths[0], cfg, ev, root)
    requests = []
    def handler(request):
        requests.append(json.loads(request.content))
        return httpx2.Response(200, json={
            "id": "resp_mock", "object": "response", "created_at": 0, "status": "completed",
            "model": "mock-vision", "output": [{"type": "message", "id": "msg_mock", "status": "completed",
                "role": "assistant", "content": [{"type": "output_text", "text": json.dumps(description(ev)),
                                                     "annotations": []}]}],
        })
    with OpenAI(api_key="test-not-a-real-key", http_client=DefaultHttpxClient(
        transport=httpx2.MockTransport(handler))) as client:
        result = describe(ev, images, "mock-vision", root / "sdk-cache", "Describe", client)
    assert result["response_id"] == "resp_mock"
    assert requests[0]["text"]["format"]["strict"] is True


def test_incomplete_model_response_never_cached(maps):
    root, paths, cfg = maps
    ev = extract(paths[0], cfg)
    image = root / "fake.png"
    image.write_bytes(b"not sent to a real endpoint")
    client = SimpleNamespace(responses=SimpleNamespace(create=lambda **kw: SimpleNamespace(
        status="incomplete", output_text="", id="incomplete")))
    with pytest.raises(ValueError, match="incomplete"):
        describe(ev, [image], "test", root / "bad-cache", "Describe", client)
    assert not (root / "bad-cache").exists()


def test_des_ingestion_requires_explicit_footprint(tmp_path, monkeypatch):
    from map_reader.__main__ import main
    path = tmp_path / "fullsky.fits"
    hp.write_map(str(path), np.linspace(-.02, .02, hp.nside2npix(16)), coord="C", dtype=np.float64)
    target = tmp_path / "data.npz"
    monkeypatch.setattr(sys, "argv", ["map_reader", "ingest", str(path), "--out", str(target)])
    with pytest.raises(ValueError, match="Supply --mask"):
        main()
    assert not target.exists()
