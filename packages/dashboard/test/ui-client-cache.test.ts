import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '../ui/api.js';
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
