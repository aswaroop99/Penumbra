import json
import sys
from pathlib import Path

import healpy as hp
import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from contracts import load_map
from map_reader.science import DISPLAY_ONLY_SOURCE, freeze_config
from map_reader.viewer_source import viewer_to_map


def _site(tmp_path, h=180, w=360):
    """A fake website export: two plate-carree layers, NaN outside a box footprint."""
    bounds = {"ra_min": -60.0, "ra_max": 60.0, "dec_min": -60.0, "dec_max": 0.0}
    ra = np.linspace(bounds["ra_max"], bounds["ra_min"], w)
    dec = np.linspace(bounds["dec_max"], bounds["dec_min"], h)
    RA, DEC = np.meshgrid(ra, dec)
    layers = []
    for b in range(2):
        g = 0.001 * np.sin(np.radians(RA) * 6 + b) * np.cos(np.radians(DEC) * 4)
        g[(RA > 30) | (DEC < -50)] = np.nan          # unobserved
        name = f"layer_bin{b}.f16.bin"
        g.astype("<f2").tofile(tmp_path / name)
        layers.append({"name": f"bin {b}", "png": f"l{b}.png", "raw": name, "shape": [h, w],
                       "vmin": -0.001, "vmax": 0.001, "sigma": 0.0005})
    manifest = {"source": "TEST site map", "coord": "C", "smoothing_arcmin": 10, "bounds": bounds,
                "layers": layers, "peaks": []}
    (tmp_path / "manifest.json").write_text(json.dumps(manifest))
    return tmp_path / "manifest.json"


def test_viewer_grids_become_matching_map_contract(tmp_path):
    out = viewer_to_map(_site(tmp_path), tmp_path / "m.npz", nside=64)
    k, mask, meta = load_map(out)
    assert k.shape == (2, hp.nside2npix(64)) and meta["source"] == "TEST site map"
    ra, dec = hp.pix2ang(64, np.flatnonzero(mask), lonlat=True)
    ra = np.where(ra > 180, ra - 360, ra)
    # Nothing is kept outside the observed box (allowing half a grid cell of interpolation).
    assert ra.max() <= 30.5 and dec.min() >= -50.5 and ra.min() >= -60 and dec.max() <= 0
    assert np.allclose(k[:, mask].mean(axis=1), 0, atol=1e-6)
    assert any("Resampled" in w for w in meta["analysis_warnings"])


def test_display_only_config_is_marked_and_blocked_from_sbi(tmp_path, monkeypatch):
    out = viewer_to_map(_site(tmp_path), tmp_path / "m.npz", nside=64)
    with pytest.raises(ValueError, match="theta"):
        freeze_config([str(out)], [150], n_ell=3, width=256)
    cfg = freeze_config([str(out)], [150], n_ell=3, width=256, display_only=True)
    assert cfg["map_reader"]["display_only"] is True
    assert cfg["map_reader"]["reference_sources"] == [DISPLAY_ONLY_SOURCE]
    (tmp_path / "cfg.json").write_text(json.dumps(cfg))
    from map_reader import __main__ as cli
    monkeypatch.setattr(sys, "argv", ["map_reader", "batch", "--maps", str(out),
                                      "--config", str(tmp_path / "cfg.json"), "--out", str(tmp_path / "x.npz")])
    with pytest.raises(ValueError, match="display-only"):
        cli.main()
