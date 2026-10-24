#!/usr/bin/env bash
# Downloads the public data behind dark-matter density maps (late universe)
# and the Planck CMB maps (early universe) for "Mapping the Dark Universe".
# Usage:  bash get_dark_matter_data.sh            # core files (~0.3 GB)
#         bash get_dark_matter_data.sh --planck   # also Planck maps (~2 GB more)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${OUT:-$SCRIPT_DIR/dark_universe_data}"
mkdir -p "$OUT"/{des_y3,cosmos,planck}
cd "$OUT"

fetch () { # url  dest
  if [ -s "$2" ]; then echo "  already have $2"; return; fi
  echo "-> $2"; curl -L --fail --retry 3 -C - -o "$2" "$1"
}

echo "== 1. DES Y3 dark-matter (convergence) maps: 100 KaRMMa map samples + mask, HEALPix/numpy (~240 MB)"
fetch "https://zenodo.org/records/10668943/files/desy3_karmma_maps.zip?download=1" des_y3/desy3_karmma_maps.zip
echo "   md5 should be 55fbef2740c1f41f594334ab14cb0f14:"
(md5sum des_y3/desy3_karmma_maps.zip 2>/dev/null || md5 des_y3/desy3_karmma_maps.zip)
unzip -n -q des_y3/desy3_karmma_maps.zip -d des_y3/karmma -x '__MACOSX/*' '*/.ipynb_checkpoints/*'

echo "== 2. COSMOS weak-lensing source catalog (Leauthaud+2007): the HST galaxy shapes behind the famous 3D clump map (Massey+2007)"
fetch "https://irsa.ipac.caltech.edu/TAP/sync?QUERY=SELECT+*+FROM+cosmoswlsc&FORMAT=csv" cosmos/cosmos_wl_source_catalog.csv \
  || echo "   TAP query failed - grab it by hand from https://irsa.ipac.caltech.edu/cgi-bin/Gator/nph-dd?catalog=cosmoswlsc"

if [ "${1:-}" = "--planck" ]; then
  echo "== 3. Planck 2018 SMICA CMB temperature+polarization map, HEALPix Nside 2048 (~1.9 GB)"
  fetch "https://irsa.ipac.caltech.edu/data/Planck/release_3/all-sky-maps/maps/component-maps/cmb/COM_CMB_IQU-smica_2048_R3.00_full.fits" planck/COM_CMB_IQU-smica_2048_R3.00_full.fits
  echo "   Planck CMB-lensing (dark matter seen by the CMB) is COM_Lensing_4096_R3.00 - download from https://pla.esac.esa.int (Maps > Lensing)."
fi

echo "Done. Files are in $OUT"
ls -lhR "$OUT" | head -40
