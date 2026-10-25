import './styles.css';
import '../styles/bridge-tokens.css';
import '../styles/bridge-bar.css';
import { el } from '../lib/dom';
import { pixelToSky, skyToPixel, type LaeaProjection } from '../lib/laea';

/** data/web_des.json, written by des_map/make_filament_map.py. */
interface WebPeak {
  ra: number;
  dec: number;
  /** [column, row] in the full-resolution poster. */
  px: [number, number];
  kappa_over_rms: number;
  snr: number;
  filament_persistence: number;
}

interface WebMeta {
  source: string;
  smoothing_fwhm_arcmin: number;
  projection: LaeaProjection;
  /** [height, width] of the poster. */
  shape: [number, number];
  images: { web: string; kappa: string };
  grid: { file: string; step: number; shape: [number, number]; outside: number };
  web: { voids: number; match_radius_arcmin: number; fraction_in_majority_of_samples: number };
  caption: string;
  peaks: WebPeak[];
}

type Mode = 'web' | 'kappa' | 'compare';

const $ = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node as T;
};

const loadImage = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Couldn’t load ${src}`));
    img.src = src;
  });

async function fetchOk(url: string): Promise<Response> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res;
}

const IDLE = matchMedia('(hover: none)').matches ? 'Tap the map to read it' : 'Hover over the map';
const fmtRa = (ra: number) => `${ra.toFixed(2)}°`;
const fmtDec = (dec: number) => `${dec >= 0 ? '+' : '−'}${Math.abs(dec).toFixed(2)}°`;

function showFatal(message: string) {
  const box = $('loading');
  box.hidden = false;
  box.replaceChildren(
    el('h1', { textContent: 'Couldn’t load the filament map' }),
    el('p', { textContent: message }),
    el('p', { textContent: 'Run des_map/make_filament_map.py with --out data/ to create it.' })
  );
}

/** RA/Dec graticule as polylines in poster pixels, plus a label anchor per line. */
function buildGraticule(meta: WebMeta) {
  const [h, w] = meta.shape;
  const proj = meta.projection;
  const inImage = (p: { col: number; row: number }) => p.col >= 0 && p.col < w && p.row >= 0 && p.row < h;
  const lines: { pts: { col: number; row: number }[]; label: string; at: { col: number; row: number } | null }[] = [];
  for (let dec = -75; dec <= 15; dec += 15) {
    const pts = [];
    for (let ra = 0; ra <= 360; ra += 1) pts.push(skyToPixel(proj, w, h, ra, dec));
    const visible = pts.filter(inImage);
    const at = visible.length ? visible.reduce((a, b) => (b.col < a.col ? b : a)) : null;
    lines.push({ pts, label: `${dec > 0 ? '+' : dec < 0 ? '−' : ''}${Math.abs(dec)}°`, at });
  }
  for (let ra = 0; ra < 360; ra += 30) {
    const pts = [];
    for (let dec = -85; dec <= 25; dec += 1) pts.push(skyToPixel(proj, w, h, ra, dec));
    const visible = pts.filter(inImage);
    // label meridians where they leave the top of the image; they all converge at the pole
    const at = visible.length ? visible.reduce((a, b) => (b.row < a.row ? b : a)) : null;
    lines.push({ pts, label: `${ra}°`, at: at && { col: at.col, row: at.row + 14 } });
  }
  return lines;
}

async function start() {
  let meta: WebMeta;
  let webImg: HTMLImageElement;
  let kappaImg: HTMLImageElement;
  let grid: Uint8Array;
  try {
    meta = (await (await fetchOk('/data/web_des.json')).json()) as WebMeta;
    [webImg, kappaImg, grid] = await Promise.all([
      loadImage(`/data/${meta.images.web}`),
      loadImage(`/data/${meta.images.kappa}`),
      fetchOk(`/data/${meta.grid.file}`).then(async (r) => new Uint8Array(await r.arrayBuffer())),
    ]);
  } catch (e) {
    showFatal(e instanceof Error ? e.message : String(e));
    return;
  }
  $('loading').hidden = true;
  $('panel').hidden = false;

  const [H, W] = meta.shape;
  const [gh, gw] = meta.grid.shape;
  const canvas = $<HTMLCanvasElement>('stage');
  const ctx = canvas.getContext('2d')!;
  const divider = $('divider');
  const readout = $('readout');
  readout.textContent = IDLE;
  const graticule = buildGraticule(meta);

  const state = {
    mode: 'web' as Mode,
    peaks: true,
    grid: false,
    glow: 1,
    split: 0.5, // compare divider, fraction of the canvas width
    hoverPeak: -1,
  };
  // view: screen = image * scale + (tx, ty), in CSS pixels
  const view = { scale: 1, tx: 0, ty: 0 };
  let dirty = true;
  const redraw = () => (dirty = true);
  // until the user pans or zooms, keep the whole footprint fitted to the window
  let userMoved = false;

  // ---- static text
  $('mFwhm').textContent = String(Math.round(meta.smoothing_fwhm_arcmin));
  $('caption').textContent = meta.caption;
  $('stats').textContent =
    `${Math.round(meta.web.fraction_in_majority_of_samples * 100)}% of the drawn filament length shows up ` +
    `(within ${Math.round(meta.web.match_radius_arcmin)}′) in at least half of the 100 versions of the map ` +
    `that fit the DES data. Lines that few versions agree on are dimmed.`;

  const peakList = $('peaks');
  meta.peaks.slice(0, 10).forEach((p, i) => {
    const li = el(
      'li',
      { tabIndex: 0, title: 'Zoom to this peak' },
      `RA ${fmtRa(p.ra)} Dec ${fmtDec(p.dec)} `,
      el('span', { textContent: `· ${p.kappa_over_rms.toFixed(1)}σ` })
    );
    const go = () => flyTo(p.px[0], p.px[1], 6, i);
    li.addEventListener('click', go);
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        go();
      }
    });
    peakList.append(li);
  });

  // ---- view helpers
  const size = () => ({ w: canvas.clientWidth, h: canvas.clientHeight });
  const minScale = () => {
    const { w, h } = size();
    return Math.min(w / W, h / H) * 0.6;
  };
  function fit() {
    const { w, h } = size();
    if (!w || !h) return;
    userMoved = false;
    const narrow = w < 640;
    const left = narrow ? 0 : 330; // keep the poster clear of the side panel
    const top = narrow ? 70 : 40;
    const bottom = narrow ? h * 0.45 + 24 : 0;
    const aw = w - left - 16;
    const ah = h - top - bottom - 16;
    view.scale = Math.min(aw / W, ah / H);
    view.tx = left + (aw - W * view.scale) / 2;
    view.ty = top + (ah - H * view.scale) / 2;
    redraw();
  }
  function zoomAt(sx: number, sy: number, factor: number) {
    userMoved = true;
    const s = Math.min(Math.max(view.scale * factor, minScale()), 8);
    const k = s / view.scale;
    view.tx = sx - (sx - view.tx) * k;
    view.ty = sy - (sy - view.ty) * k;
    view.scale = s;
    redraw();
  }
  let anim = 0;
  function flyTo(col: number, row: number, zoom: number, peak = -1) {
    const { w, h } = size();
    const narrow = w < 640;
    const cx = narrow ? w / 2 : 330 + (w - 330) / 2;
    const cy = narrow ? (h * 0.55) / 2 + 30 : h / 2;
    const from = { ...view };
    const toScale = Math.max(from.scale, Math.min(zoom * Math.min(w / W, h / H), 8));
    const to = { scale: toScale, tx: cx - col * toScale, ty: cy - row * toScale };
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const t0 = performance.now();
    const ms = reduce ? 0 : 700;
    cancelAnimationFrame(anim);
    userMoved = true;
    state.hoverPeak = peak;
    const step = (t: number) => {
      const u = ms ? Math.min((t - t0) / ms, 1) : 1;
      const e = u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2;
      // interpolate in log-scale so the zoom feels even
      view.scale = Math.exp(Math.log(from.scale) + (Math.log(to.scale) - Math.log(from.scale)) * e);
      const fc = (cx - from.tx) / from.scale + (col - (cx - from.tx) / from.scale) * e;
      const fr = (cy - from.ty) / from.scale + (row - (cy - from.ty) / from.scale) * e;
      view.tx = cx - fc * view.scale;
      view.ty = cy - fr * view.scale;
      redraw();
      if (u < 1) anim = requestAnimationFrame(step);
    };
    anim = requestAnimationFrame(step);
  }

  // ---- drawing
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const { w, h } = size();
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    redraw();
  }

  function draw() {
    const dpr = canvas.width / Math.max(canvas.clientWidth, 1);
    const { w, h } = size();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, dpr * view.tx, dpr * view.ty);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    if (state.mode !== 'kappa') {
      ctx.filter = state.glow === 1 ? 'none' : `brightness(${state.glow})`;
      ctx.drawImage(webImg, 0, 0, W, H);
      ctx.filter = 'none';
    }
    if (state.mode !== 'web') {
      ctx.save();
      if (state.mode === 'compare') {
        const xImg = (state.split * w - view.tx) / view.scale;
        ctx.beginPath();
        ctx.rect(-W, -H, xImg + W, 3 * H);
        ctx.clip();
        ctx.fillStyle = '#000';
        ctx.fillRect(-W, -H, 3 * W, 3 * H);
      }
      ctx.drawImage(kappaImg, 0, 0, W, H);
      ctx.restore();
    }

    // overlays in screen space
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const toScreen = (c: number, r: number) => ({ x: c * view.scale + view.tx, y: r * view.scale + view.ty });
    if (state.grid) {
      ctx.strokeStyle = 'rgba(170, 190, 255, 0.22)';
      ctx.lineWidth = 1;
      ctx.fillStyle = 'rgba(190, 205, 255, 0.75)';
      ctx.font = '11px system-ui, sans-serif';
      for (const line of graticule) {
        ctx.beginPath();
        line.pts.forEach((p, i) => {
          const s = toScreen(p.col, p.row);
          if (i === 0) ctx.moveTo(s.x, s.y);
          else ctx.lineTo(s.x, s.y);
        });
        ctx.stroke();
        if (line.at) {
          const s = toScreen(line.at.col, line.at.row);
          ctx.fillText(line.label, s.x + 4, s.y - 4);
        }
      }
    }
    if (state.peaks) {
      const r = Math.max(7, Math.min(16, 7 * view.scale * 3));
      meta.peaks.slice(0, 10).forEach((p, i) => {
        const s = toScreen(p.px[0], p.px[1]);
        if (s.x < -20 || s.y < -20 || s.x > w + 20 || s.y > h + 20) return;
        const hot = i === state.hoverPeak;
        ctx.strokeStyle = hot ? '#fff' : 'rgba(255, 255, 255, 0.7)';
        ctx.lineWidth = hot ? 2 : 1.25;
        ctx.beginPath();
        ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = hot ? '#fff' : 'rgba(255, 255, 255, 0.85)';
        ctx.font = '600 11px system-ui, sans-serif';
        ctx.fillText(String(i + 1), s.x + r + 3, s.y - r + 4);
      });
    }
    divider.hidden = state.mode !== 'compare';
    divider.style.left = `${state.split * w}px`;
  }

  const frame = () => {
    if (dirty) {
      dirty = false;
      draw();
    }
    requestAnimationFrame(frame);
  };

  // ---- readout
  function sampleAt(col: number, row: number) {
    const gx = Math.floor(col / meta.grid.step);
    const gy = Math.floor(row / meta.grid.step);
    if (gx < 0 || gy < 0 || gx >= gw || gy >= gh) return null;
    const i = (gy * gw + gx) * 2;
    if (grid[i] === meta.grid.outside) return null;
    return { kappa: (grid[i]! / 254) * 10 - 4, persist: grid[i + 1]! / 254 };
  }
  function updateReadout(sx: number, sy: number) {
    const col = (sx - view.tx) / view.scale;
    const row = (sy - view.ty) / view.scale;
    let near = -1;
    if (state.peaks) {
      meta.peaks.slice(0, 10).forEach((p, i) => {
        const dx = p.px[0] * view.scale + view.tx - sx;
        const dy = p.px[1] * view.scale + view.ty - sy;
        if (Math.hypot(dx, dy) < 14) near = i;
      });
    }
    if (near !== state.hoverPeak) {
      state.hoverPeak = near;
      redraw();
    }
    if (col < 0 || row < 0 || col >= W || row >= H) {
      readout.textContent = IDLE;
      return;
    }
    const sky = pixelToSky(meta.projection, W, H, col, row);
    const v = sampleAt(col, row);
    const pos = `RA ${fmtRa(sky.ra)}   Dec ${fmtDec(sky.dec)}`;
    readout.replaceChildren();
    if (near >= 0) {
      const p = meta.peaks[near]!;
      readout.append(
        el('b', { textContent: `Peak ${near + 1}: ${p.kappa_over_rms.toFixed(1)}σ above average` }),
        `\nRA ${fmtRa(p.ra)}   Dec ${fmtDec(p.dec)}\nfilament within ${Math.round(meta.web.match_radius_arcmin)}′ in ${Math.round(p.filament_persistence * 100)}% of samples`
      );
    } else if (!v) {
      readout.append(pos, '\noutside the DES footprint');
    } else {
      const sign = v.kappa >= 0 ? '+' : '−';
      readout.append(
        pos,
        '\nmass: ',
        el('b', { textContent: `${sign}${Math.abs(v.kappa).toFixed(1)}σ` }),
        ' vs average\nfilament here in ',
        el('b', { textContent: `${Math.round(v.persist * 100)}%` }),
        ' of samples'
      );
    }
  }

  // ---- input: pan, wheel/pinch zoom, compare divider
  const pointers = new Map<number, { x: number; y: number }>();
  let pinch: { d: number; cx: number; cy: number } | null = null;
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
    canvas.classList.add('dragging');
    cancelAnimationFrame(anim);
    updateReadout(e.offsetX, e.offsetY);
  });
  canvas.addEventListener('pointermove', (e) => {
    const prev = pointers.get(e.pointerId);
    if (!prev) {
      updateReadout(e.offsetX, e.offsetY);
      return;
    }
    const cur = { x: e.offsetX, y: e.offsetY };
    pointers.set(e.pointerId, cur);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()] as [{ x: number; y: number }, { x: number; y: number }];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const cx = (a.x + b.x) / 2;
      const cy = (a.y + b.y) / 2;
      if (pinch) {
        view.tx += cx - pinch.cx;
        view.ty += cy - pinch.cy;
        zoomAt(cx, cy, d / pinch.d);
      }
      pinch = { d, cx, cy };
    } else {
      view.tx += cur.x - prev.x;
      view.ty += cur.y - prev.y;
      userMoved = true;
      redraw();
    }
  });
  const release = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    pinch = null;
    if (!pointers.size) canvas.classList.remove('dragging');
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('pointerleave', () => {
    if (!pointers.size) readout.textContent = IDLE;
  });
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      cancelAnimationFrame(anim);
      zoomAt(e.offsetX, e.offsetY, Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015)));
      updateReadout(e.offsetX, e.offsetY);
    },
    { passive: false }
  );
  canvas.addEventListener('dblclick', (e) => zoomAt(e.offsetX, e.offsetY, 2));

  divider.addEventListener('pointerdown', (e) => {
    divider.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      state.split = Math.min(Math.max(ev.clientX / size().w, 0.02), 0.98);
      redraw();
    };
    const up = () => {
      divider.removeEventListener('pointermove', move);
      divider.removeEventListener('pointerup', up);
    };
    divider.addEventListener('pointermove', move);
    divider.addEventListener('pointerup', up);
  });

  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) return;
    const { w, h } = size();
    if (e.key === '+' || e.key === '=') zoomAt(w / 2, h / 2, 1.4);
    else if (e.key === '-') zoomAt(w / 2, h / 2, 1 / 1.4);
    else if (e.key === '0') fit();
  });

  // ---- panel controls
  const modeButtons = [...document.querySelectorAll<HTMLButtonElement>('.seg button')];
  for (const b of modeButtons) {
    b.addEventListener('click', () => {
      state.mode = b.dataset.mode as Mode;
      for (const o of modeButtons) o.setAttribute('aria-checked', String(o === b));
      redraw();
    });
  }
  $<HTMLInputElement>('showPeaks').addEventListener('change', (e) => {
    state.peaks = (e.target as HTMLInputElement).checked;
    redraw();
  });
  $<HTMLInputElement>('showGrid').addEventListener('change', (e) => {
    state.grid = (e.target as HTMLInputElement).checked;
    redraw();
  });
  $<HTMLInputElement>('glow').addEventListener('input', (e) => {
    state.glow = Number((e.target as HTMLInputElement).value);
    redraw();
  });
  $('reset').addEventListener('click', fit);
  const collapse = $('collapse');
  collapse.addEventListener('click', () => {
    const body = $('panelBody');
    body.hidden = !body.hidden;
    collapse.textContent = body.hidden ? 'Show' : 'Hide';
    collapse.setAttribute('aria-expanded', String(!body.hidden));
  });

  new ResizeObserver(() => {
    resize();
    if (!userMoved) fit();
  }).observe(canvas);
  resize();
  fit();
  requestAnimationFrame(frame);
}

void start();
