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

/** The modules of the page's code that load a module whose path matches `module`: a type alone loads nothing. */
function loadersOf(module: RegExp): string[] {
  const ui = fileURLToPath(new URL('../ui/', import.meta.url));
  return readdirSync(ui, { recursive: true, encoding: 'utf8' })
    .filter((f) => /\.tsx?$/.test(f) && readFileSync(join(ui, f), 'utf8').split('\n').some((l) => module.test(l) && !/^import type\b/.test(l.trim())))
    .map((f) => f.split(sep).join('/'));
}

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

  it('never opens Export OpenTelemetry trace…: Share’s menu alone loads its dialog, and a copy draws no Share', () => {
    // The page's code that loads the dialog's script: Share's menu, and nothing a copy draws, so the
    // copy's script holds none of it (COPY_PARTS in test/ui-bundle-size.test.ts).
    expect(loadersOf(/\bOtelDialog\.js['"]/)).toEqual(['run/ShareMenu.tsx']);
  });

  it('never opens the check builder or Run blame’s dialogs: the served entry alone loads them, and a copy offers no Add check… at a tool call', async () => {
    // The page's code that loads their scripts: the parts the served entry hands in, which a copy's
    // entry never does, so the copy's script holds none of ui/checks/ (HEAVY in test/ui-bundle-size.test.ts)
    // nor Run blame's dialogs. A copy draws no Run blame: its one next step is Compare (test/next-step.test.ts).
    expect(loadersOf(/\bchecks\/Builder\.js['"]/)).toEqual(['pages/served.tsx']);
    expect(loadersOf(/\bRunBlameAsks\.js['"]/)).toEqual(['pages/served.tsx']);
    // At a tool call of a finished recording, where the served dashboard offers it on the inspector.
    await open([forkId, runId], `#/run/${forkId}/4`);
    await r!.until('the call’s inspector', () => r!.all('.insp').length === 1);
    expect(r!.all('[data-act="ckmenu"]')).toHaveLength(0);
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
      [[forkId, runId], '#/settings/ci'],
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
