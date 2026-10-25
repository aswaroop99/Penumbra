"""The run-once cache and the sigma8 derivation. No torch / sbi: training is skipped or never reached."""
import json

import numpy as np
import pytest

import planck_compare
import publish_results
import run_inference
from contracts import save_map, save_posterior


def test_fingerprint_tracks_content_and_order(tmp_path):
    a, b = tmp_path / "a", tmp_path / "b"
    a.write_bytes(b"one")
    b.write_bytes(b"two")
    base = run_inference.fingerprint(a, b)
    assert base == run_inference.fingerprint(a, b)
    assert base != run_inference.fingerprint(b, a)
    b.write_bytes(b"three")
    assert base != run_inference.fingerprint(a, b)
    with pytest.raises(FileNotFoundError):
        run_inference.fingerprint(a, tmp_path / "missing")


def test_load_cached_requires_a_parseable_matching_result(tmp_path):
    out = tmp_path / "inference.json"
    assert run_inference.load_cached(out, "fp") is None  # absent
    out.write_text("{not json")
    assert run_inference.load_cached(out, "fp") is None  # malformed
    out.write_text("[1, 2]")
    assert run_inference.load_cached(out, "fp") is None  # wrong shape
    out.write_text(json.dumps({"fingerprint": "other"}))
    assert run_inference.load_cached(out, "fp") is None  # computed from different inputs
    out.write_text(json.dumps({"fingerprint": "fp", "x": 1}))
    assert run_inference.load_cached(out, "fp") == {"fingerprint": "fp", "x": 1}


def test_sigma8_is_derived_per_sample_so_correlation_carries_through():
    rng = np.random.default_rng(0)
    om = rng.normal(0.3, 0.03, 4000)
    s8 = 0.76 + 0.5 * (om - 0.3) + rng.normal(0, 0.005, 4000)  # correlated draws
    sig = publish_results.sigma8_from(np.c_[om, s8])
    assert np.allclose(sig, s8 / np.sqrt(om / 0.3))
    iv = publish_results.interval(sig)
    assert iv["lo95"] <= iv["lo68"] <= iv["median"] <= iv["hi68"] <= iv["hi95"]


@pytest.fixture
def toy_inputs(tmp_path):
    """A tiny, fully synthetic stand-in for the pipeline's inputs and the stage-4 posterior."""
    work = tmp_path / "work"
    work.mkdir()
    rng = np.random.default_rng(1)
    save_posterior(work / "posterior.json", np.c_[rng.normal(0.30, 0.02, 800), rng.normal(0.77, 0.01, 800)],
                   "unit-NPE", "unit", meta={"n_train": 100, "n_heldout": 10, "n_features": 5})
    mask = np.zeros(12 * 8 * 8, bool)
    mask[:200] = True
    save_map(tmp_path / "obs.npz", np.zeros(mask.size), mask,
             {"theta": {"Omega_m": 0.29, "S8": 0.76}, "source": "unit"})
    (tmp_path / "cfg.json").write_text('{"length": 5}')
    (tmp_path / "train.npz").write_bytes(b"pretend summaries")
    manifest = tmp_path / "manifest.json"
    manifest.write_text(json.dumps({"source": "unit toy", "layers": [{"name": "bin 0"}], "peaks": []}))
    args = ["--train", str(tmp_path / "train.npz"), "--observed", str(tmp_path / "obs.npz"),
            "--config", str(tmp_path / "cfg.json"), "--manifest", str(manifest),
            "--out", str(tmp_path / "inference.json"), "--workdir", str(work)]
    return tmp_path, args


def test_first_run_stores_params_and_second_run_loads_them(toy_inputs, monkeypatch):
    tmp, args = toy_inputs
    art = run_inference._main(args + ["--skip-train"])
    stored = json.loads((tmp / "inference.json").read_text())
    assert stored["fingerprint"] == run_inference.fingerprint(tmp / "obs.npz", tmp / "cfg.json", tmp / "train.npz")
    assert stored["map"] == {"source": "unit toy", "n_layers": 1}
    assert abs(stored["S8"]["median"] - 0.77) < 0.01 and abs(stored["Omega_m"]["median"] - 0.30) < 0.01
    assert abs(stored["sigma8"]["median"] - 0.77 / np.sqrt(0.30 / 0.3)) < 0.02
    assert stored["truth"] == {"Omega_m": 0.29, "S8": 0.76}
    assert json.loads((tmp / "manifest.json").read_text())["inference"] == "inference.json"
    assert art["fingerprint"] == stored["fingerprint"]

    # Second run: nothing may be recomputed (any stage that tried to run would blow up).
    def boom(*_a, **_k):
        raise AssertionError("inference stage ran despite a cache hit")

    monkeypatch.setattr(run_inference, "run_stage", boom)
    monkeypatch.setattr(planck_compare, "_main", boom)
    monkeypatch.setattr(publish_results, "publish", boom)
    again = run_inference._main(args + ["--skip-train"])
    assert again["fingerprint"] == stored["fingerprint"]


def test_changed_inputs_invalidate_the_cache(toy_inputs):
    tmp, args = toy_inputs
    run_inference._main(args + ["--skip-train"])
    before = json.loads((tmp / "inference.json").read_text())["fingerprint"]
    (tmp / "train.npz").write_bytes(b"different training summaries")
    run_inference._main(args + ["--skip-train"])
    assert json.loads((tmp / "inference.json").read_text())["fingerprint"] != before


def test_force_recomputes_even_on_a_hit(toy_inputs, monkeypatch):
    _, args = toy_inputs
    run_inference._main(args + ["--skip-train"])
    calls = []
    real = planck_compare._main
    monkeypatch.setattr(planck_compare, "_main", lambda a: (calls.append(1), real(a))[1])
    run_inference._main(args + ["--skip-train", "--force"])
    assert calls == [1]


def test_skip_train_without_a_posterior_fails_clearly(toy_inputs):
    tmp, args = toy_inputs
    (tmp / "work" / "posterior.json").unlink()
    with pytest.raises(SystemExit, match="posterior.json"):
        run_inference._main(args + ["--skip-train"])
