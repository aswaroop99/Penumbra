import json

import numpy as np
import pytest

from contracts import load_map, load_posterior, save_map, save_posterior, validate_posterior, write_mocks


def good_posterior(n=500, seed=0):
    rng = np.random.default_rng(seed)
    return np.c_[rng.normal(0.30, 0.03, n), rng.normal(0.77, 0.02, n)]


def test_posterior_roundtrip(tmp_path):
    s = good_posterior()
    save_posterior(tmp_path / "p.json", s, "unit", "test", meta={"k": 1})
    back, obj = load_posterior(tmp_path / "p.json")
    assert back.shape == s.shape and np.allclose(back, s, atol=1e-6)
    assert obj["params"] == ["Omega_m", "S8"] and obj["meta"] == {"k": 1}


def base_obj(**over):
    obj = {"params": ["Omega_m", "S8"], "samples": good_posterior().tolist(), "method": "m", "data": "d"}
    obj.update(over)
    return obj


@pytest.mark.parametrize(
    "bad",
    [
        {"params": ["S8", "Omega_m"]},
        {"samples": good_posterior(50).tolist()},  # too few
        {"samples": good_posterior()[:, ::-1].tolist()},  # swapped columns
        {"method": ""},
        {"data": ""},
    ],
)
def test_posterior_rejects_bad_input(bad):
    with pytest.raises(ValueError):
        validate_posterior(base_obj(**bad))


def test_posterior_rejects_nan():
    s = good_posterior()
    s[3, 1] = np.nan
    with pytest.raises(ValueError):
        validate_posterior(base_obj(samples=s.tolist()))


def test_map_roundtrip_and_validation(tmp_path):
    nside = 8
    npix = 12 * nside**2
    mask = np.zeros(npix, bool)
    mask[:200] = True
    k = np.random.default_rng(0).normal(0, 0.02, npix)
    save_map(tmp_path / "m.npz", k, mask, {"theta": {"Omega_m": 0.3, "S8": 0.8}})
    kk, mm, meta = load_map(tmp_path / "m.npz")
    assert kk.shape == (1, npix) and mm.sum() == 200 and meta["theta"]["S8"] == 0.8
    assert np.all(kk[0, ~mm] == 0)  # nothing outside the footprint ships downstream
    bad = k.copy()
    bad[5] = np.nan
    with pytest.raises(ValueError):
        save_map(tmp_path / "bad.npz", bad, mask)


def test_mocks_validate(tmp_path):
    out = write_mocks(tmp_path, nside=16)
    _, obj = load_posterior(out / "mock_posterior.json")
    assert json.loads((out / "mock_summary.json").read_text())["names"]
    assert obj["method"] == "mock"
