#!/usr/bin/env python3
"""The three data-handoff contracts for the dark matter map pipeline.

Freeze these on day 1 so every lane can build against mocks:

1. MAP        .npz  kappa: float32 (npix,) or (nbins, npix), RING ordering
                    mask:  bool (npix,)  True = observed
                    meta:  JSON string (nside, coord, source, bins, ...)
2. SUMMARY    fixed-length float vector + list of entry names (same length),
              produced by summary_stats.compute_summary with one frozen config.
3. POSTERIOR  JSON {"params": ["Omega_m", "S8"], "samples": [[om, s8], ...],
                    "method": str, "data": str, "meta": {...}}

CLI:
  python contracts.py validate FILE...        # checks .npz map or posterior .json
  python contracts.py mock --out-dir mocks/   # writes one mock of each contract
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

try:
    import healpy as hp
except ImportError:  # validation of posteriors still works without healpy
    hp = None

POSTERIOR_PARAMS = ["Omega_m", "S8"]


# ----------------------------------------------------------------------------- map
def save_map(path, kappa, mask, meta=None):
    """Write a map contract. kappa: (npix,) or (nbins, npix); mask: (npix,) bool."""
    kappa = np.asarray(kappa, dtype=np.float32)
    mask = np.asarray(mask, dtype=bool)
    meta = dict(meta or {})
    npix = mask.size
    meta.setdefault("nside", int(np.sqrt(npix / 12)))
    meta.setdefault("ordering", "RING")
    meta.setdefault("coord", "C")  # C = celestial/equatorial, G = galactic
    meta.setdefault("units", "convergence")
    kappa = np.where(mask, kappa, 0.0).astype(np.float32)  # never ship UNSEEN downstream
    validate_map_arrays(kappa, mask, meta)
    np.savez_compressed(path, kappa=kappa, mask=mask, meta=json.dumps(meta))
    return path


def load_map(path):
    """Read a map contract -> (kappa 2D (nbins, npix), mask, meta dict)."""
    with np.load(path, allow_pickle=False) as f:
        kappa, mask, meta = f["kappa"], f["mask"], json.loads(str(f["meta"]))
    validate_map_arrays(kappa, mask, meta)
    if kappa.ndim == 1:
        kappa = kappa[None, :]
    return kappa, mask, meta


def validate_map_arrays(kappa, mask, meta):
    npix = mask.size
    nside = int(meta.get("nside", 0))
    if 12 * nside * nside != npix:
        raise ValueError(f"mask has {npix} pixels, inconsistent with nside={nside}")
    if kappa.shape[-1] != npix:
        raise ValueError(f"kappa last axis {kappa.shape[-1]} != npix {npix}")
    if kappa.ndim not in (1, 2):
        raise ValueError("kappa must be (npix,) or (nbins, npix)")
    if meta.get("ordering", "RING") != "RING":
        raise ValueError("contract is RING ordering; convert with hp.reorder(m, n2r=True)")
    good = kappa[..., mask] if kappa.ndim == 2 else kappa[mask]
    if not np.all(np.isfinite(good)):
        raise ValueError("non-finite kappa inside mask")
    if np.any(np.abs(good) > 1e3):
        raise ValueError("kappa has huge values inside mask (UNSEEN pixels left in mask?)")
    if mask.sum() == 0:
        raise ValueError("mask is empty")


def fits_to_contract(fits_path, out_path, field=0, nside_out=None, coord="C", source=None):
    """Convert a HEALPix FITS map (e.g. a DES Y3 mass map) into the map contract."""
    if hp is None:
        raise ImportError("healpy required")
    m = hp.read_map(fits_path, field=field, dtype=np.float64)
    m = np.atleast_2d(m)
    mask = np.all(np.isfinite(m) & (m != hp.UNSEEN) & (np.abs(m) < 1e3), axis=0)
    m = np.where(mask, m, 0.0)
    nside = hp.npix2nside(m.shape[-1])
    if nside_out and nside_out != nside:
        mf = hp.ud_grade(mask.astype(float), nside_out)
        m = np.array([hp.ud_grade(np.where(mask, b, hp.UNSEEN), nside_out) for b in m])
        mask = (mf > 0.9) & np.all(m != hp.UNSEEN, axis=0)
        m = np.where(mask, m, 0.0)
    for b in range(m.shape[0]):  # mass-sheet: zero point is arbitrary
        m[b, mask] -= m[b, mask].mean()
    meta = {"coord": coord, "source": source or str(fits_path), "bins": m.shape[0]}
    return save_map(out_path, m.squeeze(), mask, meta)


# ------------------------------------------------------------------------- summary
def validate_summary(vec, names, expected_len=None):
    vec = np.asarray(vec, dtype=float)
    if vec.ndim != 1:
        raise ValueError("summary must be a 1-D vector")
    if len(names) != vec.size:
        raise ValueError(f"{vec.size} values but {len(names)} names")
    if expected_len is not None and vec.size != expected_len:
        raise ValueError(f"summary length {vec.size} != frozen length {expected_len}")
    if not np.all(np.isfinite(vec)):
        bad = [n for n, v in zip(names, vec) if not np.isfinite(v)]
        raise ValueError(f"non-finite summary entries: {bad[:5]}")
    return True


# ----------------------------------------------------------------------- posterior
def save_posterior(path, samples, method, data, meta=None):
    samples = np.asarray(samples, dtype=float)
    obj = {
        "params": POSTERIOR_PARAMS,
        "samples": np.round(samples, 6).tolist(),
        "method": method,
        "data": data,
        "meta": meta or {},
    }
    validate_posterior(obj)
    Path(path).write_text(json.dumps(obj))
    return path


def load_posterior(path):
    obj = json.loads(Path(path).read_text())
    validate_posterior(obj)
    return np.asarray(obj["samples"], dtype=float), obj


def validate_posterior(obj):
    if obj.get("params") != POSTERIOR_PARAMS:
        raise ValueError(f"params must be {POSTERIOR_PARAMS}, got {obj.get('params')}")
    s = np.asarray(obj["samples"], dtype=float)
    if s.ndim != 2 or s.shape[1] != 2 or s.shape[0] < 100:
        raise ValueError(f"samples must be (N>=100, 2); got {s.shape}")
    if not np.all(np.isfinite(s)):
        raise ValueError("non-finite posterior samples")
    if not (0.0 < s[:, 0].min() and s[:, 0].max() < 1.0):
        raise ValueError("Omega_m samples outside (0, 1): wrong column order?")
    # Swapped columns put S8 (~0.8) where Omega_m (~0.3) belongs; no plausible matter density is that high.
    if not (0.05 < np.median(s[:, 0]) < 0.7):
        raise ValueError("Omega_m median implausible: wrong column order?")
    if not (0.2 < np.median(s[:, 1]) < 1.5):
        raise ValueError("S8 median implausible: wrong column order or sigma8 instead of S8?")
    for k in ("method", "data"):
        if not obj.get(k):
            raise ValueError(f"posterior missing '{k}'")
    return True


# ---------------------------------------------------------------------------- mocks
def des_like_mask(nside):
    """Rough stand-in for the DES footprint: RA in (-60, 100) deg, Dec in (-65, -10)
    plus a Stripe-82-like strip. Only for mocks; use the real mask for analysis."""
    if hp is None:
        raise ImportError("healpy required")
    ra, dec = hp.pix2ang(nside, np.arange(12 * nside * nside), lonlat=True)
    ra = np.where(ra > 180, ra - 360, ra)
    wide = (ra > -60) & (ra < 100) & (dec > -65) & (dec < -10)
    strip = (ra > -60) & (ra < 60) & (dec > -2) & (dec < 2)
    return wide | strip


def write_mocks(out_dir, nside=128, seed=0):
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(seed)
    mask = des_like_mask(nside)
    kappa = rng.normal(0, 0.02, size=(4, 12 * nside * nside))
    save_map(out / "mock_map.npz", kappa, mask, {"source": "mock", "bins": 4})
    names = [f"feat_{i}" for i in range(20)]
    (out / "mock_summary.json").write_text(json.dumps({"names": names, "values": rng.normal(size=20).tolist()}))
    om = rng.normal(0.30, 0.03, 2000)
    s8 = rng.normal(0.77, 0.02, 2000)
    save_posterior(out / "mock_posterior.json", np.c_[om, s8], "mock", "mock")
    return out


def _main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    v = sub.add_parser("validate")
    v.add_argument("files", nargs="+")
    m = sub.add_parser("mock")
    m.add_argument("--out-dir", default="mocks")
    m.add_argument("--nside", type=int, default=128)
    c = sub.add_parser("from-fits", help="convert a HEALPix FITS map to the map contract")
    c.add_argument("fits")
    c.add_argument("--out", required=True)
    c.add_argument("--field", default="0", help="column(s), e.g. 0 or 0,1,2,3")
    c.add_argument("--nside", type=int, default=None)
    c.add_argument("--coord", default="C")
    a = ap.parse_args(argv)

    if a.cmd == "mock":
        print("wrote mocks to", write_mocks(a.out_dir, a.nside))
    elif a.cmd == "from-fits":
        field = tuple(int(x) for x in a.field.split(","))
        field = field[0] if len(field) == 1 else field
        print("wrote", fits_to_contract(a.fits, a.out, field, a.nside, a.coord))
    else:
        ok = True
        for f in a.files:
            try:
                if f.endswith(".npz"):
                    k, msk, meta = load_map(f)
                    print(f"OK  map {f}: bins={k.shape[0]} nside={meta['nside']} fsky={msk.mean():.3f}")
                else:
                    s, obj = load_posterior(f)
                    print(f"OK  posterior {f}: n={len(s)} S8 median={np.median(s[:,1]):.3f} ({obj['method']})")
            except Exception as e:  # report every file, then fail
                ok = False
                print(f"BAD {f}: {e}")
        sys.exit(0 if ok else 1)


if __name__ == "__main__":
    _main()
