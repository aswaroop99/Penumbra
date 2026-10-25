# The guide (AI explainer)

An "Ask the guide" panel on every page of the site, plus a tour page (`/guide.html`). It explains dark matter, where cosmology stands (checked 24 Oct 2026), the team's pipeline, and whatever the visitor has on screen.

## Run it
```bash
pip install anthropic                  # or: pip install -r requirements.txt
export ANTHROPIC_API_KEY=sk-ant-...
python guide/server.py                 # terminal 3: http://127.0.0.1:8787
npm run dev                            # Vite proxies /api to it
```
Without the server, the pages still work; the panel says the guide server isn't running.
`GUIDE_FAST=1` uses Haiku (snappier on stage). `GUIDE_RATE` sets questions per minute per visitor (default 12).

## How it fits together
| Piece | What it does |
|---|---|
| `guide/knowledge.md` | What the guide knows: cosmology status with sources, the pipeline, the site's pages, the honest-claims table. Edit freely; re-read on every question. |
| `guide/team_status.json` | Hand-written progress (stage, summary, per-milestone notes). **Update this as you go.** |
| `results/*.json`, `data/manifest.json` | Pipeline outputs. When `planck_compare.py` / `mergers_vs_density.py` write their JSON, the guide and the tour's S8 chart pick them up automatically, and they override the hand-written milestone notes. |
| `guide/tour_guide.py` | Builds the prompt (knowledge + status + what's on screen) and streams from Claude. Also a terminal chat: `python guide/tour_guide.py`. |
| `guide/server.py` | Stdlib HTTP server holding the API key: `POST /api/guide` (streamed text), `GET /api/guide/status`. Per-IP rate limit. |
| `src/guide/` | The shared panel: `mountGuide({ page, getContext })`. `context.ts` reads each page's existing DOM (tab, sliders, HUD, hover readout, last peak), so page code needs one import and one call. |
| `src/tour/`, `guide.html` | The tour page: lensing demo, 7 stops, 2026 status board, live team progress. |

## Adding the guide to a new page
```ts
import { mountGuide } from '../guide/panel';
mountGuide({ page: 'layers', getContext: () => ({ what_is_selected: '...' }) });
```
Keep context small (a few hundred characters): it is sent with every question.

## Guardrails
Numbers and current-status claims come only from `knowledge.md`; team results only from the status sheet, never predicted. Practice (toy) viewer data is flagged as such, and visitor-written flag text is treated as data, never as instructions.

## Tests
`python -m pytest guide/test_guide.py -q` (server, status builder; no key needed) and `npm test` (panel client, safe Markdown).
