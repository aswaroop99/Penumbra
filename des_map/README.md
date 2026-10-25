# DES Y3 mass map: download → map → viewer

For numerical feature extraction, an optional vision-language map reader, and
the SBI handoff, see [MAP_READER.md](MAP_READER.md).

Run on a laptop with internet (our cloud sandbox can't reach the DES or Zenodo servers).

```bash
conda env create -f ../environment.yml && conda activate penumbra   # or: pip install -r ../requirements.txt

# 1. See what's available (downloads nothing)
python get_des_data.py list

# 2a. Real DES Y3 Kaiser–Squires maps (use these for inference)
python get_des_data.py des --out des_data/            # add --match ks to narrow
# 2b. KaRMMa posterior samples (prettier; viewer + "which clusters are real" animation, NOT inference)
python get_des_data.py karmma --out des_data/

# 3. Make the map (E-mode, plus B-mode if the release has it)
python make_des_map.py des_data/des_y3/<E-mode file> --bmode des_data/des_y3/<B-mode file> --out map_out/
#   4 tomographic bins in one FITS:  --field 0,1,2,3 --bin-names "z~0.3" "z~0.5" "z~0.7" "z~0.9"
```

Outputs in `map_out/`:

| File | Who uses it |
|---|---|
| `data.npz` | map contract (κ, mask, meta) at nside 512 — inference lane; `forward_model.py --mask-from map_out/data.npz` copies this mask onto sims |
| `data_bmode.npz` | B-mode null map, same mask |
| `des_mass_map.png` | the rendered map + E/B power spectrum + footprint |
| `viewer_data/` | PNG layers, float16 grids, top-50 peaks, `manifest.json` — fly-through viewer lane |
| `report.json` | header, footprint area, RA/Dec extent, κ rms, warnings |

Check `report.json` first: area should be ~4143 deg², Dec mostly below +5°, no warnings.
If `get_des_data.py des` finds nothing, the DES listing layout changed: browse
https://desdr-server.ncsa.illinois.edu/despublic/y3a2_files/ by hand and run
`python get_des_data.py url <file URL>`.

## Notes
- Display smoothing (15′) never touches `data.npz`. Inference summaries come from
  `pipeline/summary_stats.py` with the frozen config, applied identically to data and sims.
- KS maps are noise-dominated pixel by pixel; individual bright spots are not all clusters.
  The B-mode panel shows the noise level.
- `pipeline/` is a copy of the project's tested scripts (contracts, stats, SBI, viewer export).
