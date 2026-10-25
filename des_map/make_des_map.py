#!/usr/bin/env python3
"""Turn a downloaded DES Y3 mass map into our map contract, a rendered map, and viewer layers.

  python make_des_map.py des_data/des_y3/<kappa_E>.fits --out map_out/
  python make_des_map.py E.fits --bmode B.fits --out map_out/          # adds the B-mode null test
  python make_des_map.py maps.fits --field 0,1,2,3 --out map_out/      # 4 tomographic bins
  python make_des_map.py karmma_samples.npy --out map_out_karmma/      # sample stack -> mean + std

What it does, in order (the order matters; see the skill's "one idea"):
  1. Reads the header and reports NSIDE / ORDERING / COORDSYS / columns. healpy
     reorders NESTED to RING on read; a galactic map is rotated to equatorial.
  2. Builds the mask from UNSEEN / NaN (or exact zeros if the file uses 0 for
     "not observed", which is reported), or from --mask.
  3. ud_grades to the analysis nside (default 512 = CosmoGridV1), thresholds the
     mask at 0.9, subtracts the in-mask mean (mass-sheet degeneracy).
  4. Saves the MAP contract (kappa, mask, meta) -> data.npz. This is the file the
     inference lane uses; forward_model.py --mask-from data.npz copies its mask.
  5. Sanity checks against DES Y3 numbers (footprint ~4143 deg^2, equatorial,
     Dec mostly < +5 deg) and writes report.json.
  6. Renders des_mass_map.png (smoothed for display only) and a quick-look power
     spectrum (E vs B if given). The power spectrum here is descriptive; the
     inference summaries come from summary_stats.py with the frozen config, applied
     identically to data and sims.
  7. Exports viewer layers with pipeline/export_view.py -> viewer_data/.

Display smoothing (default 15 arcmin) is for looking at the map only; it never
touches data.npz.
"""
import argparse
import json
import subprocess
import sys
from pathlib import Path

import healpy as hp
import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "pipeline"))
from contracts import load_map, save_map  # noqa: E402

DES_Y3_AREA = 4143.0  # deg^2, Jeffrey, Gatti et al. 2021
VIEW = {"ra": (-65.0, 105.0), "dec": (-68.0, 8.0)}


# ------------------------------------------------------------------ reading
def read_any(path, field):
    """Return (maps[nb, npix] float64 RING, info dict)."""
    path = Path(path)
    info = {"file": path.name}
    if path.suffix in (".npy", ".npz"):
        arr = np.load(path)
        if isinstance(arr, np.lib.npyio.NpzFile):
            key = "kappa" if "kappa" in arr.files else arr.files[0]
            info["npz_keys"] = arr.files
            arr = arr[key]
        arr = np.atleast_2d(np.asarray(arr, dtype=np.float64))
        info.update(ordering="RING (assumed for .npy)", coordsys="C (assumed)", shape=list(arr.shape))
        return arr, info
    m, header = hp.read_map(str(path), field=field, h=True, dtype=np.float64)
    h = dict(header)
    cols = [v for k, v in header if k.startswith("TTYPE")]
    info.update(nside=h.get("NSIDE"), ordering=h.get("ORDERING", "?"), coordsys=h.get("COORDSYS", "?"),
                columns=cols, field=field)
    return np.atleast_2d(m), info


def build_mask(maps, info, mask_path=None):
    if mask_path:
        mk = hp.read_map(str(mask_path)) if str(mask_path).endswith(("fits", "fits.gz")) else np.load(mask_path)
        mk = np.asarray(mk)
        if mk.size != maps.shape[-1]:
            mk = hp.ud_grade(mk.astype(float), hp.npix2nside(maps.shape[-1])) > 0.5
        info["mask_source"] = f"file {Path(mask_path).name}"
        return (mk > 0.5) & (mk != hp.UNSEEN) & np.all(np.isfinite(maps), axis=0)
    good = np.all(np.isfinite(maps) & (maps != hp.UNSEEN) & (np.abs(maps) < 1e3), axis=0)
    zeros = np.all(maps == 0.0, axis=0)
    if good.mean() > 0.95 and zeros.mean() > 0.5:
        info["mask_source"] = "exact zeros treated as unobserved (no UNSEEN pixels in file)"
        return good & ~zeros
    info["mask_source"] = "UNSEEN / NaN pixels"
    return good


def to_equatorial(maps, mask, info):
    cs = str(info.get("coordsys", "C")).upper()[:1]
    if cs == "G":
        rot = hp.Rotator(coord=["G", "C"])
        maps = np.array([rot.rotate_map_pixel(np.where(mask, b, 0.0)) for b in maps])
        mask = rot.rotate_map_pixel(mask.astype(float)) > 0.9
        info["rotated"] = "galactic -> equatorial"
    return maps, mask


def degrade(maps, mask, nside_out):
    nside = hp.npix2nside(maps.shape[-1])
    if nside_out == nside:
        return maps, mask
    mf = hp.ud_grade(mask.astype(float), nside_out)
    out = np.array([hp.ud_grade(np.where(mask, b, hp.UNSEEN), nside_out) for b in maps])
    newmask = (mf > 0.9) & np.all(out != hp.UNSEEN, axis=0)
    return np.where(newmask, out, 0.0), newmask


def smooth_masked(m, mask, arcmin):
    """Normalised smoothing so the footprint edge doesn't drag values toward zero."""
    f = np.radians(arcmin / 60.0)
    num = hp.smoothing(np.where(mask, m, 0.0), fwhm=f)
    den = hp.smoothing(mask.astype(float), fwhm=f)
    out = np.where(den > 0.5, num / np.maximum(den, 1e-6), 0.0)
    return np.where(mask, out, 0.0)


def pseudo_cl(m, mask, nbins=14):
    nside = hp.npix2nside(m.size)
    fsky = mask.mean()
    cl = hp.anafast(np.where(mask, m - m[mask].mean(), 0.0), lmax=3 * nside - 1) / fsky
    edges = np.unique(np.geomspace(30, 3 * nside - 1, nbins + 1).astype(int))
    ell = np.arange(cl.size)
    lc, cb = [], []
    for lo, hi in zip(edges[:-1], edges[1:]):
        s = slice(lo, hi)
        lc.append(float(ell[s].mean()))
        cb.append(float(cl[s].mean()))
    return np.array(lc), np.array(cb)


# ------------------------------------------------------------------ checks
def sanity(kappa_b0, mask, info, nside):
    area = float(mask.sum() * hp.nside2pixarea(nside, degrees=True))
    ra, dec = hp.pix2ang(nside, np.flatnonzero(mask), lonlat=True)
    ra = np.where(ra > 180, ra - 360, ra)
    rep = {
        "nside_analysis": nside,
        "area_deg2": round(area, 1),
        "area_vs_DES_Y3": round(area / DES_Y3_AREA, 3),
        "ra_range_deg": [round(float(np.percentile(ra, 0.5)), 1), round(float(np.percentile(ra, 99.5)), 1)],
        "dec_range_deg": [round(float(np.percentile(dec, 0.5)), 1), round(float(np.percentile(dec, 99.5)), 1)],
        "kappa_rms_pixel": float(np.std(kappa_b0[mask])),
        "warnings": [],
    }
    if not 0.7 < rep["area_vs_DES_Y3"] < 1.3:
        rep["warnings"].append(f"footprint {area:.0f} deg2 is far from DES Y3's ~{DES_Y3_AREA:.0f} deg2: wrong mask or partial map?")
    if np.percentile(dec, 95) > 15:
        rep["warnings"].append("much of the footprint is north of Dec +15: map may be in galactic coordinates "
                               "with no COORDSYS header. Re-run with --coord G.")
    if rep["kappa_rms_pixel"] > 0.2 or rep["kappa_rms_pixel"] < 1e-4:
        rep["warnings"].append(f"pixel kappa rms {rep['kappa_rms_pixel']:.3g} is implausible "
                               "(expect ~0.01-0.05 at nside 512 for a noisy KS map)")
    return rep


# ------------------------------------------------------------------ figure
def render(kappa, mask, bmode, smoothing, out_png, title):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from export_view import project

    ks = smooth_masked(kappa, mask, smoothing)
    img, ra, dec = project(ks, mask, VIEW["ra"], VIEW["dec"], 2000)
    lim = np.nanpercentile(np.abs(img), 99.5)

    fig = plt.figure(figsize=(14, 8.4), facecolor="#0b0d12")
    gs = fig.add_gridspec(2, 3, height_ratios=[2.3, 1], hspace=0.32, wspace=0.28)
    ax = fig.add_subplot(gs[0, :])
    im = ax.imshow(img, extent=[ra[0], ra[-1], dec[-1], dec[0]], cmap="inferno", vmin=-lim * 0.6, vmax=lim,
                   interpolation="bilinear", aspect="equal")
    ax.set_xlabel("Right ascension [deg]  (east to the left)")
    ax.set_ylabel("Declination [deg]")
    ax.set_title(f"{title}   ·   smoothed {smoothing:.0f}′ for display", color="w", loc="left")
    cb = fig.colorbar(im, ax=ax, fraction=0.025, pad=0.01)
    cb.set_label("convergence κ  (bright = more projected mass)")

    # E vs B power
    axp = fig.add_subplot(gs[1, 0:2])
    l, ce = pseudo_cl(kappa, mask)
    axp.loglog(l, l * (l + 1) * ce / (2 * np.pi), "o-", color="#ffb347", label="E-mode (κ map)")
    if bmode is not None:
        l, cbm = pseudo_cl(bmode, mask)
        axp.loglog(l, l * (l + 1) * cbm / (2 * np.pi), "s--", color="#7fb3ff", label="B-mode (null: noise only)")
    axp.set_xlabel("multipole ℓ")
    axp.set_ylabel("ℓ(ℓ+1)Cℓ/2π  (pseudo, ÷f_sky)")
    axp.set_title("Quick-look power spectrum (descriptive only)", color="w", loc="left", fontsize=10)
    axp.legend(frameon=False)

    # footprint on the full sky
    axm = fig.add_subplot(gs[1, 2], projection="mollweide")
    nside = hp.npix2nside(mask.size)
    th, ph = np.radians(np.linspace(89, -89, 180)), np.radians(np.linspace(180, -180, 360))
    PH, TH = np.meshgrid(ph, th)
    pix = hp.ang2pix(nside, np.degrees(PH) % 360, np.degrees(TH), lonlat=True)
    axm.pcolormesh(-PH, TH, mask[pix].astype(float), cmap="Greys_r", shading="auto", vmin=0, vmax=1.6)
    axm.set_xticklabels([])
    axm.set_yticklabels([])
    axm.set_title(f"Footprint: {mask.mean() * 41253:.0f} deg² of sky", color="w", fontsize=10)

    for a in (ax, axp):
        a.set_facecolor("#0b0d12")
        a.tick_params(colors="#c8ccd6")
        a.xaxis.label.set_color("#c8ccd6")
        a.yaxis.label.set_color("#c8ccd6")
        for s in a.spines.values():
            s.set_color("#3a3f4b")
    cb.ax.yaxis.label.set_color("#c8ccd6")
    cb.ax.tick_params(colors="#c8ccd6")
    axp.legend(frameon=False, labelcolor="#c8ccd6")
    fig.savefig(out_png, dpi=130, facecolor=fig.get_facecolor(), bbox_inches="tight")
    plt.close(fig)


# ------------------------------------------------------------------ main
def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("map", help="FITS (.fits/.fits.gz) or .npy/.npz HEALPix map")
    ap.add_argument("--field", default="0", help="FITS column(s): 0, or 0,1,2,3 for tomographic bins")
    ap.add_argument("--bmode", default=None, help="B-mode map file (same format) for the null test")
    ap.add_argument("--mask", default=None, help="separate mask file, if the release ships one")
    ap.add_argument("--coord", default=None, help="override header COORDSYS (C or G)")
    ap.add_argument("--nside", type=int, default=512, help="analysis nside (512 matches CosmoGridV1)")
    ap.add_argument("--display-smoothing", type=float, default=15.0, help="arcmin, display only")
    ap.add_argument("--bin-names", nargs="*", default=None)
    ap.add_argument("--out", default="map_out")
    ap.add_argument("--title", default="DES Y3 weak-lensing mass map")
    a = ap.parse_args(argv)

    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    field = tuple(int(x) for x in a.field.split(","))
    field = field[0] if len(field) == 1 else field

    maps, info = read_any(a.map, field)
    if a.coord:
        info["coordsys"] = a.coord
    if maps.shape[0] > 4:  # a stack of posterior samples (e.g. KaRMMa), not tomographic bins
        info["samples"] = int(maps.shape[0])
        std = maps.std(axis=0)
        maps = maps.mean(axis=0, keepdims=True)
        print(f"  {info['samples']} samples -> using the posterior mean; per-pixel std saved as sample_std.npy")
    else:
        std = None
    print("header:", json.dumps(info))

    mask = build_mask(maps, info, a.mask)
    maps, mask = to_equatorial(maps, mask, info)
    maps, mask = degrade(maps, mask, a.nside)
    for b in range(maps.shape[0]):
        maps[b, mask] -= maps[b, mask].mean()

    bmode = None
    if a.bmode:
        bm, _ = read_any(a.bmode, field if isinstance(field, int) else field[0])
        bmask = build_mask(bm, {}, a.mask)
        bm, bmask = to_equatorial(bm, bmask, info)
        bm, _ = degrade(bm, bmask, a.nside)
        bmode = np.where(mask, bm[0] - bm[0][mask].mean(), 0.0)

    meta = {"source": info["file"], "coord": "C", "bins": int(maps.shape[0]),
            "bin_names": a.bin_names, "nside": a.nside, "header": info,
            "note": "real data: no theta. Mean subtracted in mask. Process sims identically."}
    save_map(out / "data.npz", maps.squeeze(), mask, meta)
    if bmode is not None:
        save_map(out / "data_bmode.npz", bmode, mask, {**meta, "source": Path(a.bmode).name, "bins": 1})
    if std is not None:
        np.save(out / "sample_std.npy", hp.ud_grade(std, a.nside).astype(np.float32))
    load_map(out / "data.npz")  # round-trip through the validator

    rep = sanity(maps[0], mask, info, a.nside)
    rep["header"] = info
    ks = smooth_masked(maps[0], mask, a.display_smoothing)
    rep["kappa_rms_smoothed"] = {f"{a.display_smoothing:.0f}arcmin": float(np.std(ks[mask]))}
    if bmode is not None:
        bs = smooth_masked(bmode, mask, a.display_smoothing)
        rep["bmode_rms_smoothed"] = float(np.std(bs[mask]))
        rep["E_over_B_rms"] = round(rep["kappa_rms_smoothed"][f"{a.display_smoothing:.0f}arcmin"] / rep["bmode_rms_smoothed"], 3)
    (out / "report.json").write_text(json.dumps(rep, indent=2))
    for w in rep["warnings"]:
        print("  WARNING:", w)

    render(maps[0], mask, bmode, a.display_smoothing, out / "des_mass_map.png", a.title)

    cmd = [sys.executable, str(HERE / "pipeline" / "export_view.py"), "--map", str(out / "data.npz"),
           "--out", str(out / "viewer_data"), "--smoothing", str(a.display_smoothing),
           "--ra", str(VIEW["ra"][0]), str(VIEW["ra"][1]), "--dec", str(VIEW["dec"][0]), str(VIEW["dec"][1])]
    if a.bin_names:
        cmd += ["--layer-names", *a.bin_names]
    subprocess.run(cmd, check=True)

    print(json.dumps({k: rep[k] for k in ("area_deg2", "ra_range_deg", "dec_range_deg", "kappa_rms_pixel")}, indent=1))
    print(f"wrote {out}/data.npz, report.json, des_mass_map.png, viewer_data/")


if __name__ == "__main__":
    main()
