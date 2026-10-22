import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, createClient } from '../ui/api.js';
import { REVALIDATION_LIMITS } from '../ui/revalidate.js';

/**
 * The page's client keeps answers to ask again with If-None-Match, within the bound revalidate.ts
 * sets: it used to keep the last answer of every path it had fetched for the tab's life, 57 MB after
 * opening sixteen calls with long prompts. Asked through the client the page uses, against a server
 * that tags every answer.
 */

/** A server that tags each answer with its path and answers 304 to a tag it gave; it notes what each request revalidated. */
function server() {
  const asked: Array<{ path: string; tag: string | null }> = [];
  const fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
    const path = String(url).replace(/^\/api\//, '');
    const tag = (init.headers as Record<string, string> | undefined)?.['if-none-match'] ?? null;
    asked.push({ path, tag });
    const etag = `"${path}"`;
    if (tag === etag) return new Response(null, { status: 304, headers: { etag } });
    return new Response(JSON.stringify({ path }), { status: 200, headers: { etag, 'content-type': 'application/json' } });
  });
  return { asked, fetch };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the answers the page keeps to ask again', () => {
  it('revalidates what it keeps, and keeps no more paths than its bound however many the tab asks for', async () => {
    const s = server();
    vi.stubGlobal('fetch', s.fetch);
    const client = createClient('token');
    const first = await client.showJson('R1');
    // Asked again: revalidated, and the same answer back.
    expect(await client.showJson('R1')).toBe(first);
    expect(s.asked.at(-1)).toEqual({ path: 'runs/R1/show', tag: '"runs/R1/show"' });
    // Every run of a long session opened, one after another.
    for (let n = 2; n <= REVALIDATION_LIMITS.entries + 40; n++) await client.showJson(`R${n}`);
    await client.showJson('R1');
    // The first went long ago: asked afresh.
    expect(s.asked.at(-1)).toEqual({ path: 'runs/R1/show', tag: null });
    // The latest is still kept.
    await client.showJson(`R${REVALIDATION_LIMITS.entries + 40}`);
    expect(s.asked.at(-1)!.tag).not.toBeNull();
  });
});

describe('a read of something the store doesn’t hold', () => {
  it('is asked for as an answer, which the page takes as the 404 it is, so the browser logs no failed load', async () => {
    const asked: Array<{ path: string; method: string; notFound: string | null }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit = {}) => {
        const path = String(url).replace(/^\/api\//, '');
        asked.push({ path, method: init.method ?? 'GET', notFound: (init.headers as Record<string, string>)['x-shadowlap-not-found'] ?? null });
        // As the server answers a page that asks so: 200, saying what is missing.
        if (path === 'runs/01ZZZZZZZZ') return new Response(JSON.stringify({ error: 'no run 01ZZZZZZZZ', notFound: true }), { status: 200 });
        if (path === 'runs/01ZZZZZZZZ/labels') return new Response(JSON.stringify({ error: 'no run 01ZZZZZZZZ' }), { status: 404 });
        return new Response(JSON.stringify({ hits: [] }), { status: 200 });
      }),
    );
    const client = createClient('token');
    const gone = await client.run('01ZZZZZZZZ').catch((err: unknown) => err);
    expect(gone).toBeInstanceOf(ApiError);
    expect(gone).toMatchObject({ status: 404, message: 'no run 01ZZZZZZZZ' });
    // A write asks nothing of the kind: its 404 is a failure the page reports.
    await expect(client.labels('01ZZZZZZZZ', ['x'])).rejects.toMatchObject({ status: 404 });
    expect(await client.search('refund')).toEqual({ hits: [] });
    expect(asked.map((a) => [a.path.split('?')[0], a.method, a.notFound])).toEqual([
      ['runs/01ZZZZZZZZ', 'GET', 'answer'],
      ['runs/01ZZZZZZZZ/labels', 'POST', null],
      ['search', 'GET', 'answer'],
    ]);
  });
});
