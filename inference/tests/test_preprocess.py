import numpy as np
import pytest

from preprocess import (
    HARTLAP_MARGIN,
    PreprocessError,
    check_observed,
    hartlap_inverse,
    load_training,
    prepare,
    split_indices,
)

NAMES = [f"f{i}" for i in range(4)]
CFG = {"names": NAMES}


def write_train(path, n=120, p=4, seed=0, names=NAMES, nan_rows=()):
    rng = np.random.default_rng(seed)
    x = rng.normal(5.0, 2.0, size=(n, p))
    theta = np.c_[rng.uniform(0.15, 0.45, n), rng.uniform(0.6, 0.95, n)]
    for r in nan_rows:
        x[r, 0] = np.nan
    np.savez(path, x=x, theta=theta, names=np.array(names), files=np.array([f"s{i}" for i in range(n)]))
    return x, theta


def test_split_is_deterministic_and_disjoint():
    tr1, ho1 = split_indices(200, 0.1, seed=3)
    tr2, ho2 = split_indices(200, 0.1, seed=3)
    assert np.array_equal(tr1, tr2) and np.array_equal(ho1, ho2)
    assert not set(tr1) & set(ho1)
    assert len(tr1) + len(ho1) == 200 and len(ho1) == 20
    assert not np.array_equal(ho1, split_indices(200, 0.1, seed=4)[1])


def test_split_never_starves_training_or_heldout():
    tr, ho = split_indices(60, 0.9, seed=0)  # huge fraction is capped
    assert len(tr) >= 50 and len(ho) >= 5
    tr, ho = split_indices(300, 0.0, seed=0)  # tiny fraction is raised
    assert len(ho) >= 5


@pytest.mark.parametrize("n", [0, 9, 54])
def test_split_refuses_too_few_simulations(n):
    with pytest.raises(PreprocessError, match="not enough"):
        split_indices(n, 0.1)


def test_zscore_uses_training_split_only(tmp_path):
    x, _ = write_train(tmp_path / "t.npz")
    prep = prepare(tmp_path / "t.npz", CFG, 0.1, seed=0)
    assert np.allclose(prep.mu, x[prep.tr].mean(0))
    assert not np.allclose(prep.mu, x.mean(0))  # the held-out rows must not leak into mu
    assert np.allclose(prep.z[prep.tr].mean(0), 0, atol=1e-9)
    assert np.allclose(prep.z[prep.tr].std(0), 1, atol=1e-6)


def test_sbi_and_mcmc_see_identical_preprocessing(tmp_path):
    write_train(tmp_path / "t.npz")
    a = prepare(tmp_path / "t.npz", CFG, 0.1, seed=7)
    b = prepare(tmp_path / "t.npz", CFG, 0.1, seed=7)
    assert np.array_equal(a.tr, b.tr) and np.array_equal(a.z, b.z)
    lo, hi = a.lo_hi
    assert np.all(lo >= a.theta.min(0)) and np.all(hi <= a.theta.max(0))


def test_nonfinite_rows_are_dropped_and_counted(tmp_path):
    write_train(tmp_path / "t.npz", n=120, nan_rows=(3, 9))
    x, theta, _, dropped = load_training(tmp_path / "t.npz", CFG)
    assert dropped == 2 and len(x) == len(theta) == 118 and np.all(np.isfinite(x))


def test_feature_name_mismatch_is_rejected(tmp_path):
    write_train(tmp_path / "t.npz", names=["a", "b", "c", "d"])
    with pytest.raises(PreprocessError, match="names"):
        load_training(tmp_path / "t.npz", CFG)
    write_train(tmp_path / "u.npz", p=5, names=NAMES + ["extra"])
    with pytest.raises(PreprocessError, match="features"):
        load_training(tmp_path / "u.npz", CFG)


def test_constant_feature_stays_finite(tmp_path):
    rng = np.random.default_rng(0)
    x = rng.normal(size=(100, 4))
    x[:, 2] = 3.0  # e.g. a peak bin that is always empty
    np.savez(tmp_path / "t.npz", x=x, theta=np.c_[rng.uniform(0.2, 0.4, 100), rng.uniform(0.7, 0.9, 100)],
             names=np.array(NAMES))
    prep = prepare(tmp_path / "t.npz", CFG)
    assert np.all(np.isfinite(prep.z))


def test_check_observed_flags_out_of_distribution():
    far, name, ood = check_observed([0.1, -0.2, 6.5, 0.0], NAMES)
    assert ood and name == "f2" and far == pytest.approx(6.5)
    assert not check_observed([0.1, 0.2, -4.9, 0.0], NAMES)[2]
    with pytest.raises(PreprocessError):
        check_observed([0.0, 1.0], NAMES)
    with pytest.raises(PreprocessError):
        check_observed([0.0, np.nan, 0.0, 0.0], NAMES)


def test_hartlap_requires_enough_fiducial_sims():
    p = 6
    rng = np.random.default_rng(0)
    icov, why = hartlap_inverse(rng.normal(size=(p + HARTLAP_MARGIN, p)))
    assert icov is None and "need >" in why
    icov, why = hartlap_inverse(rng.normal(size=(5 * p, p)))
    assert icov.shape == (p, p) and "Hartlap" in why
    # For identity covariance the corrected inverse is the Hartlap factor times ~identity
    assert 0.5 < np.trace(icov) / p < 1.5
