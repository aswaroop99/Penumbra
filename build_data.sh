#!/usr/bin/env bash
# Build everything the viewers load into data/. None of it is committed: run this once
# after cloning (and again after changing a prep script).
#
#   bash build_data.sh                  # download raw data (~0.3 GB) if missing, then build
#   bash build_data.sh --skip-download  # build from dark_universe_data/ as it is
#   bash build_data.sh --with-volume    # also the experimental DES depth volume (viewer/des-volume.html)
#
# Steps (each skips nothing; outputs are overwritten):
#   1. get_dark_matter_data.sh   raw DES Y3 KaRMMa samples + COSMOS catalog -> dark_universe_data/
#   2. prep/export_des.py        DES layers: data/layer_bin{0..3}.png|.f16.bin + data/manifest.json
#   3. prep/cosmos_3d.py         COSMOS 3D map: data/cosmos/
#   4. prep/des_volume.py        (optional) data/des_volume/
#
# Python comes from bin/penumbra-python (the conda env "penumbra" or a repo venv).
# Kept in git: data/README_for_frontend.md, and the small results data/inference.json
# (SBI, needs torch) and data/reader.json (AI map reading, needs an API key; rebuild with
# ./run-reader, see des_map/MAP_READER.md).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PY="$ROOT/bin/penumbra-python"

download=1
volume=0
for arg in "$@"; do
  case "$arg" in
    --skip-download) download=0 ;;
    --with-volume) volume=1 ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

echo "== Python: $("$PY" --which)"
"$PY" -c 'import numpy, scipy, healpy, astropy, pandas, PIL, matplotlib' \
  || { echo "This environment is missing prep packages; see README \"Python environments\"." >&2; exit 1; }

if [ "$download" = 1 ]; then
  echo "== 1. Raw data"
  bash "$ROOT/get_dark_matter_data.sh"
fi
KARMMA="$ROOT/dark_universe_data/des_y3/karmma/desy3_karmma_maps"
CATALOG="$ROOT/dark_universe_data/cosmos/cosmos_wl_source_catalog.csv"
[ -f "$KARMMA/mask.fits" ] || { echo "Missing $KARMMA (run without --skip-download)" >&2; exit 1; }
[ -s "$CATALOG" ] || { echo "Missing $CATALOG (run without --skip-download)" >&2; exit 1; }

mkdir -p "$ROOT/data/cosmos"
export MPLCONFIGDIR="${MPLCONFIGDIR:-${TMPDIR:-/tmp}/penumbra-mpl}"

echo "== 2. DES Y3 layers -> data/"
"$PY" "$ROOT/prep/export_des.py"

echo "== 3. COSMOS 3D map -> data/cosmos/"
"$PY" "$ROOT/prep/cosmos_3d.py"

if [ "$volume" = 1 ]; then
  echo "== 4. DES depth volume -> data/des_volume/"
  mkdir -p "$ROOT/data/des_volume"
  "$PY" "$ROOT/prep/des_volume.py"
fi

echo "== Done. Files in data/:"
ls -lh "$ROOT/data" "$ROOT/data/cosmos"
if [ -f "$ROOT/data/reader.json" ]; then
  echo "Note: data/reader.json describes the map it was made from. If the layers changed, re-run the"
  echo "      reader (des_map/MAP_READER.md) so the AI pins line up."
fi
