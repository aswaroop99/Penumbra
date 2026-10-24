# Project Handoff — "Mapping the Dark Universe" (Cal Hacks 2026)

*Paste this into a new chat to get fully caught up. It states what's decided, what's optional, and the honest caveats.*

---

## What the project is

An interactive, explainable tool that reconstructs a map of the invisible **dark matter** across a patch of real sky from public telescope data, lets a small neural network read the universe's parameters off that map, and adds a **citizen-science layer** so it feels tangible. Two things make our version distinctive rather than a reproduction: (1) a **fly-through interactive map** anyone can explore, and (2) a **Galaxy Zoo citizen-science cross-check** connecting where galaxies merge to where the dark matter is.

One-liner: *"We photographed the invisible 85% of the universe's matter, let AI read its recipe off the map, and tied it to what citizen scientists see."*

Team: 3 people. Timeline: 3 days (Cal Hacks). Constraint: compute-light — laptop-scale, our only real spend is LLM API credits. No big GPU training required.

---

## The decided scope

**Core pipeline (committed):**
```
Public dark-matter (convergence) map  →  summary statistics (peak counts + power spectrum)
     →  simulation-based inference (small normalizing flow) infers Ωm, S8
     →  compare to Planck  →  AI layer explains  →  interactive fly-through viewer
```
- Inference method: **simulation-based inference (SBI)** via the `sbi` package (neural posterior estimation / a small normalizing flow). This is the ML centerpiece — NOT a big CNN. Trains on CPU in minutes.
- Baseline safety net: a classic MCMC fit (`emcee`) on the same statistics.
- Headline number: **S8** (how clumpy the universe is), placed against the Planck satellite's value — the well-known lensing-vs-CMB tension.

**Distinctive addition 1 — the fly-through map (committed):**
A smooth, explorable viewer of the dark matter map that you can pan/zoom/"fly through" — the point is to make invisible structure (clusters, voids, filaments) tangible and visceral for a non-expert. If we use tomographic (redshift-binned) maps, the depth layers can give a pseudo-3D fly-through; otherwise it's a rich 2D pan/zoom. This is a core demo piece, not a nice-to-have.

**Distinctive addition 2 — Galaxy Zoo citizen-science layer (committed):**
Use **Galaxy Zoo** citizen-classified galaxy data — specifically morphology and **merger rates / merger fractions** — as an independent, human-generated layer. The science question: *do galaxy mergers happen preferentially where dark matter is densest?* Mergers trace dense environments, so overlaying citizen-identified mergers on the dark matter density map is a real, tangible "luminous activity vs. invisible mass" cross-check. This is the "citizen science" hook that makes the project feel grounded in human observation rather than pure pipeline.

**Optional / stretch (not committed):**
- VLM "map reader" that narrates structures in the map (API-only, cheap).
- Crowd-annotation layer (let viewers flag/label structures, Zooniverse-style) — a possible extension of the citizen-science theme.
- A learned (CNN) summary statistic instead of hand-picked peaks — costs GPU credits, stretch only.
- DES × Planck cross-map consistency test.

---

## Data (all public, free, no credentials)

| Source | Role | Notes |
|---|---|---|
| DES Y3 released convergence (mass) maps | the real dark matter map | pre-made HEALPix — download, don't reconstruct from raw 100M-galaxy catalog |
| CosmoGridV1 | simulated maps across cosmologies — SBI training set | precomputed; no N-body to run |
| Galaxy Zoo classifications | citizen merger/morphology layer | public; drives the mergers-vs-density cross-check |
| Planck 2018 parameters | the S8 comparison point | a published number |

Tractability rule: use **released maps** for real data and **precomputed sims** for training. Reconstructing from the raw shear catalog (Kaiser–Squires) is optional, one small sky patch only, never on the critical path.

---

## Team split (3 lanes, parallel)

| Person | Owns | Demo brag |
|---|---|---|
| **AI teammate** | the inference engine — `sbi` flow, training on sims, the coverage/trust check | "My network reads the universe's parameters off a map." |
| **CS/EE teammate** | pipeline + the fly-through viewer — map handling, summary statistics (signal processing), the interactive explorer | "I turned raw sky data into a map of invisible matter you can fly through." |
| **You** | science + AI explainer + Galaxy Zoo layer + integration — correctness, Planck framing, the mergers-vs-density cross-check, the LLM layer | "I made it real science, tied it to citizen data, and made the AI explain it." |

Parallelization trick: freeze **three data-handoff contracts** on the first morning — (1) map = HEALPix numpy array, (2) summary = fixed-length vector, (3) posterior = samples over (Ωm, S8) as JSON — then everyone builds against mock data. One real end-to-end integration, end of day 2.

---

## Timeline

- **Day 1 — map + numbers.** Lock the three contracts. Render the real map (instant wow). Implement peak counts + power spectrum on real and sim maps. Start SBI training. Pull Galaxy Zoo merger data.
- **Day 2 — inference + citizen layer + AI.** Train the flow on CosmoGridV1; validate it recovers known cosmologies on held-out sims (the trust check). Run on the real map → first (Ωm, S8). Stand up MCMC baseline. Overlay Galaxy Zoo mergers on the density map. Wire the LLM explainer. Integrate end-to-end together in the evening.
- **Day 3 — fly-through + polish + demo.** Build out the fly-through interactions, polish the explainer, finalize the mergers-vs-density figure, rehearse. Freeze early.

---

## Honest caveats (so we don't get caught flat-footed)

- **The core science method is established, not novel.** Dark-matter mass mapping and SBI cosmology from lensing are published (DeepMass 2019; DES Y3 / HSC SBI analyses). A from-scratch weekend version is a reproduction. **Our genuine contribution is the packaging** — an accessible, explainable, fly-through tool with a citizen-science (Galaxy Zoo) cross-check and an AI explainer. Pitch it as "we made a frontier measurement runnable and legible," not "we discovered."
- **Amateur/citizen telescopes CANNOT contribute to a weak-lensing map** — it needs professional sub-percent galaxy-shape measurements. Our citizen-science angle is **Galaxy Zoo data (classification/labeling)**, not citizen-collected images. Don't claim citizen scopes fed the map.
- **Don't overclaim the tension.** If we recover a known S8 on known data, the honest statement is "we built a validated reimplementation and tied it to citizen merger data," not "we measured a new tension."
- **Fly-through depth:** the mass map is fundamentally 2D (projected) or a few redshift slices (tomographic). A true 3D fly-through is pseudo-3D from redshift layers; a 2D rich pan/zoom is the safe fallback.

---

## Deliverables

1. **Demo:** an explorable (fly-through) dark matter map, a one-click cosmological measurement shown vs. Planck, the Galaxy Zoo mergers-vs-density overlay, and an AI that explains it all out loud — each teammate demoing their own piece.
2. **Afterlife (bonus, not the focus):** the result is solid enough to write up as a short citable note (RNAAS) later, but the product stands on its own.

---

## Stack
Python: `healpy`, `numpy`/`scipy`, `lenspack`/`lenstools` (stats), `sbi` (inference), `emcee` (baseline); Galaxy Zoo data (public tables); LLM/VLM via hackathon API credits; a lightweight React or Plotly/deck.gl-style viewer for the fly-through.

## Key references
- DeepMass: dark matter map reconstruction from DES (arXiv:1908.00543)
- DES Y3 curved-sky mass maps (arXiv:2105.13539)
- `sbi` toolkit (arXiv:2007.09114)
- CosmoGridV1 simulations (arXiv:2209.04662)
- Galaxy Zoo (citizen morphology/merger classifications — galaxyzoo.org / Zooniverse)
