#!/usr/bin/env python3
"""Put the inferred S8 next to Planck (and published DES Y3), with honest wording.

  python planck_compare.py --posterior posterior.json --out results/ \
      [--coverage posterior_coverage.json] [--compare posterior_mcmc.json]

Writes results/s8_comparison.json (a fact sheet the AI explainer can read
verbatim) and results/s8_comparison.png.

Tension here is the simple Gaussian approximation |dS8| / sqrt(s1^2 + s2^2) on the
1-D S8 marginal. Published analyses use full-parameter-space metrics, so call
this "approximately N sigma".
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from contracts import load_posterior  # noqa: E402

REFERENCES = {
    "planck2018": {"label": "Planck 2018 (CMB, TT,TE,EE+lowE+lensing)", "S8": 0.832, "err": 0.013,
                   "Omega_m": 0.315, "Omega_m_err": 0.007, "cite": "Planck Collaboration 2020, A&A 641, A6"},
    "desy3_shear": {"label": "DES Y3 cosmic shear (fiducial)", "S8": 0.759, "err_hi": 0.025, "err_lo": 0.023,
                    "cite": "Amon et al. 2022 / Secco, Samuroff et al. 2022 (PRD 105, 023514/023515)",
                    "note": "2.3 sigma below Planck in their full analysis"},
}


def summarize(s):
    q = np.quantile(s, [0.025, 0.16, 0.5, 0.84, 0.975])
    return {"median": float(q[2]), "lo68": float(q[1]), "hi68": float(q[3]), "lo95": float(q[0]),
            "hi95": float(q[4]), "sigma": float((q[3] - q[1]) / 2)}


def statement(s8, t_planck, t_des, coverage68=None):
    direction = "below" if s8["median"] < REFERENCES["planck2018"]["S8"] else "above"
    num = f"S8 = {s8['median']:.3f} (68% interval {s8['lo68']:.3f} to {s8['hi68']:.3f})"
    if t_planck < 1:
        core = f"{num}, consistent with Planck's CMB value within 1 sigma."
    elif t_planck < 2:
        core = (f"{num}, about {t_planck:.1f} sigma {direction} Planck. That is not statistically significant; "
                "published lensing surveys see a similar mild offset.")
    elif t_planck < 3:
        core = (f"{num}, about {t_planck:.1f} sigma {direction} Planck, comparable to the offset DES Y3 itself "
                "reported (2.3 sigma). This reproduces the known 'S8 tension' pattern; it is not a new measurement.")
    else:
        core = (f"{num}, about {t_planck:.1f} sigma from Planck, larger than published DES Y3 analyses find. "
                "Before claiming anything, suspect a data-vs-simulation mismatch in the pipeline.")
    des = (f" It agrees with the published DES Y3 cosmic-shear value (difference {t_des:.1f} sigma)."
           if t_des < 2 else f" It differs from the published DES Y3 value by {t_des:.1f} sigma, which needs explaining.")
    trust = ""
    if coverage68 is not None:
        trust = (f" On held-out simulations, the true S8 fell inside our 68% interval {coverage68:.0%} of the time"
                 f"{' (well calibrated)' if abs(coverage68 - 0.68) < 0.08 else ' (miscalibrated: treat error bars with care)'}.")
    return core + des + trust


def _main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--posterior", required=True)
    ap.add_argument("--coverage", default=None)
    ap.add_argument("--compare", default=None, help="second posterior (e.g. MCMC baseline) to overlay")
    ap.add_argument("--out", default="results")
    a = ap.parse_args(argv)

    samples, obj = load_posterior(a.posterior)
    s8, om = summarize(samples[:, 1]), summarize(samples[:, 0])
    P, D = REFERENCES["planck2018"], REFERENCES["desy3_shear"]
    t_p = abs(s8["median"] - P["S8"]) / np.hypot(s8["sigma"], P["err"])
    d_err = D["err_hi"] if s8["median"] > D["S8"] else D["err_lo"]
    t_d = abs(s8["median"] - D["S8"]) / np.hypot(s8["sigma"], d_err)

    cov68 = None
    cov_path = a.coverage or str(Path(a.posterior).with_name(Path(a.posterior).stem + "_coverage.json"))
    if Path(cov_path).exists():
        cov68 = json.loads(Path(cov_path).read_text())["empirical"]["S8"][1]

    res = {
        "our_S8": s8, "our_Omega_m": om, "method": obj["method"], "data": obj["data"],
        "tension_vs_planck_sigma_gaussian_approx": round(float(t_p), 2),
        "difference_vs_desy3_sigma": round(float(t_d), 2),
        "heldout_coverage_68": cov68,
        "references": REFERENCES,
        "statement": statement(s8, t_p, t_d, cov68),
        "caveats": [
            "Tension uses a 1-D Gaussian approximation, not the full-parameter metrics of published work.",
            "Simulations use simplified noise and may not match the survey redshift distribution exactly.",
            "This is a validated reimplementation of a published-style analysis, not an independent discovery.",
        ],
    }
    if a.compare:
        s2, o2 = load_posterior(a.compare)
        c = summarize(s2[:, 1])
        res["comparison_posterior"] = {"method": o2["method"], "S8": c,
                                       "difference_sigma": round(abs(c["median"] - s8["median"]) / np.hypot(c["sigma"], s8["sigma"]), 2)}

    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "s8_comparison.json").write_text(json.dumps(res, indent=1))

    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    fig, ax = plt.subplots(1, 2, figsize=(10, 4))
    ax[0].hist(samples[:, 1], bins=60, density=True, histtype="stepfilled", alpha=0.5, label=f"this work ({obj['method']})")
    if a.compare:
        ax[0].hist(s2[:, 1], bins=60, density=True, histtype="step", lw=1.5, label=o2["method"])
    ax[0].axvspan(P["S8"] - P["err"], P["S8"] + P["err"], color="C3", alpha=0.25, label="Planck 2018")
    ax[0].axvspan(D["S8"] - D["err_lo"], D["S8"] + D["err_hi"], color="C2", alpha=0.25, label="DES Y3 shear")
    ax[0].set_xlabel("S8"); ax[0].set_yticks([]); ax[0].legend(fontsize=8)
    idx = np.random.default_rng(0).choice(len(samples), min(4000, len(samples)), replace=False)
    ax[1].scatter(samples[idx, 0], samples[idx, 1], s=2, alpha=0.3)
    ax[1].errorbar(P["Omega_m"], P["S8"], xerr=P["Omega_m_err"], yerr=P["err"], fmt="o", color="C3", label="Planck 2018")
    ax[1].set_xlabel("Omega_m"); ax[1].set_ylabel("S8"); ax[1].legend(fontsize=8)
    fig.tight_layout()
    fig.savefig(out / "s8_comparison.png", dpi=150)
    print(res["statement"])


if __name__ == "__main__":
    _main()
