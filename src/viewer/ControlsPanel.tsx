import type { Manifest, Peak } from '../lib/manifest';
import { formatDec, formatRa } from '../lib/sky';
import { MAX_SPREAD } from './types';

interface Props {
  manifest: Manifest;
  activeLayer: number;
  onLayer: (i: number) => void;
  spread: number;
  onSpread: (s: number) => void;
  isolate: boolean;
  onIsolate: (b: boolean) => void;
  showAllPeaks: boolean;
  onShowAllPeaks: (b: boolean) => void;
  landmarks: Peak[];
  onLandmark: (p: Peak) => void;
  onReset: () => void;
}

export function ControlsPanel(p: Props) {
  const { manifest } = p;
  return (
    <aside className="panel left" aria-label="Map controls">
      <section>
        <h2>Depth</h2>
        <p className="dim small">Looking deeper → toward more distant sources</p>
        <div className="layer-buttons" role="group" aria-label="Active layer">
          {manifest.layers.map((l, i) => (
            <button
              key={l.png}
              className={i === p.activeLayer ? 'active' : ''}
              aria-pressed={i === p.activeLayer}
              onClick={() => p.onLayer(i)}
            >
              {l.name}
            </button>
          ))}
        </div>
        <label className="row">
          <span>Layer spread</span>
          <input
            type="range"
            min={0}
            max={MAX_SPREAD}
            step={0.05}
            value={p.spread}
            onChange={(e) => p.onSpread(Number(e.target.value))}
          />
        </label>
        <label className="check">
          <input type="checkbox" checked={p.isolate} onChange={(e) => p.onIsolate(e.target.checked)} />
          Isolate active layer
        </label>
        <label className="check">
          <input type="checkbox" checked={p.showAllPeaks} onChange={(e) => p.onShowAllPeaks(e.target.checked)} />
          Show peaks from all layers
        </label>
      </section>

      <section>
        <h2>Landmarks</h2>
        <select
          value=""
          onChange={(e) => {
            const pk = p.landmarks[Number(e.target.value)];
            if (pk) p.onLandmark(pk);
          }}
          aria-label="Fly to a landmark"
        >
          <option value="" disabled>
            Fly to a cluster peak…
          </option>
          {p.landmarks.map((pk, i) => (
            <option key={`${pk.bin}-${pk.ra}-${pk.dec}`} value={i}>
              SNR {pk.snr.toFixed(1)} · {manifest.layers[pk.bin].name} · {formatRa(pk.ra)} {formatDec(pk.dec)}
            </option>
          ))}
        </select>
        <button className="wide" onClick={p.onReset}>
          Reset view
        </button>
      </section>
    </aside>
  );
}
