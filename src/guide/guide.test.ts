import { describe, expect, it } from 'vitest';
import { askGuide, GuideError } from './client';
import { renderMarkdown } from './markdown';

describe('renderMarkdown', () => {
  it('escapes HTML from the model', () => {
    expect(renderMarkdown('<img src=x onerror=alert(1)>')).toBe('<p>&lt;img src=x onerror=alert(1)&gt;</p>');
  });
  it('renders bold, lists and https links only', () => {
    const html = renderMarkdown('**κ** is mass.\n\n- one\n- two\n\n[DES](https://des.ncsa.illinois.edu) [bad](javascript:alert(1))');
    expect(html).toContain('<strong>κ</strong>');
    expect(html).toContain('<ul><li>one</li><li>two</li></ul>');
    expect(html).toContain('<a href="https://des.ncsa.illinois.edu"');
    expect(html).not.toContain('href="javascript');
  });
  it('keeps products like 2*3*4 as text', () => {
    expect(renderMarkdown('2*3*4')).toBe('<p>2*3*4</p>');
  });
});

function streamResponse(chunks: string[], status = 200): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      chunks.forEach((s) => c.enqueue(enc.encode(s)));
      c.close();
    },
  });
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain' } });
}

describe('askGuide', () => {
  const req = { turns: [{ role: 'user' as const, content: 'hi' }], level: 'new' as const, page: 'layers' as const };

  it('streams the whole answer so far to onText', async () => {
    const seen: string[] = [];
    let sent: unknown;
    const text = await askGuide(req, {
      onText: (t) => seen.push(t),
      fetchImpl: (async (_u: string, init: RequestInit) => {
        sent = JSON.parse(String(init.body));
        return streamResponse(['Dark ', 'matter']);
      }) as unknown as typeof fetch,
    });
    expect(text).toBe('Dark matter');
    expect(seen).toEqual(['Dark ', 'Dark matter']);
    expect(sent).toMatchObject({ level: 'new', page: 'layers' });
  });

  it('maps server errors to codes', async () => {
    const json = (status: number, error?: string) =>
      (async () => new Response(error ? JSON.stringify({ error }) : 'proxy down', { status })) as unknown as typeof fetch;
    await expect(askGuide(req, { fetchImpl: json(503, 'no_key') })).rejects.toMatchObject({ code: 'no_key' });
    await expect(askGuide(req, { fetchImpl: json(429, 'rate_limited') })).rejects.toMatchObject({ code: 'rate_limited' });
    await expect(askGuide(req, { fetchImpl: json(502) })).rejects.toMatchObject({ code: 'offline' });
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await expect(askGuide(req, { fetchImpl: down })).rejects.toBeInstanceOf(GuideError);
  });
});
