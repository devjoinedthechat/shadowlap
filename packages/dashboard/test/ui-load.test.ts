import { createElement, useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '../ui/api.js';
import { useLoad } from '../ui/hooks.js';
import { render, type Rendered } from './ui-render.js';

/**
 * What a page loads, read again as the store changes: kept while it reloads and when a reload fails,
 * so a server that stopped a moment leaves the page as it was; dropped when the reload says it is
 * gone (404), so a run deleted while its page is open says so rather than show what it was.
 */

/** A page that loads `load()` again at each click of `.again`, showing what it has and why it couldn't. */
function Host({ load }: { load: () => Promise<string> }) {
  const [n, setN] = useState(0);
  const loaded = useLoad(load, 'run', n);
  return createElement(
    'div',
    null,
    createElement('button', { type: 'button', className: 'again', onClick: () => setN((x) => x + 1) }, 'Again'),
    createElement('p', { className: 'data' }, loaded.data ?? 'nothing'),
    createElement('p', { className: 'error' }, loaded.error?.message ?? ''),
  );
}

let r: Rendered | null = null;
afterEach(async () => {
  await r?.unmount();
  r = null;
});

describe('what a page loads', () => {
  it('keeps what it had when a reload fails, and drops it when the reload says it is gone', async () => {
    const answers: Array<() => Promise<string>> = [() => Promise.resolve('the run'), () => Promise.reject(new ApiError(503, 'the dashboard is stopping')), () => Promise.reject(new ApiError(404, 'no run 01M5GRX8K4'))];
    let at = 0;
    r = await render(createElement(Host, { load: () => answers[Math.min(at++, answers.length - 1)]() }));
    await r.until('the run', () => r!.one('.data').textContent === 'the run');
    // The server couldn't answer for a moment: the page keeps what it had, and says why.
    await r.click(r.one('.again'));
    await r.until('the failure', () => r!.one('.error').textContent === 'the dashboard is stopping');
    expect(r.one('.data').textContent).toBe('the run');
    // The run was deleted: what the page had goes, so the page says the run is gone.
    await r.click(r.one('.again'));
    await r.until('the run gone', () => r!.one('.error').textContent === 'no run 01M5GRX8K4');
    expect(r.one('.data').textContent).toBe('nothing');
  });
});
