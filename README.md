# Penumbra
Dark Matter Mapping hell yeahh


## Vision-language map reader

The Python map reader combines numerical convergence-map features for SBI with
optional pretrained Claude or OpenAI vision-model interpretation. Start with
[des_map/MAP_READER.md](des_map/MAP_READER.md) for setup, the local toy demo,
DES ingestion, API configuration, and validation limits.

The viewer assets in `data/` follow their existing manifest. Scientific map
analysis uses HEALPix map contracts; viewer PNGs do not replace those inputs.

## Local quick start

The `run-reader` launcher loads the ignored `.env` file and uses the repository's
`.venv-map-reader` environment. Keep your API key in `.env` (see `.env.example`).

```bash
./run-reader demo --out reader_runs/toy
./run-reader analyze --map reader_runs/toy/obs.npz --config reader_runs/toy/config.json --out reader_runs/toy/vlm-anthropic --provider anthropic --model claude-sonnet-5-5
```

Open `des_map/reader_runs/toy/vlm-anthropic/report.md` for the result. The demo uses toy
maps and does not measure DES cosmological parameters. The second command sends
the rendered map and evidence to Anthropic; repeated identical requests use a local cache.

For hackathon Claude credits, set these values in your ignored `.env` locally:

```dotenv
VLM_PROVIDER=anthropic
VLM_MODEL=claude-sonnet-5-5
ANTHROPIC_API_KEY=your-key-here
```

Then run `./run-vlm-demo`. Use a model enabled for your hackathon account if
Sonnet 5.5 is unavailable. This integration uses the direct Anthropic API;
gateway, Bedrock, or Vertex credentials require their respective authentication.
Do not paste keys into chat or commit `.env`. OpenAI remains available with
`VLM_PROVIDER=openai` and `VLM_MODEL=gpt-4.1-mini`.
