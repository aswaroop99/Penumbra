import '../styles/bridge-tokens.css';
import '../styles/bridge-bar.css';
import './tour.css';
import { drawLensingField } from './lensing';
import teamStatus from './team_status.json';

interface Stop {
  short: string;
  body: string[];
}

const STOPS: Stop[] = [
  {
    short: 'The invisible 85%',
    body: [
      'Add up everything that shines, from stars to glowing gas, and it accounts for only about a sixth of the matter that gravity says is out there. The rest is dark matter: it has mass and pulls on things, but gives off no light.',
      'Galaxies spin too fast for what we can see in them. Clusters of galaxies bend light more strongly than their visible mass can. The leftover glow of the Big Bang carries its fingerprint too. Nobody yet knows what it is made of.',
    ],
  },
  {
    short: 'Seeing by bending',
    body: [
      "Mass bends light. When light from a distant galaxy passes a clump of dark matter on its way to us, the galaxy's image gets stretched by about one percent.",
      'That is far too small to notice in one galaxy, since galaxies are already oval. Measure a hundred million of them and the stretches line up into a pattern around the hidden mass, like the field at the top of this page, which exaggerates the effect about 30 times.',
    ],
  },
  {
    short: 'The map',
    body: [
      'The Dark Energy Survey measured those stretches across 4,143 square degrees of the southern sky, about a tenth of the whole sky, and turned them into a mass map. Bright spots are most likely galaxy clusters; dark patches are voids.',
      'One catch: the map is flattened. Each spot adds up all the mass along one line of sight, like a shadow puppet, so it shows where mass sits on the sky but not how far away it is. You can explore the layers in the Layer viewer.',
    ],
  },
  {
    short: 'Reading the recipe',
    body: [
      "The universe's recipe, how much matter there is (Ωm) and how clumpy it became (S8), leaves fingerprints in the map: how many bright peaks it has, and how much it varies at each size.",
      'The team takes thousands of simulated universes with known recipes, makes each one look exactly like the DES map, and trains a small neural network to learn which recipe makes which fingerprints. Then it reads the real map. Before trusting it, they quiz it on simulated universes it has never seen.',
    ],
  },
  {
    short: 'The clumpiness puzzle',
    body: [
      'The Planck satellite photographed the baby universe. Run the standard model forward and it predicts how clumpy the universe should be today: S8 of about 0.83. Try the S8 slider on the Cosmic web page to see what that number does.',
      'Lensing surveys weigh today’s universe directly, and for years they found it a few percent smoother. The newest data have narrowed that gap, and the surveys now disagree with each other about its size. The chart below shows where each one lands.',
    ],
  },
  {
    short: 'Citizen science',
    body: [
      'Galaxy Zoo volunteers have classified huge numbers of galaxy images online, and a model trained on their votes extends that to millions more. Some galaxies are caught mid-collision.',
      'Mergers should happen more often in crowded places, so the team asks whether the fraction of merging galaxies is higher where the mass map is brightest. Shuffled-label and noise-map checks guard against fooling themselves, and finding no detectable difference would still be a real result.',
    ],
  },
  {
    short: "What's next",
    body: [
      "DES released results from its full six-year survey in January 2026. Much bigger maps are arriving: the Rubin Observatory began its ten-year survey on 29 June 2026, and Euclid's first public images arrive in November 2026.",
      "Meanwhile DESI's 3D galaxy map hints that dark energy might be changing. The tools in this project are the kind that will read those new maps.",
    ],
  },
];

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* private mode */
    }
  },
};

let cur = Math.min(Math.max(Number(store.get('pg-stop')) || 0, 0), STOPS.length - 1);

function renderStops() {
  const ol = $('stops');
  ol.replaceChildren(
    ...STOPS.map((s, i) => {
      const li = h('li');
      const b = h('button');
      b.type = 'button';
      b.append(h('span', 'n', String(i + 1).padStart(2, '0')), h('span', 't', s.short));
      if (i === cur) b.setAttribute('aria-current', 'step');
      b.onclick = () => go(i);
      li.append(b);
      return li;
    })
  );
}

function renderStop() {
  const s = STOPS[cur]!;
  const body = h('div', 'body');
  s.body.forEach((t) => body.append(h('p', '', t)));
  const nav = h('div', 'stop-nav');
  const prev = h('button', 'ghost', cur > 0 ? `← ${STOPS[cur - 1]!.short}` : '←');
  const next = h('button', 'ghost', cur < STOPS.length - 1 ? `${STOPS[cur + 1]!.short} →` : '→');
  prev.disabled = cur === 0;
  next.disabled = cur === STOPS.length - 1;
  prev.onclick = () => go(cur - 1);
  next.onclick = () => go(cur + 1);
  nav.append(prev, next);
  $('stop').replaceChildren(h('div', 'eyebrow', `Stop ${cur + 1} of ${STOPS.length}`), h('h2', '', s.short), body, nav);
}

function go(i: number) {
  if (i < 0 || i >= STOPS.length) return;
  cur = i;
  store.set('pg-stop', String(i));
  renderStops();
  renderStop();
}

// ---------------------------------------------------------------- team status
interface Milestone {
  label: string;
  state: 'done' | 'active' | 'todo';
  note?: string;
}
interface Status {
  stage_label?: string;
  updated?: string;
  summary?: string;
  milestones?: Milestone[];
  s8?: { median: number; lo68: number; hi68: number; method?: string } | null;
  coverage68?: number | null;
  statement?: string | null;
  mergers?: { verdict?: string } | null;
}

// Team progress lives in team_status.json next to this file: edit it as the project moves.
const status: Status | null = teamStatus as Status;

function renderStatus() {
  const res = $('results');
  res.replaceChildren();
  const row = (text: string) => res.append(h('div', 'r', text));
  if (!status) {
    $('projsummary').textContent = '';
    $('milestones').replaceChildren();
    $('projlive').textContent = '';
    drawChart();
    return;
  }
  $('projsummary').textContent = status.summary ?? '';
  if (status.s8 && typeof status.s8.median === 'number') {
    const s = status.s8;
    row(`Our S8: ${s.median.toFixed(3)} (68%: ${s.lo68.toFixed(3)}–${s.hi68.toFixed(3)})${s.method ? ` · ${s.method}` : ''}`);
  } else row('Our S8: not measured yet');
  if (typeof status.coverage68 === 'number')
    row(`Trust check: the true answer fell inside the 68% range ${Math.round(status.coverage68 * 100)}% of the time (ideal 68%)`);
  if (status.statement) row(status.statement);
  if (status.mergers?.verdict) row(`Galaxy Zoo cross-check: ${status.mergers.verdict}`);
  $('milestones').replaceChildren(
    ...(status.milestones ?? []).map((m) => {
      const li = h('li', m.state);
      const text = h('div');
      text.append(
        h('div', 'lab', m.label + (m.state === 'done' ? ' · done' : m.state === 'active' ? ' · in progress' : '')),
        h('div', 'nt', m.note ?? '')
      );
      const dot = h('span', 'dot');
      dot.setAttribute('aria-hidden', 'true');
      li.append(dot, text);
      return li;
    })
  );
  $('projlive').textContent = `From the team's notes${status.updated ? ` · updated ${status.updated}` : ''}${
    status.stage_label ? ` · ${status.stage_label}` : ''
  }`;
  drawChart();
}

// ---------------------------------------------------------------- S8 chart (one linear scale)
function drawChart() {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = $('s8chart') as unknown as SVGSVGElement;
  type Row = { label: string; sub: string; m?: number; lo?: number; hi?: number; k: string };
  const rows: Row[] = [
    { label: 'Planck 2018', sub: 'CMB prediction for today', m: 0.832, lo: 0.013, hi: 0.013, k: 'k-cmb' },
    { label: 'DES Y3 shear (2022)', sub: 'the survey behind our map', m: 0.759, lo: 0.023, hi: 0.025, k: 'k-lens' },
    { label: 'KiDS-Legacy (2025)', sub: 'agrees with Planck, 0.7σ', m: 0.815, lo: 0.021, hi: 0.016, k: 'k-lens' },
    { label: 'DES Y6 3×2pt (2026)', sub: '2.6σ below CMB on S8', m: 0.789, lo: 0.012, hi: 0.012, k: 'k-lens' },
  ];
  const s8 = status?.s8;
  rows.push(
    s8 && typeof s8.median === 'number'
      ? { label: 'This project', sub: s8.method ?? 'our reimplementation', m: s8.median, lo: s8.median - s8.lo68, hi: s8.hi68 - s8.median, k: 'k-ours' }
      : { label: 'This project', sub: 'result pending', k: 'pending' }
  );
  const W = 640, L = 200, R = 620, rowH = 46, top = 14;
  const yEnd = top + rows.length * rowH;
  const H = yEnd + 34;
  const x0 = 0.7, x1 = 0.88;
  const X = (v: number) => L + ((Math.min(Math.max(v, x0), x1) - x0) / (x1 - x0)) * (R - L);
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.replaceChildren();
  const el = (n: string, a: Record<string, string | number>, t?: string) => {
    const e = document.createElementNS(NS, n);
    for (const k in a) e.setAttribute(k, String(a[k]));
    if (t != null) e.textContent = t;
    svg.append(e);
    return e;
  };
  el('rect', { x: X(0.819), y: top - 4, width: X(0.845) - X(0.819), height: yEnd - top + 4, class: 'band' });
  for (const t of [0.72, 0.76, 0.8, 0.84, 0.88]) {
    el('line', { x1: X(t), x2: X(t), y1: top - 4, y2: yEnd, class: 'grid' });
    el('text', { x: X(t), y: yEnd + 18, 'text-anchor': 'middle', class: 'tick' }, t.toFixed(2));
  }
  el('text', { x: L, y: yEnd + 32, class: 'tick' }, '← smoother');
  el('text', { x: R, y: yEnd + 32, 'text-anchor': 'end', class: 'tick' }, 'clumpier →');
  rows.forEach((r, i) => {
    const y = top + i * rowH + rowH / 2;
    el('text', { x: 0, y: y - 3, class: 'lbl' }, r.label);
    el('text', { x: 0, y: y + 13, class: 'lbl-sub' }, r.sub);
    if (r.m == null) {
      el('line', { x1: L + 6, x2: R - 6, y1: y, y2: y, class: 'pending' });
      el('text', { x: (L + R) / 2, y: y - 7, 'text-anchor': 'middle', class: 'pending-txt' }, 'not measured yet');
    } else {
      el('line', { x1: X(r.m - (r.lo ?? 0)), x2: X(r.m + (r.hi ?? 0)), y1: y, y2: y, class: `bar ${r.k}` });
      el('circle', { cx: X(r.m), cy: y, r: 5.5, class: r.k });
      el('text', { x: X(r.m + (r.hi ?? 0)) + 8, y: y + 4, class: 'tick' }, r.m.toFixed(3));
    }
  });
}

// ---------------------------------------------------------------- boot
renderStops();
renderStop();
renderStatus();
drawLensingField($<HTMLCanvasElement>('sky'), $<HTMLButtonElement>('reveal'));
