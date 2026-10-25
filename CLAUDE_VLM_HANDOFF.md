# Finish Penumbra's local Claude VLM

The implementation is ready. Finish configuration and verify a live run.

1. Read `des_map/MAP_READER.md` and `des_map/map_reader/vision.py`.
2. Have the user enter `ANTHROPIC_API_KEY` locally in the ignored root `.env`. Never print or commit keys. Keep `.env` permissions at `600`. Do not reuse the OpenAI key.
3. `VLM_PROVIDER=anthropic` and `VLM_MODEL=claude-sonnet-5-5` are already selected. Check account access and change the model if needed. A hackathon gateway/Bedrock/Vertex key may require different endpoint/authentication.
4. From the repo root, run:
   ```bash
   OMP_NUM_THREADS=2 MPLCONFIGDIR=/tmp/dm-reader-mpl .venv-map-reader/bin/python -m pytest des_map/tests -q
   ./run-vlm-demo
   ```
5. Review `des_map/reader_runs/toy/vlm-anthropic/report.md` and `analysis.json`. Confirm a real Claude response and valid evidence references. Retry to check caching; fix errors without pretending they succeeded.

Already present: local virtual environment and SDKs, launchers, VLM adapters, numerical extraction/rendering, pipeline helpers, docs, toy maps/config, and 18 passing tests with mocked APIs. Claude has not been tested live; its key is missing.

Preserve the science: the VLM describes morphology; numerical summaries feed SBI. Do not infer cosmology or significance from images. Toy maps are demonstrations.

Original DES FITS/mask/smoke artifacts remain in `/Users/arnavswaroop/Documents/ChatGPT/CalHacks work stuff/`, outside this clone. No physical simulation training set or trained SBI model is available. Actual inference also needs its separate torch/sbi/emcee dependencies and validation.
