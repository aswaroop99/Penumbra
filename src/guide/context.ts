/**
 * What each page tells the guide about the visitor's screen. These read the pages'
 * existing DOM (tab buttons, sliders, HUD, hover readout), so the pages themselves
 * need no changes beyond mounting the guide.
 */

const txt = (id: string): string => document.getElementById(id)?.textContent?.trim() ?? '';
const val = (id: string): string => (document.getElementById(id) as HTMLInputElement | null)?.value ?? '';
const clip = (s: string, n = 400) => (s.length > n ? s.slice(0, n) + '…' : s);

/** Cosmic web page: active tab, its HUD, the cosmology sliders and the chosen sky region. */
export function cosmicContext(): Record<string, unknown> {
  const tabBtn = document.querySelector<HTMLElement>('nav [aria-selected="true"]');
  const tab = document.body.dataset.active ?? '';
  const ctx: Record<string, unknown> = {
    tab: tabBtn?.textContent?.trim() ?? tab,
    on_screen: clip([txt('hudBig'), txt('hudSmall')].filter(Boolean).join(' · ')),
    data_source: clip(txt('source'), 200),
  };
  if (tab === 'sim' || tab === 'box') {
    ctx.sliders = { S8: val('s8'), Omega_m: val('om') };
  }
  if (tab === 'sim') ctx.redshift = txt('zval') || val('zslider');
  if (tab === 'slices') {
    const sel = document.getElementById('region') as HTMLSelectElement | null;
    ctx.sky_region = sel?.selectedOptions[0]?.textContent?.trim() ?? '';
  }
  return ctx;
}

/**
 * Layer viewer: remembers the last thing the visitor hovered (the readout resets when the
 * pointer leaves the map, e.g. to type a question) and the last peak they flew to.
 */
export function layersContextTracker(): () => Record<string, unknown> {
  const DEFAULT = 'Hover over a layer';
  let lastHover = '';
  let lastPeak = '';
  const readout = document.getElementById('readout');
  if (readout) {
    new MutationObserver(() => {
      const t = readout.textContent?.trim() ?? '';
      if (t && !t.startsWith(DEFAULT) && !t.startsWith('Loading')) lastHover = t;
    }).observe(readout, { childList: true, characterData: true, subtree: true });
  }
  document.getElementById('peaks')?.addEventListener('click', (e) => {
    const li = (e.target as HTMLElement).closest('li');
    if (li) lastPeak = (li.textContent ?? '').replace(/\s+/g, ' ').trim();
  });
  return () => {
    const layers = [...document.querySelectorAll<HTMLElement>('#layers .row')].map((row) => {
      const box = row.querySelector<HTMLInputElement>('input[type=checkbox]');
      const focus = row.querySelector<HTMLInputElement>('input[type=radio]');
      const name = row.querySelector('label')?.textContent?.trim() ?? '';
      return `${name}${box && !box.checked ? ' (hidden)' : ''}${focus?.checked ? ' (focused)' : ''}`;
    });
    return {
      last_hovered: lastHover || 'nothing yet',
      last_peak_flown_to: lastPeak || 'none',
      layers,
      data_source: clip(txt('source'), 200),
      flags_in_room: txt('flagCount') || '0',
    };
  };
}
