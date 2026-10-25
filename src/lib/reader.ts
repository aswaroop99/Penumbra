/**
 * Optional AI map-reader layer: `data/reader.json`, written offline by
 * `./run-reader export-site` (see des_map/MAP_READER.md). The model never runs in the
 * browser; this is static, pre-validated output. Treat every string as untrusted
 * plain text: render with textContent, never innerHTML.
 *
 * Pins use their own `ra`/`dec`. Only when `alignment.aligned` is true were they
 * analysed on the same map as manifest.json, and `site_peak.index` then points into
 * `manifest.peaks`. Otherwise show them as separate markers, never as site peaks.
 */

export type ReaderStatus = 'ok' | 'abstained' | 'local_only' | 'vlm_failed';
export type FeatureKind = 'measured_extremum' | 'visual_hypothesis' | 'quality_concern';

export interface ReaderTarget {
  id: string;
  type: 'peak' | 'trough';
  bin: number;
  ra: number;
  dec: number;
  kappa: number;
  kappa_over_reference_rms: number;
  /** Present only when aligned; null = no site peak within one reader pixel. */
  site_peak?: { index: number; sep_deg: number } | null;
}

export interface ReaderFeature {
  kind: FeatureKind;
  text: string;
  requires_followup: boolean;
  targets: ReaderTarget[];
  refs: { id: string; label: string }[];
}

export interface ReaderLayer {
  status: ReaderStatus;
  generatedAt: string;
  source: string;
  isToy: boolean;
  aligned: boolean;
  alignmentReasons: string[];
  model: { provider: string; model: string; response_id: string } | null;
  overview: string | null;
  features: ReaderFeature[];
  objects: ReaderTarget[];
  limitations: string[];
  disclaimer: string;
}

export class ReaderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReaderError';
  }
}

const SCHEMA = 'penumbra.reader/1';
const STATUSES: readonly ReaderStatus[] = ['ok', 'abstained', 'local_only', 'vlm_failed'];
const KINDS: readonly FeatureKind[] = ['measured_extremum', 'visual_hypothesis', 'quality_concern'];
const MAX_TEXT = 2000;
const MAX_ITEMS = 200;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const text = (v: unknown, label: string): string => {
  if (typeof v !== 'string') throw new ReaderError(`${label} must be a string`);
  return v.slice(0, MAX_TEXT);
};
const list = (v: unknown, label: string): unknown[] => {
  if (!Array.isArray(v)) throw new ReaderError(`${label} must be an array`);
  if (v.length > MAX_ITEMS) throw new ReaderError(`${label} has too many entries`);
  return v;
};

function parseTarget(raw: unknown, label: string): ReaderTarget {
  if (!isObj(raw)) throw new ReaderError(`${label} must be an object`);
  const { ra, dec, bin, kappa, kappa_over_reference_rms: snr } = raw;
  if (!isNum(ra) || ra < -360 || ra > 360 || !isNum(dec) || dec < -90 || dec > 90) {
    throw new ReaderError(`${label} needs ra in [-360, 360] and dec in [-90, 90]`);
  }
  if (!isNum(bin) || !Number.isInteger(bin) || bin < 0) throw new ReaderError(`${label} bin must be a non-negative integer`);
  if (!isNum(kappa) || !isNum(snr)) throw new ReaderError(`${label} needs numeric kappa values`);
  if (raw.type !== 'peak' && raw.type !== 'trough') throw new ReaderError(`${label} type must be peak or trough`);
  const t: ReaderTarget = {
    id: text(raw.id, `${label} id`),
    type: raw.type,
    bin,
    ra,
    dec,
    kappa,
    kappa_over_reference_rms: snr,
  };
  if ('site_peak' in raw) {
    const sp = raw.site_peak;
    if (sp === null) t.site_peak = null;
    else if (isObj(sp) && isNum(sp.index) && Number.isInteger(sp.index) && sp.index >= 0 && isNum(sp.sep_deg)) {
      t.site_peak = { index: sp.index, sep_deg: sp.sep_deg };
    } else throw new ReaderError(`${label} site_peak is malformed`);
  }
  return t;
}

/** Validate untrusted JSON against the reader contract. Throws ReaderError. */
export function parseReader(input: unknown, sitePeakCount?: number): ReaderLayer {
  if (!isObj(input)) throw new ReaderError('reader.json must be a JSON object');
  if (input.schema !== SCHEMA) throw new ReaderError(`Unsupported reader schema (expected ${SCHEMA})`);
  const status = input.status as ReaderStatus;
  if (!STATUSES.includes(status)) throw new ReaderError('Unknown reader status');
  const align = isObj(input.alignment) ? input.alignment : {};
  const aligned = align.aligned === true;

  const features = list(input.features, 'features').map((raw, i): ReaderFeature => {
    if (!isObj(raw)) throw new ReaderError(`Feature ${i} must be an object`);
    if (!KINDS.includes(raw.kind as FeatureKind)) throw new ReaderError(`Feature ${i} has an unknown kind`);
    const targets = list(raw.targets, `Feature ${i} targets`).map((t, j) => parseTarget(t, `Feature ${i} target ${j}`));
    for (const t of targets) {
      // Never let a stale or misaligned file point at a site peak that does not exist.
      if (t.site_peak && (!aligned || (sitePeakCount !== undefined && t.site_peak.index >= sitePeakCount))) {
        t.site_peak = null;
      }
    }
    const refs = list(raw.refs ?? [], `Feature ${i} refs`).map((r, j) => {
      if (!isObj(r)) throw new ReaderError(`Feature ${i} ref ${j} must be an object`);
      return { id: text(r.id, 'ref id'), label: text(r.label, 'ref label') };
    });
    return { kind: raw.kind as FeatureKind, text: text(raw.text, `Feature ${i} text`),
             requires_followup: raw.requires_followup === true, targets, refs };
  });

  const m = input.model;
  const model = isObj(m)
    ? { provider: text(m.provider, 'model provider'), model: text(m.model, 'model name'), response_id: text(m.response_id, 'response id') }
    : null;
  const strings = (v: unknown, label: string) => list(v ?? [], label).map((s) => text(s, label));

  return {
    status,
    generatedAt: text(input.generated_at, 'generated_at'),
    source: text(input.source, 'source'),
    isToy: input.is_toy === true,
    aligned,
    alignmentReasons: strings(align.reasons, 'alignment reasons'),
    model,
    overview: input.overview == null ? null : text(input.overview, 'overview'),
    features,
    objects: list(input.objects ?? [], 'objects').map((o, i) => parseTarget(o, `Object ${i}`)),
    limitations: [...strings(input.measurement_limitations, 'limitations'), ...strings(input.model_limitations, 'limitations')],
    disclaimer: text(input.disclaimer, 'disclaimer'),
  };
}

/**
 * Load the optional reader layer. Resolves to null when no reader.json exists, so the
 * viewer keeps working without it; throws ReaderError for a present-but-invalid file.
 */
export async function loadReader(
  sitePeakCount?: number,
  url = `${import.meta.env.BASE_URL}data/reader.json`,
  signal?: AbortSignal
): Promise<ReaderLayer | null> {
  let res: Response;
  try {
    res = await fetch(url, { signal });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    return null;
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new ReaderError(`Could not load ${url} (HTTP ${res.status})`);
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    // Vite's dev server answers unknown paths with index.html; treat that as "no reader layer".
    return null;
  }
  return parseReader(json, sitePeakCount);
}
