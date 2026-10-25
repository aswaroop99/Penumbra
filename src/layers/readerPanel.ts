import { el } from '../lib/dom';
import type { FeatureKind, ReaderFeature, ReaderLayer, ReaderTarget } from '../lib/reader';

/**
 * "AI map reading" section of the layer viewer. Renders Claude's offline description
 * (data/reader.json) as plain text only, next to the measured targets it cites.
 * All model text goes through textContent; nothing is parsed as HTML.
 */

const KIND_LABEL: Record<FeatureKind, string> = {
  measured_extremum: 'Measured',
  visual_hypothesis: 'Visual impression',
  quality_concern: 'Quality note',
};

export interface ReaderPanelEvents {
  /** Fly to one cited target. */
  onTarget(t: ReaderTarget): void;
  /** Emphasise these target ids on the map (empty = none). */
  onHighlight(ids: ReadonlySet<string>): void;
  onTogglePins(visible: boolean): void;
}

export interface ReaderPanel {
  /** Mark the feature list entry that cites this target (e.g. after a pin click). */
  focusTarget(id: string | null): void;
  /** All targets cited by the model, for drawing pins. */
  readonly targets: ReaderTarget[];
}

export const targetLabel = (t: ReaderTarget) => `${t.type} ${t.bin}:${t.id.split(':').pop()}`;

/** Which feature kinds cite each target id, for hover text. */
export function citationsById(reader: ReaderLayer): Map<string, FeatureKind[]> {
  const m = new Map<string, FeatureKind[]>();
  for (const f of reader.features) {
    for (const t of f.targets) m.set(t.id, [...(m.get(t.id) ?? []), f.kind]);
  }
  return m;
}

export function kindLabel(k: FeatureKind) {
  return KIND_LABEL[k];
}

export function renderReaderPanel(root: HTMLElement, reader: ReaderLayer, layerCount: number, ev: ReaderPanelEvents): ReaderPanel {
  const badge = root.querySelector<HTMLElement>('#readerBadge');
  const body = root.querySelector<HTMLElement>('#readerBody');
  if (!badge || !body) throw new Error('Reader panel markup missing');
  root.hidden = false;
  body.replaceChildren();
  badge.hidden = !reader.isToy;
  badge.textContent = 'toy data';

  const shown = reader.status === 'ok' || reader.status === 'abstained';
  if (!shown) {
    body.append(
      el('p', {
        className: 'small dim',
        textContent:
          reader.status === 'vlm_failed'
            ? 'The last AI run did not return an accepted result, so there is no description to show.'
            : 'No AI description has been generated for this map yet.',
      })
    );
    return { focusTarget() {}, targets: [] };
  }

  const targets = reader.features.flatMap((f) => f.targets.filter((t) => t.bin < layerCount));
  const items: { li: HTMLLIElement; ids: Set<string> }[] = [];
  let active: number | null = null;

  const setActive = (i: number | null) => {
    active = i;
    items.forEach((it, k) => it.li.classList.toggle('focus', k === i));
    ev.onHighlight(i === null ? new Set() : items[i].ids);
  };

  if (reader.overview) body.append(el('p', { className: 'reader-overview', textContent: reader.overview }));
  if (reader.status === 'abstained') {
    body.append(el('p', { className: 'small dim', textContent: 'The model declined to describe features in this map.' }));
  }

  if (!reader.aligned) {
    body.append(
      el('p', {
        className: 'small reader-warn',
        textContent:
          'Analysed a different map from the layers shown here, so pins mark the reader’s own measured ' +
          'positions, not the peaks drawn on these layers.',
      })
    );
  }

  if (targets.length) {
    const pins = el('input', { type: 'checkbox', checked: true });
    pins.onchange = () => ev.onTogglePins(pins.checked);
    body.append(el('div', { className: 'row' }, el('label', {}, pins, ' Show AI pins'), legend()));
  }

  const list = el('ul', { className: 'reader-features' });
  reader.features.forEach((f, i) => {
    const li = renderFeature(f, layerCount, ev, () => setActive(active === i ? null : i));
    items.push({ li, ids: new Set(f.targets.map((t) => t.id)) });
    list.append(li);
  });
  body.append(list);

  const meta = reader.model ? `${reader.model.model} · ${new Date(reader.generatedAt).toLocaleString()}` : '';
  body.append(el('p', { className: 'small dim reader-disclaimer', textContent: reader.disclaimer }));
  if (reader.limitations.length) {
    const details = el('details', { className: 'small' }, el('summary', { textContent: `Limitations (${reader.limitations.length})` }));
    details.append(el('ul', {}, ...reader.limitations.map((l) => el('li', { textContent: l }))));
    body.append(details);
  }
  if (meta) body.append(el('p', { className: 'small dim', textContent: meta }));

  return {
    targets,
    focusTarget(id) {
      if (id === null) return setActive(null);
      const i = items.findIndex((it) => it.ids.has(id));
      if (i >= 0) {
        setActive(i);
        items[i].li.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    },
  };
}

function renderFeature(f: ReaderFeature, layerCount: number, ev: ReaderPanelEvents, toggle: () => void): HTMLLIElement {
  const head = el(
    'div',
    { className: 'reader-tags' },
    el('span', { className: `tag tag-${f.kind}`, textContent: KIND_LABEL[f.kind] })
  );
  if (f.requires_followup) head.append(el('span', { className: 'tag', textContent: 'needs follow-up' }));
  const text = el('button', { className: 'reader-text', title: 'Highlight the features this cites', onclick: toggle }, f.text);
  const li = el('li', {}, head, text);
  const chips = f.targets.filter((t) => t.bin < layerCount);
  if (chips.length) {
    li.append(
      el(
        'div',
        { className: 'reader-chips' },
        ...chips.map((t) =>
          el('button', {
            className: `chip chip-${t.type}`,
            textContent: targetLabel(t),
            title: `Fly to RA ${t.ra.toFixed(2)}°, Dec ${t.dec.toFixed(2)}° · κ ${t.kappa.toFixed(4)}`,
            onclick: () => ev.onTarget(t),
          })
        )
      )
    );
  }
  return li;
}

function legend(): HTMLElement {
  return el(
    'span',
    { className: 'small dim reader-legend' },
    el('span', { className: 'diamond peak' }),
    'peak ',
    el('span', { className: 'diamond trough' }),
    'trough'
  );
}
