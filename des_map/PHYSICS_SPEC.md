# Physics spec — what the sims and inference must match

Owner: Arnav (science lane). Status: Oct 24 evening. Numbers verified against the papers cited.
**Rule zero:** whatever happens to the real map happens identically to every simulated map.

## 1. Data we have (validated)

| File | What it is | Checks |
|---|---|---|
| `des_y3/ks/des_y3/KS_full.fits` | DES Y3 Kaiser–Squires κ, all sources, nside 1024, RING, equatorial (no COORDSYS card) | correlates 0.87–0.89 with KaRMMa over the footprint; 0.01 if rotated → equatorial confirmed |
| `KS_tomo1..4.fits` | same, per tomographic bin | bins 1–3 correlate 0.43 / 0.56 / 0.73 with KaRMMa, rising with depth as expected; bin 4 still downloading |
| `karmma/…/map_*.npy` + `mask.fits` | KaRMMa posterior samples, 4 bins, nside 256 | 4096 deg², RA −61..98°, Dec −67..+5°. **Viewer only, never inference** (lognormal prior baked in) |

**Two properties of the KS files that matter:**
1. **Full sky, but only ~10% is data.** Curved-sky KS leaks signal past the survey edge, so pixels outside DES are nonzero (rms 6× lower). Always apply the footprint mask; there is no UNSEEN marking. Interim mask: KaRMMa `mask.fits` ud_graded (4096 deg² vs. DES's 4143 — close; swap in the official mask if we find it).
2. **Already filtered.** Jeffrey, Gatti et al. 2021 say "smoothed at 10 arcmin" without saying σ or FWHM. Measured from the map's noise spectrum (apodized mask): transfer ≈ 1 to ℓ ≈ 150, falls steeply by ℓ ≈ 400 (Cl/N = 0.63 at ℓ 200, 0.13 at 300, 0.016 at 400). Not a clean Gaussian; a local fit gives σ ≈ 16–19′. **The map has essentially no information above ℓ ≈ 400.**
   Noise level at large scales matches the paper's σ_e and n_eff, so the map is sound.

## 2. Verified numbers

DES Y3 sources (Amon et al. 2022, Table I; per-component σ_e):

| Bin | n_eff [arcmin⁻²] | σ_e | mean z | κ noise/pixel, nside 512 | nside 1024 |
|---|---|---|---|---|---|
| 1 | 1.476 | 0.243 | 0.336 | 0.0291 | 0.0582 |
| 2 | 1.479 | 0.262 | 0.521 | 0.0314 | 0.0627 |
| 3 | 1.484 | 0.259 | 0.742 | 0.0309 | 0.0619 |
| 4 | 1.461 | 0.301 | 0.964 | 0.0362 | 0.0725 |
| all | 5.590 | 0.268 | 0.633 | 0.0165 | 0.0330 |

σ_pix = σ_e / sqrt(n_eff · A_pix); A_pix = 47.2 arcmin² (nside 512), 11.8 (nside 1024). Footprint 4143 deg², 100.2M galaxies (Gatti et al. 2021).
Note: the shape-catalogue paper quotes σ_e = 0.261 for the full sample; Amon et al. Table I gives 0.268. Use the per-bin table.

CosmoGridV1 (Kacprzak et al. 2023): Stage-III projected maps nside 512, 4 bins with n(z) modeled on DES Y3 (via Fischbacher et al.), **no shape noise in the maps**, baryonified. Narrow-grid priors: Ωm 0.15–0.45, σ8 0.50–1.30, w0 −1.25 to −0.75, ns 0.93–1.00, Ωb 0.04–0.05, H0 65–75 (plus extra Ωm–σ8 cuts). Fiducial Ωm 0.26, σ8 0.84 → **S8_fid = 0.782**.

Comparison values: Planck 2018 TT,TE,EE+lowE+lensing S8 = 0.832 ± 0.013 (σ8 0.811 ± 0.006, Ωm 0.315 ± 0.007). DES Y3 cosmic shear ΛCDM S8 = 0.759 +0.025/−0.023 (2.3σ below Planck); ΛCDM-optimised 0.772 +0.018/−0.017.

## 3. Forward model the SBI lane must use (changes from the current `forward_model.py`)

Current code: sim κ + white pixel noise → mask. **That no longer matches the data**, whose noise has been through DES's filter. Unfixed, the sims carry far more small-scale power than the data, and S8 comes out biased with no error message.

Required order, per sim and per bin:
1. Load CosmoGrid κ for the matching bin (DES bin b ↔ CosmoGrid bin b). For `KS_full`, use the mean of the 4 CosmoGrid bins (DES n_eff per bin is equal to 1%, so equal weights).
2. Rotate to a disjoint footprint (3–4 per full-sky sim).
3. Add Gaussian shape noise with σ_pix from the table **at the resolution the filter is applied** (nside 512, or upgrade to 1024 to mirror the data).
4. **Apply the data's filter F(ℓ)** to signal + noise together.
5. Mask with the footprint, subtract the in-mask mean.

Measuring F(ℓ): once the 200 fiducial CosmoGrid sims exist, F²(ℓ) = Cl_data(ℓ) / ⟨Cl_fid sim + N⟩(ℓ) with the same apodized mask. Above ℓ ≈ 150 noise dominates, so F is nearly cosmology-independent there. Validate: fiducial sims run through steps 1–5 must reproduce the data's Cl within scatter. Also check whether the DES release page documents the exact smoothing — if it does, use that and skip the measurement.

Summary statistics, given the filter:
- Power spectrum: bins only up to ℓ ≈ 400 (nothing above). Default `summary_stats` goes to 3·nside — cut it.
- Peak counts: smoothing scales ≥ ~20′; smaller scales add nothing but filter mismatch.
- **Interim, before F(ℓ) is measured:** smoothing 30′+ and ℓ ≤ 150 only. Coarser, but robust to the filter. Do not demo numbers from unfiltered sims at small scales.

## 4. Parameter and prior notes

- CosmoGrid varies w0, so the flow's posterior is marginalized over wCDM; DES's 0.759 is ΛCDM. Either train on w0 near −1 (e.g. |w0+1| < 0.1, if enough sims remain) or say "wCDM-marginalized" next to the number.
- The prior on S8 is whatever the Sobol grid implies, not flat. Plot it next to the posterior.
- Use baryonified maps; DMO as a robustness check if time allows.
- Not modelled: intrinsic alignments, photo-z shifts (DES priors ~0.01–0.02 per bin), shear calibration (m ≈ −0.006 to −0.037 per bin). Shear bias m scales κ by (1+m): a ~2–4% effect on amplitude, comparable to our error bar. Say so.

## 5. Planck comparison and claims

- Report S8 median + 68% interval, the coverage-test fraction, and tension vs. Planck in σ (Gaussian approx: Δ / sqrt(σ_us² + σ_Planck²)).
- If we land near 0.76–0.79: "we reproduce the published DES lensing result, which, like other lensing surveys, sits below Planck." Never "we measured a new tension."
- KS map smoothing means individual bright spots are noise-dominated at ≲20′; viewer labels should say "candidate structure" unless KaRMMa's robustness map agrees.

## 6. Open items
- [ ] KS_tomo4 download finishing; validate like bins 1–3.
- [ ] Official DES footprint mask / exact KS smoothing from the release page.
- [ ] CosmoGrid file layout + streaming loop; then measure F(ℓ).
- [ ] Update `forward_model.py` with steps 3–4 (noise before filter).
