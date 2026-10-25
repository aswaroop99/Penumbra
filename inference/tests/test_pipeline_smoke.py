"""Reduced end-to-end run of the toy pipeline (nside 64, one bin, ~60 sims).

Checks the plumbing and the contracts between stages, not the physics: accuracy
and calibration are checked on the full four-bin toy run described in
inference/README.md. Takes about a minute on a laptop CPU.
"""
import json

import numpy as np
import pytest

import mcmc_baseline
import planck_compare
import publish_results
import summary_stats
import toy_sims
import train_sbi
from contracts import load_posterior


@pytest.fixture(scope="module")
def run(tmp_path_factory):
    w = tmp_path_factory.mktemp("smoke")
    toy_sims._main(["--n", "62", "--n-fid", "24", "--nside", "64", "--bins", "1", "--out", str(w / "toy")])
    summary_stats._main(["make-config", "--maps", str(w / "toy/fid_*.npz"), "--smoothing", "110",
                         "--out", str(w / "cfg.json")])
    for name, pat in (("train", "sim_*"), ("fid", "fid_*")):
        summary_stats._main(["batch", "--maps", str(w / f"toy/{pat}.npz"), "--config", str(w / "cfg.json"),
                             "--out", str(w / f"{name}.npz")])
    common = ["--train", str(w / "train.npz"), "--observed", str(w / "toy/obs.npz"),
              "--config", str(w / "cfg.json"), "--fiducial", str(w / "fid.npz"), "--min-train", "40"]
    train_sbi._main(common + ["--out", str(w / "posterior.json"), "--n-samples", "600"])
    mcmc_baseline._main(common + ["--out", str(w / "posterior_mcmc.json"), "--steps", "300"])
    planck_compare._main(["--posterior", str(w / "posterior.json"), "--compare", str(w / "posterior_mcmc.json"),
                          "--out", str(w / "results")])
    return w


def test_posteriors_satisfy_the_contract_and_share_preprocessing(run):
    s, sbi_obj = load_posterior(run / "posterior.json")
    m, mc_obj = load_posterior(run / "posterior_mcmc.json")
    assert len(s) == 600 and len(m) > 100
    assert sbi_obj["meta"]["n_train"] == mc_obj["meta"]["n_train"]  # same split => comparable
    assert sbi_obj["meta"]["seed"] == mc_obj["meta"]["seed"]
    assert "Hartlap" in mc_obj["meta"]["cov_source"]  # 24 fiducial sims > 14 + 5 features


def test_coverage_file_reports_trust_checks(run):
    cov = json.loads((run / "posterior_coverage.json").read_text())
    assert cov["n_heldout"] >= 5 and len(cov["S8_rank_histogram"]) == 10
    assert set(cov["empirical"]) == {"Omega_m", "S8"}
    assert cov["fiducial_S8_bias"]["n"] == 24
    assert "flagged" in cov["out_of_distribution"]


def test_publish_builds_a_valid_map_bound_artifact(run):
    manifest = {"source": "toy_sims (not physics)", "layers": [{"name": "bin 0"}], "peaks": []}
    mpath = run / "manifest.json"
    mpath.write_text(json.dumps(manifest))
    art = publish_results.publish(run / "posterior.json", run / "results/s8_comparison.json", mpath,
                                  run / "inference.json", truth_map=run / "toy/obs.npz", max_points=300)
    on_disk = json.loads((run / "inference.json").read_text())
    assert on_disk["version"] == 1 and on_disk["synthetic"] is True
    assert on_disk["map"] == {"source": "toy_sims (not physics)", "n_layers": 1}
    assert len(on_disk["samples"]) == 300
    assert on_disk["truth"] == {"Omega_m": 0.29, "S8": 0.76}
    assert on_disk["trust"]["n_heldout"] >= 5 and on_disk["comparison"]["mcmc"] is not None
    assert json.loads(mpath.read_text())["inference"] == "inference.json"
    s8 = on_disk["S8"]
    assert s8["lo95"] <= s8["lo68"] <= s8["median"] <= s8["hi68"] <= s8["hi95"]
    assert np.isclose(art["S8"]["median"], s8["median"])
