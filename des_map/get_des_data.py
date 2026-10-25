#!/usr/bin/env python3
"""Fetch the public DES Y3 weak-lensing mass maps onto your machine.

Standard library only (Python 3.8+), so it runs on any laptop without installs.

Two sources:

  karmma   KaRMMa DES Y3 mass-map posterior samples (Fiedorowicz et al. 2024,
           arXiv:2403.05484), Zenodo record 10672062. Pretty, robust maps for the
           fly-through viewer and for "which structures are real?" animations.
           Not for SBI inference (lognormal prior baked in).

  des      The DES Y3 curved-sky mass maps (Jeffrey, Gatti et al. 2021,
           arXiv:2105.13539), hosted on the DES data-release server. The paper
           points to des.ncsa.illinois.edu/releases; the file server behind it is
           desdr-server.ncsa.illinois.edu/despublic/y3a2_files/. File names are
           not documented in the paper, so this crawls the listing and reports
           every file that looks like a mass/convergence map. Use the KS map
           (non-tomographic or the 4 tomographic bins) for inference.

Usage
  python get_des_data.py list                       # show what's available, download nothing
  python get_des_data.py karmma --out des_data/     # download the KaRMMa record
  python get_des_data.py des --out des_data/        # download matching DES files
  python get_des_data.py des --match ks --out des_data/   # only names containing "ks"
  python get_des_data.py url URL --out des_data/    # download one file you found by hand

Downloads resume if interrupted (HTTP Range) and print sizes before starting.
"""
import argparse
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from html.parser import HTMLParser
from pathlib import Path

ZENODO_KARMMA = "https://zenodo.org/api/records/10672062"
DES_ROOT = "https://desdr-server.ncsa.illinois.edu/despublic/y3a2_files/"
MAP_NAME = re.compile(r"(mass|kappa|convergence|karmma|massmap|mass_map|_ks|ks_)", re.I)
MAP_EXT = re.compile(r"\.(fits|fit|fits\.gz|fits\.fz|npy|npz|h5|hdf5|hdf|tar|tar\.gz|tgz|zip)$", re.I)
UA = {"User-Agent": "calhacks-dark-matter-maps/1.0 (research download)"}


def _get(url, timeout=60):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def _head_size(url):
    try:
        req = urllib.request.Request(url, headers=UA, method="HEAD")
        with urllib.request.urlopen(req, timeout=30) as r:
            return int(r.headers.get("Content-Length") or 0)
    except Exception:
        return 0


def human(n):
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or unit == "TB":
            return f"{n:.1f} {unit}" if unit != "B" else f"{n} B"
        n /= 1024


def download(url, dest, size=0):
    """Resumable download with a simple progress line."""
    dest = Path(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    have = dest.stat().st_size if dest.exists() else 0
    if size and have == size:
        print(f"  already have {dest.name} ({human(size)})")
        return dest
    headers = dict(UA)
    if have:
        headers["Range"] = f"bytes={have}-"
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=120) as r:
        if have and r.status != 206:  # server ignored Range: start over
            have = 0
        total = size or (have + int(r.headers.get("Content-Length") or 0))
        mode = "ab" if have else "wb"
        done, t0 = have, time.time()
        with open(dest, mode) as f:
            while True:
                chunk = r.read(1 << 20)
                if not chunk:
                    break
                f.write(chunk)
                done += len(chunk)
                rate = (done - have) / max(time.time() - t0, 1e-6)
                pct = f"{100 * done / total:5.1f}%" if total else ""
                print(f"\r  {dest.name}: {human(done)} {pct} @ {human(rate)}/s   ", end="", flush=True)
    print()
    return dest


# ---------------------------------------------------------------- KaRMMa (Zenodo)
def karmma_files():
    rec = json.loads(_get(ZENODO_KARMMA))
    out = []
    for f in rec.get("files", []):
        link = f.get("links", {}).get("self") or f.get("links", {}).get("content")
        out.append({"name": f["key"], "url": link, "size": int(f.get("size", 0))})
    title = rec.get("metadata", {}).get("title", "")
    return title, out


# ---------------------------------------------------------------- DES listing crawl
class _Links(HTMLParser):
    def __init__(self):
        super().__init__()
        self.links = []

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            href = dict(attrs).get("href")
            if href:
                self.links.append(href)


def crawl_des(root=DES_ROOT, max_depth=3, max_pages=250):
    """Breadth-first crawl of the Apache-style directory listing. Returns map-like files."""
    seen, queue, found, pages = set(), [(root, 0)], [], 0
    while queue and pages < max_pages:
        url, depth = queue.pop(0)
        if url in seen:
            continue
        seen.add(url)
        try:
            html = _get(url).decode("utf-8", "replace")
        except Exception as e:  # keep going on one bad directory
            print(f"  ! could not list {url}: {e}", file=sys.stderr)
            continue
        pages += 1
        p = _Links()
        p.feed(html)
        for href in p.links:
            if href.startswith(("?", "#", "/", "mailto:")) or href in ("../", "./"):
                continue
            full = urllib.parse.urljoin(url, href)
            if not full.startswith(root):
                continue
            if href.endswith("/"):
                # descend everywhere near the top; deeper, only into map-looking dirs
                if depth + 1 <= max_depth and (depth < 1 or MAP_NAME.search(href) or "shear" in href.lower()):
                    queue.append((full, depth + 1))
            elif MAP_EXT.search(href) and (MAP_NAME.search(href) or MAP_NAME.search(url[len(root):])):
                found.append({"name": urllib.parse.unquote(href), "url": full})
    return found, pages


def _show(rows):
    for r in rows:
        size = r.get("size") or _head_size(r["url"])
        r["size"] = size
        print(f"  {human(size) if size else '   ?':>10}  {r['name']}\n              {r['url']}")
    total = sum(r["size"] for r in rows)
    print(f"  total: {human(total)} in {len(rows)} file(s)")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("what", choices=["list", "karmma", "des", "url"])
    ap.add_argument("url", nargs="?", help="for `url`: the file to download")
    ap.add_argument("--out", default="des_data")
    ap.add_argument("--match", default=None, help="only files whose name contains this (case-insensitive)")
    ap.add_argument("--max-gb", type=float, default=5.0, help="refuse to start downloads bigger than this")
    a = ap.parse_args(argv)
    out = Path(a.out)

    def pick(rows):
        if a.match:
            rows = [r for r in rows if a.match.lower() in r["name"].lower()]
        return rows

    def fetch(rows, sub):
        _show(rows)
        total = sum(r["size"] for r in rows)
        if total > a.max_gb * 1024 ** 3:
            sys.exit(f"Stopping: {human(total)} exceeds --max-gb {a.max_gb}. Narrow with --match or raise --max-gb.")
        for r in rows:
            download(r["url"], out / sub / Path(r["name"]).name, r["size"])

    if a.what in ("list", "karmma"):
        print(f"\nKaRMMa DES Y3 samples  ({ZENODO_KARMMA})")
        try:
            title, rows = karmma_files()
            print(f"  record: {title}")
            rows = pick(rows)
            fetch(rows, "karmma") if a.what == "karmma" else _show(rows)
        except Exception as e:
            print(f"  ! Zenodo lookup failed: {e}")

    if a.what in ("list", "des"):
        print(f"\nDES Y3 data-release server  ({DES_ROOT})  -- crawling, may take a minute")
        rows, pages = crawl_des()
        rows = pick(rows)
        print(f"  scanned {pages} directory pages; {len(rows)} map-like file(s)")
        if not rows:
            print("  Nothing matched. Open the listing in a browser, find the mass-map file, then:\n"
                  "    python get_des_data.py url <file-url> --out des_data/")
        elif a.what == "des":
            fetch(rows, "des_y3")
        else:
            _show(rows)

    if a.what == "url":
        if not a.url:
            sys.exit("give the file URL")
        size = _head_size(a.url)
        print(f"  {human(size) if size else '?'}  {a.url}")
        download(a.url, out / "manual" / Path(urllib.parse.urlparse(a.url).path).name, size)

    print(f"\nNext: python make_des_map.py {out}/<file> --out map_out/")


if __name__ == "__main__":
    main()
