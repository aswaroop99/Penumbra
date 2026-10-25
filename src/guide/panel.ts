import './guide.css';
import { askGuide, GUIDE_ERROR_TEXT, GuideError, type Level, type Page, type Turn } from './client';
import { renderMarkdown } from './markdown';

/**
 * "Ask the guide": a launcher pill plus a slide-in drawer, shared by every page.
 *
 *   mountGuide({ page: 'layers', getContext: layersContextTracker() });
 *
 * getContext() is called at each question, so the guide sees what is on screen right now.
 */
export interface GuideOptions {
  page: Page;
  getContext?: () => Record<string, unknown>;
  /** Tour page only: which stop (1-7) the visitor is on. */
  getStop?: () => number | undefined;
  /** Render inside this element instead of as a floating drawer (the tour page does this). */
  container?: HTMLElement;
  starters?: string[];
  /** Lift the launcher (px from the bottom) where the page already uses the bottom edge. */
  launcherBottom?: number;
}

export interface GuideHandle {
  open(): void;
  close(): void;
  ask(question: string): void;
}

const LEVELS: { id: Level; label: string }[] = [
  { id: 'new', label: 'New to this' },
  { id: 'some', label: 'Some science' },
  { id: 'expert', label: 'Physicist' },
];

const STARTERS: Record<Page, string[]> = {
  cosmic: ['What am I looking at?', 'What do the S8 and Ωm sliders change?', 'Is this real data or a simulation?'],
  layers: ['What am I looking at?', 'What does the κ number mean?', 'Is that bright spot a galaxy cluster?'],
  tour: ['What is dark matter, in one minute?', 'What is this project actually doing?', 'What’s the biggest open question in cosmology right now?'],
};

const store = {
  get(k: string): string | null {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* private mode */
    }
  },
};

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

export function mountGuide(opts: GuideOptions): GuideHandle {
  const docked = !!opts.container;
  let level = (store.get('pg-level') as Level) || 'new';
  if (!LEVELS.some((l) => l.id === level)) level = 'new';
  const turns: Turn[] = [];
  let busy = false;
  let ctl: AbortController | null = null;

  // ---- structure
  const root = h('section', `pg-guide${docked ? ' pg-docked' : ''}`);
  root.setAttribute('aria-label', 'Ask the guide');
  root.id = 'pg-guide';

  const head = h('div', 'pg-head');
  const titleRow = h('div', 'pg-row');
  const title = h('h2', 'pg-title', 'Ask the guide');
  titleRow.append(title);
  if (!docked) {
    const close = h('button', 'pg-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close the guide');
    close.onclick = () => setOpen(false);
    titleRow.append(close);
  }
  const seg = h('div', 'pg-seg');
  seg.setAttribute('role', 'group');
  seg.setAttribute('aria-label', 'How much science do you know?');
  const segButtons = LEVELS.map((l) => {
    const b = h('button', '', l.label);
    b.type = 'button';
    b.onclick = () => setLevel(l.id);
    seg.append(b);
    return { id: l.id, b };
  });
  const sees = h('p', 'pg-sees');
  head.append(titleRow, seg, sees);

  const log = h('div', 'pg-log');
  log.setAttribute('aria-live', 'polite');

  const form = h('form', 'pg-compose');
  const input = h('textarea');
  input.id = 'pg-input';
  input.rows = 1;
  input.placeholder = 'Ask about anything on screen…';
  input.setAttribute('aria-label', 'Your question');
  const send = h('button', 'pg-send', 'Ask');
  send.type = 'submit';
  const stop = h('button', 'pg-stop', 'Stop');
  stop.type = 'button';
  stop.hidden = true;
  form.append(input, send, stop);
  root.append(head, log, form);

  let launcher: HTMLButtonElement | null = null;
  if (docked) {
    opts.container!.append(root);
  } else {
    root.hidden = true;
    launcher = h('button', 'pg-launch');
    launcher.type = 'button';
    launcher.setAttribute('aria-controls', 'pg-guide');
    launcher.setAttribute('aria-expanded', 'false');
    launcher.innerHTML = '<span class="pg-lens" aria-hidden="true"></span><span>Ask the guide</span>';
    if (opts.launcherBottom != null)
      launcher.style.bottom = `calc(${opts.launcherBottom}px + env(safe-area-inset-bottom, 0px))`;
    launcher.onclick = () => setOpen(root.hidden !== false);
    document.body.append(launcher, root);
  }

  // Keep typing in the guide away from the 3D scene's keyboard shortcuts.
  root.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape' && !docked) setOpen(false);
  });

  // ---- behaviour
  function setOpen(on: boolean) {
    if (docked) return;
    root.hidden = !on;
    launcher?.setAttribute('aria-expanded', String(on));
    launcher?.classList.toggle('pg-active', on);
    if (on) {
      refreshSees();
      input.focus();
    }
  }

  function setLevel(l: Level) {
    level = l;
    store.set('pg-level', l);
    segButtons.forEach(({ id, b }) => b.setAttribute('aria-pressed', String(id === l)));
  }

  function context(): Record<string, unknown> | undefined {
    try {
      return opts.getContext?.();
    } catch {
      return undefined;
    }
  }

  function refreshSees() {
    const c = context();
    const bits = [c?.tab, c?.last_hovered !== 'nothing yet' ? c?.last_hovered : undefined]
      .filter((x): x is string => typeof x === 'string' && !!x);
    sees.textContent = bits.length ? `Sees your screen: ${bits.join(' · ')}` : '';
    sees.hidden = !bits.length;
  }

  function scroll() {
    log.scrollTop = log.scrollHeight;
  }

  function bubble(role: 'user' | 'guide', text?: string) {
    const d = h('div', `pg-msg ${role === 'user' ? 'pg-me' : 'pg-them'}`);
    if (role === 'user') d.textContent = text ?? '';
    else {
      d.append(h('div', 'pg-who', 'Guide'));
      const body = h('div', 'pg-body');
      if (text) body.innerHTML = renderMarkdown(text);
      d.append(body);
    }
    log.append(d);
    scroll();
    return d;
  }

  function note(where: HTMLElement, text: string) {
    where.append(h('p', 'pg-note', text));
  }

  function setBusy(b: boolean) {
    busy = b;
    send.hidden = b;
    stop.hidden = !b;
  }

  function autosize() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 140) + 'px';
  }

  async function ask(question: string) {
    const q = question.trim();
    if (!q || busy) return;
    setOpen(true);
    input.value = '';
    autosize();
    bubble('user', q);
    const reply = bubble('guide');
    const body = reply.querySelector<HTMLElement>('.pg-body')!;
    body.innerHTML = '<p class="pg-thinking">Thinking…</p>';
    turns.push({ role: 'user', content: q });
    while (turns.length > 16) turns.splice(0, 2);
    setBusy(true);
    ctl = new AbortController();
    try {
      const text = await askGuide(
        { turns: [...turns], level, page: opts.page, stop: opts.getStop?.(), context: context() },
        {
          signal: ctl.signal,
          onText: (t) => {
            body.innerHTML = renderMarkdown(t);
            scroll();
          },
        }
      );
      body.innerHTML = renderMarkdown(text);
      turns.push({ role: 'assistant', content: text });
    } catch (e) {
      const err = e instanceof GuideError ? e : new GuideError('upstream_error');
      if (err.partial) {
        body.innerHTML = renderMarkdown(err.partial);
        turns.push({ role: 'assistant', content: err.partial });
      } else {
        body.textContent = '';
        turns.pop();
      }
      if (err.code === 'cancelled') {
        if (!err.partial) reply.remove();
      } else {
        note(body, GUIDE_ERROR_TEXT[err.code]);
      }
    } finally {
      ctl = null;
      setBusy(false);
      scroll();
    }
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void ask(input.value);
  });
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void ask(input.value);
    }
  });
  stop.onclick = () => ctl?.abort();

  // ---- first frame
  setLevel(level);
  const hello = bubble(
    'guide',
    'Hi! I’m your guide to the dark universe. I can see what you have on screen, so ask about anything here, or about dark matter and cosmology in general. Pick how much science you know above.'
  );
  const chips = h('div', 'pg-starters');
  for (const q of opts.starters ?? STARTERS[opts.page]) {
    const b = h('button', 'pg-chip', q);
    b.type = 'button';
    b.onclick = () => void ask(q);
    chips.append(b);
  }
  hello.append(chips);
  refreshSees();

  return { open: () => setOpen(true), close: () => setOpen(false), ask: (q) => void ask(q) };
}
