import { el } from '../lib/dom';
import { coverageVerdict, formatInterval, type Inference, type Interval } from '../lib/inference';

/**
 * "Cosmology from this map": the stored Omega_m / S8 (/ sigma8) result for the loaded map,
 * next to Planck and DES Y3, with the held-out trust check. Read-only: the numbers come
 * from `data/inference.json`, computed offline. All text is set through textContent.
 */

const pct = (x: number) => `${Math.round(x * 100)}%`;

const sym = (letter: string, sub: string) => el('span', { className: 'sym' }, letter, el('sub', { textContent: sub }));

interface Row {
  label: string;
  value: string;
  lo: number;
  hi: number;
  mid: number;
  cls: string;
}

function comparisonRows(inf: Inference): Row[] {
  const { S8, comparison: c } = inf;
  return [
    {
      label: inf.synthetic ? 'This map (toy)' : 'This map',
      value: S8.median.toFixed(3),
      lo: S8.lo68,
      hi: S8.hi68,
      mid: S8.median,
      cls: 'ours',
    },
    {
      label: 'DES Y3 lensing',
      value: c.des.S8.toFixed(3),
      lo: c.des.S8 - c.des.errLo,
      hi: c.des.S8 + c.des.errHi,
      mid: c.des.S8,
      cls: 'des',
    },
    {
      label: 'Planck CMB',
      value: c.planck.S8.toFixed(3),
      lo: c.planck.S8 - c.planck.err,
      hi: c.planck.S8 + c.planck.err,
      mid: c.planck.S8,
      cls: 'planck',
    },
  ];
}

/** S8 number line: one 68% band per row on a shared axis. */
function s8Chart(inf: Inference): HTMLElement {
  const rows = comparisonRows(inf);
  const lo = Math.min(...rows.map((r) => r.lo));
  const hi = Math.max(...rows.map((r) => r.hi));
  const pad = Math.max(0.02, 0.15 * (hi - lo));
  const a = lo - pad;
  const b = hi + pad;
  const at = (v: number) => `${(((v - a) / (b - a)) * 100).toFixed(2)}%`;

  const chart = el('div', { className: 'infer-chart' });
  for (const r of rows) {
    const band = el('span', { className: `band ${r.cls}` });
    band.style.left = at(r.lo);
    band.style.width = `${(((r.hi - r.lo) / (b - a)) * 100).toFixed(2)}%`;
    const mid = el('span', { className: `mid ${r.cls}` });
    mid.style.left = at(r.mid);
    const track = el('span', { className: 'track' }, band, mid);
    track.setAttribute('aria-hidden', 'true');
    chart.append(
      el(
        'div',
        { className: 'chart-row' },
        el('span', { className: 'chart-label', textContent: r.label }),
        track,
        el('span', { className: 'chart-val', textContent: r.value })
      )
    );
  }
  chart.append(
    el(
      'div',
      { className: 'chart-axis', title: 'Shaded bands are 68% intervals' },
      el('span', { textContent: a.toFixed(2) }),
      el('span', { textContent: 'S₈' }),
      el('span', { textContent: b.toFixed(2) })
    )
  );
  return chart;
}

function stat(symbol: HTMLElement, i: Interval, digits = 3): HTMLElement {
  return el('div', { className: 'infer-stat' }, symbol, el('span', { className: 'num', textContent: formatInterval(i, digits) }));
}

export function renderInferenceCard(host: HTMLElement, inf: Inference, onApply: (s8: number, om: number) => void) {
  const badge = el('b', {
    className: `infer-badge ${inf.synthetic ? 'toy' : 'real'}`,
    textContent: inf.synthetic ? 'Toy data' : 'From survey data',
  });
  host.replaceChildren(el('h2', {}, 'Cosmology from this map', badge));

  host.append(stat(sym('S', '8'), inf.S8), stat(sym('Ω', 'm'), inf.Omega_m));
  if (inf.sigma8) host.append(stat(sym('σ', '8'), inf.sigma8));
  host.append(
    el('div', {
      className: 'hint',
      textContent:
        'S₈ (how clumpy matter is) is the headline number; σ₈ is derived from it and Ωm. Bands below are 68% intervals.',
    }),
    s8Chart(inf)
  );

  if (inf.synthetic) {
    const truth = inf.truth
      ? ` It recovers the toy truth (Ωm ${inf.truth.Omega_m}, S₈ ${inf.truth.S8}).`
      : '';
    host.append(
      el('p', {
        className: 'small infer-note toy',
        textContent:
          `Toy universe: these maps come from a made-up generator with a known answer, so this checks the pipeline, not the sky.${truth} ` +
          'Any offset from Planck here is not a scientific result.',
      })
    );
  } else {
    host.append(el('p', { className: 'small', textContent: inf.statement }));
  }

  if (inf.trust) {
    const t = inf.trust;
    const ok = coverageVerdict(t) === 'ok';
    host.append(
      el('p', {
        className: `small infer-trust ${ok ? 'ok' : 'warn'}`,
        textContent:
          `Trust check: on ${t.nHeldout} held-out simulations the true S₈ fell inside the 68% interval ${pct(t.coverage68S8)} of the time ` +
          `(ideal 68% ± ${pct(t.binomial1sigma)})${ok ? '.' : ': error bars may be off.'}`,
      })
    );
    if (t.outOfDistribution) {
      host.append(
        el('p', {
          className: 'small infer-trust warn',
          textContent: 'This map’s summary lies far outside the simulations it was compared with; treat the result with suspicion.',
        })
      );
    }
  }

  const m = inf.comparison.mcmc;
  if (m) {
    const agree = m.differenceSigma <= 1;
    host.append(
      el('p', {
        className: `small infer-trust ${agree ? 'ok' : 'warn'}`,
        textContent:
          `Cross-check (${m.method}): S₈ ${m.S8.toFixed(3)}, ${agree ? 'within 1σ of' : `${m.differenceSigma.toFixed(1)}σ from`} the main result` +
          `${agree ? '.' : ': a gap this size is worth investigating.'}`,
      })
    );
  }

  const how =
    `Method: ${inf.method}${inf.nTrain ? `, trained on ${inf.nTrain} simulated maps` : ''}. ` +
    'Computed offline and stored with the map; nothing is trained in your browser.';
  host.append(el('div', { className: 'hint', textContent: how }));

  if (inf.caveats.length) {
    host.append(
      el(
        'details',
        { className: 'infer-caveats' },
        el('summary', { textContent: 'Caveats' }),
        el('ul', {}, ...inf.caveats.map((c) => el('li', { textContent: c })))
      )
    );
  }

  host.append(
    el('button', {
      className: 'btn wide',
      textContent: 'Set the simulator to these values',
      title: 'Moves the S8 and Ωm sliders on the Simulate and 3D map tabs',
      onclick: () => onApply(inf.S8.median, inf.Omega_m.median),
    })
  );
  host.hidden = false;
}

/** Drive the existing cosmology sliders as if the user dragged them (no CosmicApp changes). */
export function setCosmologySliders(s8: number, om: number) {
  for (const [id, v] of [
    ['s8', s8],
    ['om', om],
  ] as const) {
    const slider = document.getElementById(id);
    if (!(slider instanceof HTMLInputElement)) continue;
    slider.value = String(v);
    slider.dispatchEvent(new Event('input', { bubbles: true }));
  }
}
