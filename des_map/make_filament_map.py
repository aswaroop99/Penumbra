#!/usr/bin/env python3
"""Render the DES Y3 mass map as a glowing "cosmic web" poster (Hubble-style blue filaments).

  python make_filament_map.py <karmma_dir> --out ../data/ [--width 3000] [--bins 0,1,2,3]

<karmma_dir> holds map_0.npy … map_99.npy (KaRMMa posterior samples, shape (4, n_in_mask))
and mask.fits (HEALPix nside 256, RING, equatorial).

What it does:
  1. Stacks the chosen tomographic bins (each divided by its own sample-to-sample rms, so the
     deep, noisier bins don't swamp the shallow ones) for the posterior mean and every sample.
  2. Smooths on the sphere with mask-aware normalised convolution (no edge bleed).
  3. Projects to a Lambert azimuthal equal-area image centred on the footprint, north up,
     east left.
  4. Traces the web: every pixel follows steepest descent into a void (κ minimum); voids shallower
     than --tau × rms are merged into their neighbour (a persistence cut, as in DisPerSE). The
     boundaries between voids run along the ridges joining peaks through saddles: the filaments.
  5. Repeats the tracing on all 100 samples. A filament's brightness is its κ times the fraction
     of samples with a filament nearby, so features the data doesn't pin down fade out.
  6. Composites glow + filaments + peak nodes, tone-maps, and writes (into --out):
       web_des.png        the poster
       web_des_kappa.png  the plain mass map in the same projection (RGBA, footprint only)
       web_des_grid.bin   quarter-res uint8 grid of κ/rms and persistence, for hover readouts
       web_des.json       projection, peaks, method parameters and an honest caption

Honest framing (put this next to the image): these are ridges in a *projected* mass map,
mass integrated along the line of sight toward DES source galaxies, smoothed to ~20′. They
trace large-scale structure in projection; they are not individual 3D filaments.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import healpy as hp
import numpy as np
from PIL import Image
from scipy import ndimage as ndi

NSIDE = 256


# ------------------------------------------------------------------ data
def load_samples(karmma_dir: Path, n_max: int):
    mask = hp.read_map(str(karmma_dir / "mask.fits"), dtype=np.float64) > 0.5
    files = sorted(karmma_dir.glob("map_*.npy"), key=lambda p: int(p.stem.split("_")[1]))[:n_max]
    samples = np.stack([np.load(f) for f in files])          # (n, 4, n_in_mask)
    return mask, samples


def stack_bins(samples, bins):
    """Per-pixel stack of the chosen bins, each in units of its own posterior rms."""
    sig = samples[:, bins].std(axis=0).mean(axis=-1)          # (nb,) typical posterior rms per bin
    return (samples[:, bins] / sig[None, :, None]).mean(axis=1)  # (n, n_in_mask)


def smooth_masked(values, mask, fwhm_arcmin):
    full = np.zeros(hp.nside2npix(NSIDE))
    full[mask] = values - values.mean()
    w = mask.astype(float)
    fw = np.radians(fwhm_arcmin / 60)
    num = hp.smoothing(full, fwhm=fw, iter=1, use_pixel_weights=False)
    den = hp.smoothing(w, fwhm=fw, iter=1, use_pixel_weights=False)
    return np.where(den > 0.3, num / np.maximum(den, 1e-6), 0.0)


# ------------------------------------------------------------------ projection
def footprint_centre(mask):
    v = np.array(hp.pix2vec(NSIDE, np.where(mask)[0])).mean(axis=1)
    ra, dec = hp.vec2ang(v / np.linalg.norm(v), lonlat=True)
    return float(ra[0]), float(dec[0])


def laea_inverse(x, y, ra0, dec0):
    """Lambert azimuthal equal-area, x increasing to the WEST (east-left sky convention)."""
    phi0, lam0 = np.radians(dec0), np.radians(ra0)
    rho = np.hypot(x, y)
    c = 2 * np.arcsin(np.clip(rho / 2, 0, 1))
    with np.errstate(invalid="ignore", divide="ignore"):
        dec = np.arcsin(np.cos(c) * np.sin(phi0) + np.where(rho > 0, y * np.sin(c) * np.cos(phi0) / rho, 0))
        ra = lam0 - np.arctan2(x * np.sin(c), rho * np.cos(phi0) * np.cos(c) - y * np.sin(phi0) * np.sin(c))
    return np.degrees(ra) % 360, np.degrees(dec)


def laea_forward(ra, dec, ra0, dec0):
    phi, lam = np.radians(dec), np.radians(ra)
    phi0, lam0 = np.radians(dec0), np.radians(ra0)
    k = np.sqrt(2 / (1 + np.sin(phi0) * np.sin(phi) + np.cos(phi0) * np.cos(phi) * np.cos(lam - lam0)))
    x = -k * np.cos(phi) * np.sin(lam - lam0)                  # minus: east to the left
    y = k * (np.cos(phi0) * np.sin(phi) - np.sin(phi0) * np.cos(phi) * np.cos(lam - lam0))
    return x, y


class Grid:
    def __init__(self, mask, width, pad=0.04):
        self.ra0, self.dec0 = footprint_centre(mask)
        ra, dec = hp.pix2ang(NSIDE, np.where(mask)[0], lonlat=True)
        x, y = laea_forward(ra, dec, self.ra0, self.dec0)
        x0, x1, y0, y1 = x.min(), x.max(), y.min(), y.max()
        span = max(x1 - x0, y1 - y0)
        x0, x1, y0, y1 = x0 - pad * span, x1 + pad * span, y0 - pad * span, y1 + pad * span
        self.w = width
        self.h = int(round(width * (y1 - y0) / (x1 - x0)))
        self.extent = (x0, x1, y0, y1)
        xs = np.linspace(x0, x1, self.w)
        ys = np.linspace(y1, y0, self.h)                       # row 0 = top = north
        X, Y = np.meshgrid(xs, ys)
        self.ra, self.dec = laea_inverse(X, Y, self.ra0, self.dec0)
        pix, wts = hp.get_interp_weights(NSIDE, self.ra.ravel(), self.dec.ravel(), lonlat=True)
        self._pix, self._wts = pix, wts
        self.arcmin_per_px = np.degrees((x1 - x0) / self.w) * 60
        inside = mask[hp.ang2pix(NSIDE, self.ra.ravel(), self.dec.ravel(), lonlat=True)].reshape(self.h, self.w)
        holes = ndi.binary_fill_holes(inside) & ~inside
        lab, n = ndi.label(holes)
        small = np.isin(lab, np.nonzero(ndi.sum(holes, lab, range(1, n + 1)) < (40 / self.arcmin_per_px) ** 2)[0] + 1)
        self.inside = inside | small

    def sample(self, m):
        return (m[self._pix] * self._wts).sum(axis=0).reshape(self.h, self.w)

    def to_px(self, ra, dec):
        x, y = laea_forward(np.asarray(ra), np.asarray(dec), self.ra0, self.dec0)
        x0, x1, y0, y1 = self.extent
        return (x - x0) / (x1 - x0) * (self.w - 1), (y1 - y) / (y1 - y0) * (self.h - 1)


# ------------------------------------------------------------------ web skeleton
def smooth_inside(img, inside, sigma_px):
    """Gaussian smoothing that ignores pixels outside the footprint (normalised convolution)."""
    w = inside.astype(float)
    num = ndi.gaussian_filter(np.where(inside, img, 0.0), sigma_px)
    den = ndi.gaussian_filter(w, sigma_px)
    return np.where(inside, num / np.maximum(den, 1e-6), 0.0)



def merge_shallow_basins(img, lab, tau):
    """Topological simplification: merge every void basin whose depth below its lowest saddle is
    < tau into the neighbour across that saddle (elder rule, processed in saddle order)."""
    a = np.concatenate([lab[:, 1:].ravel(), lab[1:, :].ravel()])
    b = np.concatenate([lab[:, :-1].ravel(), lab[:-1, :].ravel()])
    hgt = np.concatenate([np.maximum(img[:, 1:], img[:, :-1]).ravel(), np.maximum(img[1:, :], img[:-1, :]).ravel()])
    keep = (a != b) & (a > 0) & (b > 0)
    a, b, hgt = np.minimum(a[keep], b[keep]), np.maximum(a[keep], b[keep]), hgt[keep]
    if a.size == 0:
        return lab
    ids, inv = np.unique(np.concatenate([a, b]), return_inverse=True)
    ia, ib = inv[: a.size], inv[a.size:]
    order = np.lexsort((hgt, ib, ia))                       # per pair, lowest saddle first
    ia, ib, hgt = ia[order], ib[order], hgt[order]
    first = np.ones(ia.size, bool)
    first[1:] = (ia[1:] != ia[:-1]) | (ib[1:] != ib[:-1])
    ia, ib, hgt = ia[first], ib[first], hgt[first]
    depth = np.full(ids.size, np.inf)
    lab_flat, img_flat = lab.ravel(), img.ravel()
    m = np.isin(lab_flat, ids)
    np.minimum.at(depth, np.searchsorted(ids, lab_flat[m]), img_flat[m])

    parent = np.arange(ids.size)

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i
    for i in np.argsort(hgt, kind="stable"):
        ra, rb = find(ia[i]), find(ib[i])
        if ra == rb:
            continue
        young, old = (ra, rb) if depth[ra] > depth[rb] else (rb, ra)
        if hgt[i] - depth[young] < tau:
            parent[young] = old
    roots = np.array([find(i) for i in range(ids.size)])
    lut = np.zeros(lab.max() + 1, dtype=lab.dtype)
    lut[ids] = ids[roots]
    return np.where(lab > 0, lut[lab], 0)


def web_skeleton(img, inside, tau=0.0):
    """Filament network of a smooth 2D field: the boundaries between its void basins.

    Every pixel follows steepest descent (8-neighbour) down to a local minimum; pixels that
    drain to the same minimum form one void basin. Basin boundaries are the separatrices
    running along the ridges that connect peaks through saddles, the 2D analogue of DisPerSE
    filaments. Returns a boolean image of 1-px lines (footprint edge excluded) and the basins.
    """
    h, w = img.shape
    big = np.nanmax(img) + 1e3
    f = np.pad(np.where(inside, img, big), 1, constant_values=big)
    idx = np.arange(h * w).reshape(h, w)
    steepest, ptr = np.zeros_like(img), idx.copy()
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            if dy == dx == 0:
                continue
            # slope per unit length, so the descent follows the gradient rather than the lattice
            slope = (img - f[1 + dy:1 + dy + h, 1 + dx:1 + dx + w]) / np.hypot(dy, dx)
            better = slope > steepest
            steepest = np.where(better, slope, steepest)
            ptr = np.where(better, idx + dy * w + dx, ptr)
    ptr = np.where(inside, ptr, idx).ravel()
    for _ in range(int(np.ceil(np.log2(h * w))) + 1):       # pointer jumping to each pixel's minimum
        nxt = ptr[ptr]
        if np.array_equal(nxt, ptr):
            break
        ptr = nxt
    lab = np.where(inside.ravel(), ptr + 1, 0).reshape(h, w)
    if tau > 0:
        lab = merge_shallow_basins(img, lab, tau * np.std(img[inside]))
    line = np.zeros(img.shape, bool)
    for sa, sb in [((slice(None), slice(1, None)), (slice(None), slice(None, -1))),
                   ((slice(1, None), slice(None)), (slice(None, -1), slice(None)))]:
        diff = (lab[sa] != lab[sb]) & (lab[sa] > 0) & (lab[sb] > 0)
        # mark the higher of the two pixels so the line sits on the ridge side
        hi_a = img[sa] >= img[sb]
        line[sa] |= diff & hi_a
        line[sb] |= diff & ~hi_a
    return line, lab


# ------------------------------------------------------------------ colour
def lerp_cmap(stops):
    pos = np.array([p for p, _ in stops])
    cols = np.array([[int(c[i:i + 2], 16) / 255 for i in (1, 3, 5)] for _, c in stops])

    def f(t):
        t = np.clip(t, 0, 1)[..., None]
        return np.stack([np.interp(t[..., 0], pos, cols[:, k]) for k in range(3)], axis=-1)
    return f


GLOW = lerp_cmap([(0, "#000000"), (0.35, "#0b1350"), (0.7, "#2a2fa8"), (1, "#6a5cff")])
FIL = lerp_cmap([(0, "#000000"), (0.4, "#1f5fff"), (0.75, "#69b8ff"), (1, "#f2f8ff")])


def bloom(rgb, sigmas, gains):
    out = rgb.copy()
    for s, g in zip(sigmas, gains):
        out += g * ndi.gaussian_filter(rgb, (s, s, 0))
    return out


def tonemap(x, exposure):
    return 1 - np.exp(-exposure * x)


# ------------------------------------------------------------------ main
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("karmma_dir", type=Path)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--bins", default="0,1,2,3")
    ap.add_argument("--width", type=int, default=3000)
    ap.add_argument("--fwhm", type=float, default=20.0, help="sphere smoothing FWHM, arcmin")
    ap.add_argument("--samples", type=int, default=100)
    ap.add_argument("--persist-width", type=int, default=1200, help="grid width for the per-sample ridge pass")
    ap.add_argument("--peaks", type=int, default=40)
    ap.add_argument("--exposure", type=float, default=1.35)
    ap.add_argument("--web-smooth", type=float, default=14.0,
                    help="extra gaussian σ (arcmin) before tracing the web; larger = fewer, longer filaments")
    ap.add_argument("--tau", type=float, default=0.4,
                    help="persistence cut in units of the field rms: voids shallower than this are merged")
    ap.add_argument("--persist-radius", type=float, default=15.0, help="match radius between samples, arcmin")
    ap.add_argument("--cache", type=Path, default=None, help="npz cache of smoothed sample maps")
    args = ap.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    bins = [int(b) for b in args.bins.split(",")]

    mask, samples = load_samples(args.karmma_dir, args.samples)
    print(f"{samples.shape[0]} samples, {mask.sum()} in-mask pixels, bins {bins}")

    if args.cache and args.cache.exists():
        sm = np.load(args.cache)["sm"]
    else:
        st = stack_bins(samples, bins)
        sm = np.stack([smooth_masked(v, mask, args.fwhm) for v in st])   # (n, npix)
        if args.cache:
            np.savez_compressed(args.cache, sm=sm.astype(np.float32))
    mean_map = sm.mean(axis=0)
    std_map = sm.std(axis=0)

    # ---- full-resolution mean image
    g = Grid(mask, args.width)
    px = g.arcmin_per_px
    print(f"image {g.w}x{g.h}, {px:.2f}'/px, centre RA {g.ra0:.1f} Dec {g.dec0:.1f}")
    kap = g.sample(mean_map)
    snr = kap / np.maximum(g.sample(std_map), 1e-9)
    rms = float(np.std(kap[g.inside]))
    kap_n = kap / rms

    # edge taper: skeleton lines hugging the footprint boundary are artefacts
    dist = ndi.distance_transform_edt(g.inside) * px          # arcmin to edge
    edge = np.clip((dist - 15) / 40, 0, 1)
    soft_inside = ndi.gaussian_filter(g.inside.astype(float), 12 / px)

    # ---- the web, traced on the posterior mean
    sigma = args.web_smooth
    web, lab = web_skeleton(smooth_inside(kap_n, g.inside, sigma / px), g.inside, args.tau)
    n_voids = len(np.unique(lab)) - 1

    # ---- persistence: fraction of posterior samples with a filament within the match radius
    gp = Grid(mask, args.persist_width)
    radius = max(args.persist_radius, 0.6 * sigma)
    r_px = max(1, int(round(radius / gp.arcmin_per_px)))
    disk = np.hypot(*np.mgrid[-r_px:r_px + 1, -r_px:r_px + 1]) <= r_px
    hits = np.zeros((gp.h, gp.w))
    for m in sm:
        w, _ = web_skeleton(smooth_inside(gp.sample(m), gp.inside, sigma / gp.arcmin_per_px), gp.inside, args.tau)
        hits += ndi.binary_dilation(w, disk)
    persist = ndi.gaussian_filter(hits / len(sm), 0.7)
    persist = ndi.map_coordinates(persist, np.mgrid[0:gp.h - 1:g.h * 1j, 0:gp.w - 1:g.w * 1j], order=1)
    on_web = web & (edge > 0.5)
    frac_majority = float(np.mean(persist[on_web] >= 0.5))
    print(f"web σ={sigma}′ τ={args.tau}: {n_voids} voids; {frac_majority:.0%} of filament length "
          f"is in ≥50% of samples (match radius {radius:.0f}′)")

    # ---- compose
    # filament brightness: how much mass lies along it × how many samples agree it is there
    dens = np.clip((ndi.gaussian_filter(kap_n, 6 / px) + 0.6) / 2.6, 0, 1.4)
    trust = np.clip((persist - 0.2) / 0.5, 0, 1)
    fil = web * dens ** 1.6 * trust * edge
    half_w = 2.5 / px                                         # filament core, px
    fil = ndi.gaussian_filter(fil.astype(float), max(0.6, half_w)) * max(1.0, half_w) * 2.5
    rgb = bloom(FIL(np.clip(fil, 0, 1)) * np.clip(fil, 0, 1.5)[..., None] ** 0.3,
                sigmas=[5 / px, 18 / px, 55 / px], gains=[0.8, 0.45, 0.3])

    pos = np.clip(ndi.gaussian_filter(kap_n, 30 / px), 0, None)
    rgb += GLOW(np.clip(pos / 1.8, 0, 1)) * 0.6 * soft_inside[..., None]

    # nodes: the highest peaks of the mean map, brightness by height × filament persistence
    loc = (kap_n == ndi.maximum_filter(kap_n, size=int(90 / px) | 1)) & g.inside & (edge > 0.5) & (kap_n > 2.5)
    yy, xx = np.nonzero(loc)
    order = np.argsort(-kap_n[yy, xx])[: args.peaks]
    yy, xx = yy[order], xx[order]
    nodes = np.zeros((g.h, g.w))
    for y, x in zip(yy, xx):
        nodes[y, x] = (kap_n[y, x] - 2.0) * np.clip(persist[y, x] / 0.5, 0.3, 1)
    node_img = sum(ndi.gaussian_filter(nodes, s / px) * (s / px) ** 2 * a for s, a in [(4, 5.0), (12, 1.2), (40, 0.3)])
    rgb += node_img[..., None] * np.array([0.85, 0.92, 1.0])

    out = np.clip(tonemap(rgb, args.exposure) ** (1 / 1.1), 0, 1)
    Image.fromarray((out * 255).astype(np.uint8)).save(args.out / "web_des.png", optimize=True)

    # the plain mass map in the same projection, for side-by-side comparison
    cmap = lerp_cmap([(0, "#05040a"), (0.35, "#1b1145"), (0.55, "#3b2a8c"), (0.75, "#7a5cff"), (0.9, "#c9b8ff"), (1, "#ffffff")])
    half = (slice(None, None, 2), slice(None, None, 2))      # half resolution is plenty for a smooth field
    kimg = cmap(np.clip((kap_n[half] + 2.5) / 6.5, 0, 1))
    Image.fromarray((np.dstack([kimg, soft_inside[half][..., None]]) * 255).astype(np.uint8), "RGBA").save(
        args.out / "web_des_kappa.png", optimize=True)

    # hover grid: quarter resolution, 2 × uint8 per pixel (κ/rms, persistence); 255 = outside
    step = 4
    gk, gpst, gin = kap_n[::step, ::step], persist[::step, ::step], g.inside[::step, ::step]
    qk = np.where(gin, np.clip(np.round((gk + 4) / 10 * 254), 0, 254), 255).astype(np.uint8)
    qp = np.where(gin, np.clip(np.round(gpst * 254), 0, 254), 255).astype(np.uint8)
    np.stack([qk, qp], axis=-1).tofile(args.out / "web_des_grid.bin")

    peaks = []
    for y, x in zip(yy, xx):
        peaks.append({"ra": round(float(g.ra[y, x]), 3), "dec": round(float(g.dec[y, x]), 3),
                      "px": [int(x), int(y)], "kappa_over_rms": round(float(kap_n[y, x]), 2),
                      "snr": round(float(snr[y, x]), 2), "filament_persistence": round(float(persist[y, x]), 2)})
    meta = {
        "source": "DES Y3 KaRMMa mass-map posterior (Fiedorowicz et al. 2024), %d samples" % len(sm),
        "bins": bins,
        "smoothing_fwhm_arcmin": args.fwhm,
        "projection": {"type": "lambert_azimuthal_equal_area", "ra0": g.ra0, "dec0": g.dec0,
                       "extent": [float(v) for v in g.extent], "east": "left", "north": "up"},
        "shape": [g.h, g.w],
        "arcmin_per_px": px,
        "images": {"web": "web_des.png", "kappa": "web_des_kappa.png"},
        "grid": {"file": "web_des_grid.bin", "step": step, "shape": [int(gk.shape[0]), int(gk.shape[1])],
                 "channels": ["kappa_over_rms", "persistence"], "outside": 255,
                 "decode": {"kappa_over_rms": "q / 254 * 10 - 4", "persistence": "q / 254"}},
        "web": {"trace_sigma_arcmin": sigma, "persistence_cut_rms": args.tau, "voids": n_voids,
                "match_radius_arcmin": radius, "fraction_in_majority_of_samples": round(frac_majority, 3)},
        "brightness": "κ along the filament × fraction of posterior samples with a filament within the match radius",
        "caption": ("Ridges of the DES Y3 projected mass map: mass integrated along the line of sight toward "
                    "DES source galaxies (z≈0.2–1.3), smoothed to ~%d′. Each line separates two neighbouring "
                    "low-mass regions; brightness is the mass along it times the share of the %d posterior "
                    "samples that reproduce it. This traces large-scale structure in projection; it is not a map "
                    "of individual 3D filaments." % (round(args.fwhm), len(sm))),
        "peaks": peaks,
    }
    (args.out / "web_des.json").write_text(json.dumps(meta, indent=1, ensure_ascii=False))
    print("wrote", args.out)


if __name__ == "__main__":
    main()
