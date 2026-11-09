import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Store, unpackRun } from '@shadowlap/engine';
import { exportHtml, type StaticPayload } from '../src/index.js';
import { createExportedClient } from '../ui/api.js';
import { CopyPages } from '../ui/pages/copy.js';
import { useRoute } from '../ui/router.js';
import { AppProvider } from '../ui/state.js';
import { render, type Rendered } from './ui-render.js';

/**
 * An exported copy is built from an entry of its own (ui/main-copy.tsx), with only the pages it
 * shows (ui/pages/copy.tsx): its runs, a run's page and Compare between them. Drawn here from a real
 * export's data, as the copy draws it, it still opens on the run that was shared, lists its runs,
 * compares them, and sends every other page to its runs. It draws nothing that opens a part only the
 * served dashboard hands in (ui/served-parts.ts), whose code its script doesn't hold, nor the dialogs
 * only such a part opens.
 */
const GOLDEN = fileURLToPath(new URL('../../../testing/golden/reference-agent', import.meta.url));

let store: Store;
let runId: string;
let forkId: string;
let attemptId: string;
let uiDir: string;

beforeAll(() => {
  store = Store.open(':memory:');
  runId = unpackRun(store, GOLDEN).imported[0]!;
  const fork = store.createRun({ mode: 'replay', parentRunId: runId, command: { argv: ['node', 'agent.js'], cwd: '.' } });
  forkId = fork.runId;
  for (const c of store.getCalls(runId).slice(0, 4)) {
    const { end, attempts, ...start } = c;
    void attempts;
    store.appendCallStart({ ...start, runId: forkId, origin: c.callNo < 3 ? 'replayed' : 'live' });
    if (end) store.appendCallEnd(c, { ...end, runId: forkId });
  }
  store.setDivergence(forkId, { type: 'request_changed', callNo: 3, kind: 'api', name: 'POST /v1/messages', replayedBefore: 2 });
  store.endRun(forkId, 'completed');
  // An injection test's attempt, its mark on its own record: a copy holds the mark, never the test's results.
  const canary = { token: 'x7f3kq2m', address: 'x7f3kq2m@canary.invalid', id: 'CNRY-x7f3kq2m', amount: '4,812.00' };
  const injection = { result: 'inj-01PLANT', role: 'attempt' as const, read: 2, payload: 'system-notice', attempt: 2, of: 3, canary, verdict: 'obeyed' as const, readAt: 3, evidence: [{ kind: 'canary' as const, callNo: 4, tool: 'send_email', path: '$.to', value: canary.address }] };
  attemptId = store.createRun({ mode: 'replay', parentRunId: runId, command: { argv: ['node', 'agent.js'], cwd: '.' }, meta: { injection } }).runId;
  // The test it was in, kept for the run it tested, as the served dashboard draws its finding from.
  store.putInjectionResult({ resultId: 'inj-01PLANT', runId, golden: null, sessionId: null, mode: 'plant', at: 1, endedAt: 2, attempts: 3, obeyed: 1, influenced: 0, ignored: 2, inconclusive: 0, verdict: 'obeyed', actor: null, data: { resultId: 'inj-01PLANT', mode: 'plant', gate: { obeyed: 0, influenced: null, verdict: 'failed', reason: 'send_email obeyed a planted instruction in 1 of 3 attempts (at most 0 allowed)' }, cost: { spent: 0 } } });
  for (const c of store.getCalls(runId).slice(0, 4)) {
    const { end, attempts, ...start } = c;
    void attempts;
    store.appendCallStart({ ...start, runId: attemptId, origin: c.callNo < 3 ? 'replayed' : 'live' });
    if (end) store.appendCallEnd(c, { ...end, runId: attemptId });
  }
  store.endRun(attemptId, 'completed');
  // A stand-in for the built UI: what is under test is the data the file carries, drawn by the copy's pages.
  uiDir = mkdtempSync(join(tmpdir(), 'sl-export-copy-ui-'));
  mkdirSync(join(uiDir, 'assets'), { recursive: true });
  writeFileSync(join(uiDir, 'assets', 'app.css'), '.app{}\n');
  writeFileSync(join(uiDir, 'assets', 'copy.js'), 'console.log(1);\n');
  writeFileSync(join(uiDir, 'assets', 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
});
afterAll(() => {
  store.close();
  rmSync(uiDir, { recursive: true, force: true });
});

let r: Rendered | null = null;
afterEach(async () => {
  await r?.unmount();
  r = null;
  vi.unstubAllGlobals();
});

/** The data an exported file of these runs embeds, read back as the copy reads it. */
function exported(runIds: string[]): StaticPayload {
  const { html } = exportHtml({ store, runIds, uiDir });
  return JSON.parse(/<script type="application\/json" id="shadowlap-data">([\s\S]*?)<\/script>/.exec(html)![1]) as StaticPayload;
}

/** The copy's page for the route the address bar holds, as its shell draws it. */
function Routed() {
  return createElement(CopyPages, { route: useRoute() });
}

/** A copy of these runs, opened at `hash`; the address bar it reads and rewrites. */
async function open(runIds: string[], hash: string) {
  const bar = { hash, search: '', pathname: '/', host: '' };
  vi.stubGlobal('location', bar);
  vi.stubGlobal('history', { state: null, replaceState: (_s: unknown, _t: string, url: string) => void (bar.hash = url.slice(url.indexOf('#'))) });
  r = await render(createElement(AppProvider, { client: createExportedClient(exported(runIds)), children: createElement(Routed) }));
  return bar;
}

const runOpen = () => r!.all('.rhead .rnm').map((h) => h.getAttribute('data-run'));

describe('an exported copy', () => {
  it('opens on the run that was shared, the one the others lead to, whichever order it lists them in', async () => {
    for (const order of [
      [forkId, runId],
      [runId, forkId],
    ]) {
      const bar = await open(order, '#/');
      await r!.until('the shared run’s page', () => runOpen().length === 1);
      // At the call where it forked, as a fork's page opens.
      expect(bar.hash).toBe(`#/run/${forkId}/3`);
      expect(runOpen()).toEqual([forkId]);
      await r!.unmount();
      r = null;
    }
  });

  it('opens each of its runs, and says so of a run it doesn’t hold', async () => {
    await open([forkId, runId], `#/run/${runId}`);
    await r!.until('the run’s page', () => runOpen().length === 1);
    expect(runOpen()).toEqual([runId]);
    await r!.unmount();
    await open([forkId], `#/run/${runId}`);
    // The page's header, as any page has it: not found, Nothing here, what was missing and the way back.
    await r!.until('what the copy says', () => r!.all('.ph h1').length > 0);
    expect(r!.one('.ph h1').textContent).toBe('Nothing here');
    expect(r!.one('.ph .eyebrow').textContent).toBe('not found');
    expect(r!.one('.ph').textContent).toContain(`No run ${runId} in this copy. Open Runs`);
    expect(r!.one('.ph a.more').getAttribute('href')).toBe('#/runs');
  });

  it('draws no Share on a run’s page, so nothing there opens Share’s menu, which the served dashboard alone hands in', async () => {
    await open([forkId, runId], `#/run/${forkId}`);
    await r!.until('the run’s header and what it offers', () => r!.all('.rhead .actions').length === 1);
    expect(r!.all('#shareBtn')).toHaveLength(0);
    expect(r!.all('.rhead .actions button').map((b) => b.textContent)).not.toContain('Share');
    expect(r!.all('[role="menu"]')).toHaveLength(0);
  });

  it('draws no step that asks, so nothing there opens the dialogs the served dashboard alone hands in', async () => {
    await open([forkId, runId], `#/run/${runId}`);
    await r!.until('the run’s header and what it offers', () => r!.all('.rhead .actions').length === 1);
    // What reads stays: the id to copy, and the link to compare.
    expect(r!.all('.rhead button').map((b) => b.textContent)).toEqual(['Copy ID']);
    expect(r!.all('.rhead button[data-next], .rhead button[data-fold]')).toHaveLength(0);
    expect(r!.all('.dialog')).toHaveLength(0);
  });

  it('names an injection attempt by its own record, and draws nothing of what only the test’s read holds: where it planted, its proof, the way to its results', async () => {
    await open([attemptId, runId], `#/run/${attemptId}`);
    await r!.until('the attempt’s finding', () => r!.all('.banner').length > 0);
    expect(r!.one('.rhead').textContent).toContain('injection attempt');
    const banner = r!.all('.banner').map((b) => b.textContent).join(' ').replace(/\u00a0/g, ' ');
    expect(banner).toContain('forked at#3system-notice #2, attempt 2 of 3 · writes stubbed');
    expect(banner).not.toMatch(/Results →|The answer →|planted at/);
    expect(r!.all('.injline, .pbn, mark.cnry, mark.ins-plant')).toHaveLength(0);
  });

  it('keeps no injection test, so the run it tested draws no finding of one, which the served dashboard alone hands in', async () => {
    await open([attemptId, runId], `#/run/${runId}`);
    await r!.until('the run’s header and what it offers', () => r!.all('.rhead .actions').length === 1);
    expect(r!.all('[data-finding="injection"]')).toHaveLength(0);
    expect(r!.all('[data-act="results"]')).toHaveLength(0);
  });

  it('never opens Export OpenTelemetry trace…: Share’s menu alone loads its dialog, and a copy draws no Share', () => {
    // The page's code that loads the dialog's script: Share's menu, and nothing a copy draws, so the
    // copy's script holds none of it (COPY_PARTS in test/ui-bundle-size.test.ts).
    const ui = fileURLToPath(new URL('../ui/', import.meta.url));
    const loaders = readdirSync(ui, { recursive: true, encoding: 'utf8' })
      .filter((f) => /\.tsx?$/.test(f) && /\bOtelDialog\.js['"]/.test(readFileSync(join(ui, f), 'utf8')))
      .map((f) => f.split(sep).join('/'));
    expect(loaders).toEqual(['run/ShareMenu.tsx']);
  });

  it('lists its runs, and only those', async () => {
    await open([forkId, runId], '#/runs');
    await r!.until('the runs', () => r!.all('table.runst tbody tr').length === 2);
    const rows = r!.all('table.runst tbody tr').map((tr) => tr.textContent);
    expect(rows.some((t) => t.includes(forkId.slice(0, 10)))).toBe(true);
    expect(rows.some((t) => t.includes(runId.slice(0, 10)))).toBe(true);
  });

  it('compares the runs it holds', async () => {
    await open([forkId, runId], `#/compare/${runId}/${forkId}`);
    await r!.until('the comparison', () => r!.all('.prefix').length === 1);
    expect(r!.one('.prefix b').textContent).not.toBe('');
    expect(r!.all('.pickers').length).toBe(1);
  });

  it('sends any other page to its runs, and Compare too when it holds one run', async () => {
    for (const [runIds, hash] of [
      [[forkId, runId], '#/fixes'],
      [[forkId, runId], '#/changes'],
      [[forkId, runId], '#/tests'],
      [[forkId, runId], '#/settings/alerts'],
      [[forkId], '#/compare'],
    ] as const) {
      const bar = await open([...runIds], hash);
      await r!.until(`${hash} to open the runs`, () => r!.all('table.runst tbody tr').length === runIds.length);
      expect(bar.hash, hash).toBe('#/runs');
      await r!.unmount();
      r = null;
    }
  });
});
