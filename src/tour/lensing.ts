/**
 * The tour's hero: background galaxies sheared tangentially around an invisible mass
 * (weak lensing, exaggerated ~30×). The mass drifts, or follows the pointer.
 * Each galaxy is drawn as an ellipse transformed by the inverse lensing Jacobian.
 */
export function drawLensingField(cv: HTMLCanvasElement, revealBtn: HTMLButtonElement) {
  const ctx = cv.getContext('2d');
  if (!ctx) return;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let W = 0, H = 0, dpr = 1, raf = 0, reveal = false;
  let pointer: { x: number; y: number } | null = null;
  const lens = { x: 0.55, y: 0.5 };
  const t0 = performance.now();
  type Gal = { x: number; y: number; a: number; b: number; th: number; warm: boolean; br: number };
  let gals: Gal[] = [];

  const rng = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0), seed / 4294967296);

  function build() {
    const r = rng(42);
    gals = [];
    const n = Math.round((W * H) / 900);
    for (let i = 0; i < n; i++) {
      const size = 1.2 + Math.pow(r(), 3) * 4.2;
      const e = r() * 0.45;
      gals.push({ x: r() * W, y: r() * H, a: size * (1 + e), b: size * (1 - e) * 0.9 + 0.4, th: r() * Math.PI, warm: r() > 0.7, br: 0.45 + r() * 0.55 });
    }
  }

  function resize() {
    const rect = cv.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = rect.width;
    H = rect.height;
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    build();
    if (!raf) frame(performance.now());
  }

  function frame(now: number) {
    raf = 0;
    const t = (now - t0) / 1000;
    if (pointer) {
      lens.x += (pointer.x / W - lens.x) * 0.12;
      lens.y += (pointer.y / H - lens.y) * 0.12;
    } else if (!reduce) {
      lens.x = 0.5 + 0.22 * Math.sin(t * 0.23);
      lens.y = 0.5 + 0.18 * Math.sin(t * 0.31 + 1.2);
    }
    const mx = lens.x * W, my = lens.y * H, E = Math.min(W, H) * 0.16;
    ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx!.fillStyle = '#04030b';
    ctx!.fillRect(0, 0, W, H);
    if (reveal) {
      const g = ctx!.createRadialGradient(mx, my, 0, mx, my, E * 2.4);
      g.addColorStop(0, 'rgba(255,179,71,0.55)');
      g.addColorStop(0.35, 'rgba(255,179,71,0.18)');
      g.addColorStop(1, 'rgba(255,179,71,0)');
      ctx!.fillStyle = g;
      ctx!.beginPath();
      ctx!.arc(mx, my, E * 2.4, 0, Math.PI * 2);
      ctx!.fill();
    }
    for (const s of gals) {
      const dx = s.x - mx, dy = s.y - my, r = Math.hypot(dx, dy) + 1e-3;
      const shift = ((E * E) / (r + E)) * 0.55; // images pushed outward
      const px = s.x + (dx / r) * shift, py = s.y + (dy / r) * shift;
      const g = Math.min(0.62, (0.9 * E) / (r + E * 0.6)); // tangential shear
      const phi = Math.atan2(dy, dx), c2 = Math.cos(2 * phi), s2 = Math.sin(2 * phi);
      const det = 1 - g * g, a11 = (1 + g * c2) / det, a12 = (g * s2) / det, a22 = (1 - g * c2) / det;
      const ct = Math.cos(s.th), st = Math.sin(s.th);
      ctx!.fillStyle = s.warm ? `rgba(255,214,170,${s.br})` : `rgba(214,224,255,${s.br})`;
      ctx!.setTransform(
        dpr * (a11 * ct * s.a + a12 * st * s.a), dpr * (a12 * ct * s.a + a22 * st * s.a),
        dpr * (-a11 * st * s.b + a12 * ct * s.b), dpr * (-a12 * st * s.b + a22 * ct * s.b),
        dpr * px, dpr * py
      );
      ctx!.beginPath();
      ctx!.arc(0, 0, 1, 0, Math.PI * 2);
      ctx!.fill();
    }
    ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!reduce || pointer) raf = requestAnimationFrame(frame);
  }

  const kick = () => {
    if (!raf) raf = requestAnimationFrame(frame);
  };
  cv.addEventListener('pointermove', (e) => {
    const r = cv.getBoundingClientRect();
    pointer = { x: e.clientX - r.left, y: e.clientY - r.top };
    kick();
  });
  cv.addEventListener('pointerleave', () => {
    pointer = null;
    kick();
  });
  revealBtn.addEventListener('click', () => {
    reveal = !reveal;
    revealBtn.setAttribute('aria-pressed', String(reveal));
    revealBtn.textContent = reveal ? 'Hide the mass' : 'Reveal the mass';
    kick();
  });
  new ResizeObserver(resize).observe(cv);
}
