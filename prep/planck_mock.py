"""What Planck's cosmology predicts the COSMOS 3D mass map should look like.

The Planck CMB map itself has no depth: it is one surface at z ~ 1090, far behind COSMOS, and its
spots don't trace the COSMOS clumps. What Planck does pin down is the cosmology (how much matter
there is, Omega_m, and how clumpy it has grown, sigma_8 / S8). So we:
  1. Simulate the matter along the COSMOS sightline (z 0..3) for the Planck 2018 cosmology:
     60 thin slabs, each a lognormal random field with CAMB's nonlinear (halofit) power spectrum.
  2. Lens every real COSMOS galaxy (real position, real photo-z with ~0.04(1+z) scatter for the
     true redshift) through those slabs (Born approximation, reduced shear).
  3. Add real shape noise: each galaxy's measured shape, rotated by a random angle.
  4. Run exactly the same 3D reconstruction as the real map (prep/cosmos_3d.py).
The real and Planck-predicted volumes then share resolution, noise and survey footprint, so they can
be compared directly. The comparison is statistical: a random universe with Planck's cosmology, not
a model of the actual structures behind COSMOS. As a control we also run shape noise with no lensing.

Writes data/planck_mock/: a few realizations in the cosmos_3d.f32.bin format, and planck_mock.json
with peak-count statistics for real data, Planck mocks and noise-only runs.

Usage:  .venv/bin/python prep/planck_mock.py          (N_MOCK=20 N_NOISE=20 by default)
"""
import json
import os
import sys
import time

import camb
import numpy as np
from scipy.ndimage import gaussian_filter, map_coordinates

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cosmos_3d as c3  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data/planck_mock")

# Planck 2018 (TT,TE,EE+lowE+lensing) base LCDM
PLANCK = dict(H0=67.4, ombh2=0.0224, omch2=0.120, mnu=0.06, ns=0.965, As=2.10e-9)
N_MOCK = int(os.environ.get("N_MOCK", 20))
N_NOISE = int(os.environ.get("N_NOISE", 20))
N_EXPORT = 3                         # realizations written for the viewer
SLAB_EDGES = np.round(np.arange(0.0, 3.0001, 0.05), 3)
GRID = 512                           # simulation grid, 0.5' pixels (256' periodic box around the 85' field)
PHOTOZ_SCATTER = 0.04
THRESHOLDS = [2.0, 2.5, 3.0, 3.5, 4.0]


def planck_power():
    p = camb.CAMBparams()
    p.set_cosmology(H0=PLANCK["H0"], ombh2=PLANCK["ombh2"], omch2=PLANCK["omch2"], mnu=PLANCK["mnu"])
    p.InitPower.set_params(As=PLANCK["As"], ns=PLANCK["ns"])
    p.set_matter_power(redshifts=[0.0], kmax=10)
    p.NonLinear = camb.model.NonLinear_both
    res = camb.get_results(p)
    s8 = float(res.get_sigma8_0())
    om = (PLANCK["ombh2"] + PLANCK["omch2"] + PLANCK["mnu"] / 93.14) / (PLANCK["H0"] / 100) ** 2
    pk = camb.get_matter_power_interpolator(p, nonlinear=True, hubble_units=False, k_hunit=False,
                                            kmax=300, zmax=3.1, extrap_kmax=3000)
    return pk, res, dict(sigma8=round(s8, 4), omega_m=round(om, 4), S8=round(s8 * np.sqrt(om / 0.3), 4))


def slab_spectra(pk, res):
    """2D power of the slab-averaged density contrast on the grid, per slab (Limber):
    C_l = P(k = (l + 0.5) / chi, z) / (chi^2 * dchi)."""
    dth = np.radians(c3.PIX_ARCMIN / 60)
    kx = np.fft.fftfreq(GRID, d=dth) * 2 * np.pi
    ell = np.sqrt(kx[None, :] ** 2 + kx[:, None] ** 2)
    zmid = 0.5 * (SLAB_EDGES[1:] + SLAB_EDGES[:-1])
    chi_e = res.comoving_radial_distance(SLAB_EDGES)
    chi = res.comoving_radial_distance(zmid)
    dchi = np.diff(chi_e)
    spectra = []
    for z, c, dc in zip(zmid, chi, dchi):
        k = (ell + 0.5) / c
        cl = pk.P(z, np.clip(k, 1e-4, 2999)) / (c ** 2 * dc)
        cl[0, 0] = 0
        # Lognormal field: convert the target correlation to the Gaussian field's correlation.
        xi = np.fft.ifft2(cl / dth ** 2).real           # pixel covariance
        xi_g = np.log1p(np.clip(xi, -0.99, None))
        pg = np.clip(np.fft.fft2(xi_g).real, 0, None)  # Gaussian-field power per mode (pixel units)
        spectra.append((np.sqrt(pg), float(xi_g[0, 0])))
    return zmid, chi, dchi, spectra


def gaussian_to_shear(delta):
    """Inverse Kaiser-Squires on the periodic grid, same axis convention as cosmos_3d.kaiser_squires."""
    k1, k2 = np.meshgrid(np.fft.fftfreq(GRID), np.fft.fftfreq(GRID))
    ksq = k1 ** 2 + k2 ** 2; ksq[0, 0] = 1
    D = np.fft.fft2(delta)
    return np.fft.ifft2((k1 ** 2 - k2 ** 2) / ksq * D).real, np.fft.ifft2(2 * k1 * k2 / ksq * D).real


def signal_variance(d, signs):
    """Lensing signal in the all-source 2D mass map: variance of the E mode minus the B mode
    (shape noise and most systematics put equal power in both; lensing only adds E)."""
    _, _, x, y, edges = c3.sky_grid(d)
    hist = lambda v: np.histogram2d(y, x, bins=[edges, edges], weights=v)[0]
    sg = c3.SMOOTH_ARCMIN / c3.PIX_ARCMIN
    w = d.weight.values
    W = gaussian_filter(hist(w), sg)
    cover = W > 0.25 * np.median(W[W > 0])
    g1 = gaussian_filter(hist(w * signs[0] * d.gamma1.values), sg) / np.maximum(W, 1e-9)
    g2 = gaussian_filter(hist(w * signs[1] * d.gamma2.values), sg) / np.maximum(W, 1e-9)
    g1[~cover] = 0; g2[~cover] = 0
    E, B = c3.kaiser_squires(g1, g2)
    return float(E[cover].var() - B[cover].var())


def make_mocker(d, signs, res, slabs, rng):
    """Returns mock_catalog(lensing: bool) -> a copy of the catalog with simulated shears."""
    zmid, chi, dchi, spectra = slabs
    # Galaxy pixel coordinates on the simulation grid (field centred in the box).
    _, _, x, y, _ = c3.sky_grid(d)
    coords = np.vstack([y.values / c3.PIX_ARCMIN + GRID / 2, x.values / c3.PIX_ARCMIN + GRID / 2])
    zs = d.zphot.values
    pref = 1.5 * c3.OM * (100 * c3.H / c3.C_KMS) ** 2
    e_obs = d.gamma1.values * signs[0] + 1j * d.gamma2.values * signs[1]

    def mock_catalog(lensing):
        noise = e_obs * np.exp(2j * rng.uniform(0, np.pi, len(d)))
        if not lensing:
            g = noise
        else:
            z_true = np.clip(zs + PHOTOZ_SCATTER * (1 + zs) * rng.standard_normal(len(d)), 0.01, None)
            chi_s = res.comoving_radial_distance(z_true)
            kap = np.zeros(len(d)); g1 = np.zeros(len(d)); g2 = np.zeros(len(d))
            for l, (amp, var_g) in enumerate(spectra):
                W = pref * (1 + zmid[l]) * chi[l] * dchi[l] * np.clip((chi_s - chi[l]) / chi_s, 0, None)
                if not W.any():
                    continue
                G = np.fft.ifft2(amp * np.fft.fft2(rng.standard_normal((GRID, GRID)))).real
                delta = np.exp(G - var_g / 2) - 1
                s1, s2 = gaussian_to_shear(delta)
                sel = W > 0
                cs = coords[:, sel]
                kap[sel] += W[sel] * map_coordinates(delta, cs, order=1, mode="wrap")
                g1[sel] += W[sel] * map_coordinates(s1, cs, order=1, mode="wrap")
                g2[sel] += W[sel] * map_coordinates(s2, cs, order=1, mode="wrap")
            g = (g1 + 1j * g2) / (1 - kap) + noise    # reduced shear plus shape noise (weak-shear limit)
        m = d.copy()
        m["gamma1"] = g.real * signs[0]; m["gamma2"] = g.imag * signs[1]   # undo signs: reconstruct re-applies them
        return m
    return mock_catalog


def main():
    os.makedirs(OUT, exist_ok=True)
    t0 = time.time()
    quiet = lambda *a: None
    d = c3.load_catalog()
    meta_real = json.load(open(os.path.join(ROOT, "data/cosmos/cosmos_3d.json")))
    signs = tuple(meta_real["shear_signs"])

    print("real data…")
    _, _, _, ex_real = c3.reconstruct(d, signs=signs, log=quiet)

    pk, res, cosmo = planck_power()
    print("Planck cosmology:", cosmo)
    mock_catalog = make_mocker(d, signs, res, slab_spectra(pk, res), np.random.default_rng(2026))

    def counts(ex):
        v = ex["peak_values"]
        return [int((v >= t).sum()) for t in THRESHOLDS]

    runs = {"planck": [], "noise": []}
    for kind, n in [("planck", N_MOCK), ("noise", N_NOISE)]:
        for i in range(n):
            cat = mock_catalog(kind == "planck")
            view, faint, meta, ex = c3.reconstruct(cat, signs=signs, log=quiet)
            runs[kind].append(dict(counts=counts(ex), max=round(float(ex["peak_values"].max()), 2),
                                   signal_var=signal_variance(cat, signs), peaks=meta["peaks"][:5]))
            if kind == "planck" and i < N_EXPORT:
                view.tofile(os.path.join(OUT, f"planck_mock_{i}.f32.bin"))
                faint.tofile(os.path.join(OUT, f"planck_mock_{i}_faint.f32.bin"))
            print(f"  {kind} {i + 1}/{n}: peaks >= {THRESHOLDS} : {runs[kind][-1]['counts']}, "
                  f"max {runs[kind][-1]['max']}σ  ({time.time() - t0:.0f}s)")

    def summary(rs):
        a = np.array([r["counts"] for r in rs])
        return dict(mean=np.round(a.mean(0), 2).tolist(), std=np.round(a.std(0), 2).tolist(),
                    p16=np.percentile(a, 16, axis=0).tolist(), p84=np.percentile(a, 84, axis=0).tolist(),
                    max_peak_mean=round(float(np.mean([r["max"] for r in rs])), 2),
                    max_peak_std=round(float(np.std([r["max"] for r in rs])), 2),
                    signal_var_mean=float(np.mean([r["signal_var"] for r in rs])),
                    signal_var_std=float(np.std([r["signal_var"] for r in rs])),
                    signal_var_values=[r["signal_var"] for r in rs])

    out = dict(
        title="Planck-cosmology prediction for the COSMOS 3D mass map",
        cosmology=dict(name="Planck 2018 base LCDM", **cosmo, H0=PLANCK["H0"], ns=PLANCK["ns"]),
        method=("Lognormal matter field in %d slabs (z %.2f-%.2f) with CAMB halofit power; real COSMOS galaxy "
                "positions and photo-z (true z scattered by %.2f(1+z)); Born-approximation reduced shear; real "
                "shape noise (measured shapes, randomly rotated); then the same reconstruction as the real map "
                "(prep/cosmos_3d.py)." % (len(SLAB_EDGES) - 1, SLAB_EDGES[0], SLAB_EDGES[-1], PHOTOZ_SCATTER)),
        caveat=("A random universe with Planck's cosmology, statistically like the real one. It does not model the "
                "actual structures behind COSMOS, so individual clumps are not expected to line up."),
        files=[f"planck_mock_{i}.f32.bin" for i in range(min(N_EXPORT, N_MOCK))],
        faint_files=[f"planck_mock_{i}_faint.f32.bin" for i in range(min(N_EXPORT, N_MOCK))],
        grid_like="../cosmos/cosmos_3d.json (same shape, bounds, redshift axis and layout)",
        thresholds=THRESHOLDS,
        peak_counts_note="Number of separate 3D peaks in the analysis cube at or above each significance (sigma).",
        real=dict(counts=counts(ex_real), max=round(float(ex_real["peak_values"].max()), 2),
                  signal_var=signal_variance(d, signs)),
        signal_var_note=("Variance of the E-mode minus the B-mode all-source mass map (2' smoothing): the lensing "
                         "signal with shape noise subtracted. Lower = less clumpy."),
        planck=dict(n=N_MOCK, **summary(runs["planck"])),
        noise_only=dict(n=N_NOISE, **summary(runs["noise"])),
        runs=runs,
    )
    json.dump(out, open(os.path.join(OUT, "planck_mock.json"), "w"), indent=1)
    print(json.dumps({k: out[k] for k in ("cosmology", "real", "planck", "noise_only")}, indent=1))
    print(f"wrote {OUT} in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
