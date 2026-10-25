/** Talks to the guide server (guide/server.py, proxied by Vite at /api). */

export type Level = 'new' | 'some' | 'expert';
export type Page = 'cosmic' | 'layers' | 'tour';
export interface Turn {
  role: 'user' | 'assistant';
  content: string;
}
export interface GuideRequest {
  turns: Turn[];
  level: Level;
  page?: Page;
  stop?: number;
  context?: Record<string, unknown>;
}

export type GuideErrorCode = 'cancelled' | 'offline' | 'no_key' | 'rate_limited' | 'upstream_error' | 'bad_request';

export class GuideError extends Error {
  constructor(
    readonly code: GuideErrorCode,
    readonly partial = ''
  ) {
    super(code);
  }
}

export const GUIDE_ERROR_TEXT: Record<Exclude<GuideErrorCode, 'cancelled'>, string> = {
  offline: 'The guide server isn’t running. Start it with python guide/server.py.',
  no_key: 'The guide server has no API key. Set ANTHROPIC_API_KEY and restart it.',
  rate_limited: 'Lots of questions right now. Try again in a minute.',
  upstream_error: 'The guide couldn’t reach Claude just now. Ask again.',
  bad_request: 'That question couldn’t be sent. Try rephrasing it.',
};

function codeFor(status: number, error: unknown): GuideErrorCode {
  if (error === 'no_key') return 'no_key';
  if (status === 429) return 'rate_limited';
  if (status === 400 || status === 413) return 'bad_request';
  if (status === 404 || status === 503) return 'offline';
  return 'upstream_error';
}

/** Streams the answer, calling onText with the whole answer so far. Resolves with the full text. */
export async function askGuide(
  req: GuideRequest,
  opts: { onText?: (text: string) => void; signal?: AbortSignal; endpoint?: string; fetchImpl?: typeof fetch } = {}
): Promise<string> {
  const doFetch = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(opts.endpoint ?? '/api/guide', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
      signal: opts.signal,
    });
  } catch {
    throw new GuideError(opts.signal?.aborted ? 'cancelled' : 'offline');
  }
  if (!res.ok) {
    let error: unknown;
    try {
      error = ((await res.json()) as { error?: unknown }).error;
    } catch {
      /* proxy errors are not JSON */
    }
    // Vite answers 500/502/504 itself when the guide server is down.
    if (!error && res.status >= 500) throw new GuideError('offline');
    throw new GuideError(codeFor(res.status, error));
  }
  let text = '';
  if (!res.body) {
    text = await res.text();
    opts.onText?.(text);
    return text;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const delta = decoder.decode(value, { stream: true });
      if (delta) {
        text += delta;
        opts.onText?.(text);
      }
    }
    text += decoder.decode();
  } catch {
    throw new GuideError(opts.signal?.aborted ? 'cancelled' : 'upstream_error', text);
  }
  if (!text.trim()) throw new GuideError('upstream_error');
  return text;
}
