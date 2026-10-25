import { readFileSync, existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ReaderError, parseReader } from './reader';

const shippedUrl = new URL('../../data/reader.json', import.meta.url);

function minimal() {
  return {
    schema: 'penumbra.reader/1',
    status: 'ok',
    generated_at: '2026-10-25T00:00:00+00:00',
    source: 'TOY test',
    is_toy: true,
    alignment: { aligned: true, reasons: [] as string[] },
    model: { provider: 'anthropic', model: 'claude-x', response_id: 'msg_1' },
    overview: 'A toy map.',
    features: [
      {
        kind: 'visual_hypothesis',
        text: 'Possible bridge.',
        requires_followup: true,
        targets: [
          { id: 'peak:bin0:0', type: 'peak', bin: 0, ra: 350, dec: -40, kappa: 0.04, kappa_over_reference_rms: 4, site_peak: { index: 1, sep_deg: 0.02 } },
        ],
        refs: [{ id: 'image:bin0', label: 'image:bin0' }],
      },
    ],
    objects: [],
    measurement_limitations: ['Projected map.'],
    model_limitations: ['Toy only.'],
    disclaimer: 'AI-written; not a measurement.',
  };
}

describe('parseReader', () => {
  it.skipIf(!existsSync(shippedUrl))('accepts the exported data/reader.json', () => {
    const r = parseReader(JSON.parse(readFileSync(shippedUrl, 'utf8')));
    expect(r.features.length).toBeGreaterThan(0);
    for (const f of r.features) for (const t of f.targets) expect(Number.isFinite(t.ra)).toBe(true);
  });

  it('keeps site-peak links only when aligned and in range', () => {
    expect(parseReader(minimal(), 5).features[0].targets[0].site_peak).toEqual({ index: 1, sep_deg: 0.02 });
    expect(parseReader(minimal(), 1).features[0].targets[0].site_peak).toBeNull();
    const m = minimal();
    m.alignment = { aligned: false, reasons: ['different map'] };
    const r = parseReader(m, 5);
    expect(r.aligned).toBe(false);
    expect(r.alignmentReasons).toEqual(['different map']);
    expect(r.features[0].targets[0].site_peak).toBeNull();
  });

  it('rejects unknown schemas, statuses and feature kinds', () => {
    expect(() => parseReader(null)).toThrow(ReaderError);
    expect(() => parseReader({ ...minimal(), schema: 'other/9' })).toThrow(/schema/);
    expect(() => parseReader({ ...minimal(), status: 'great' })).toThrow(/status/);
    const m = minimal();
    (m.features[0] as { kind: string }).kind = 'cosmology_estimate';
    expect(() => parseReader(m)).toThrow(/kind/);
  });

  it('rejects impossible coordinates', () => {
    const m = minimal();
    m.features[0].targets[0].dec = 120;
    expect(() => parseReader(m)).toThrow(/dec/);
  });

  it('handles local-only output and caps long text', () => {
    const m = { ...minimal(), status: 'local_only', model: null, overview: null, features: [] };
    const r = parseReader(m);
    expect(r.model).toBeNull();
    expect(r.overview).toBeNull();
    const long = { ...minimal(), overview: 'x'.repeat(5000) };
    expect(parseReader(long).overview).toHaveLength(2000);
  });
});
