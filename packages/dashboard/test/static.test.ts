import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store, unpackRun } from '@shadowlap/engine';
import { exportHtml, withAncestors, type StaticPayload } from '../src/index.js';

/** `shadowlap export html`: a run as one file, with the dashboard's answers built in. */
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

  // A stand-in for the built UI, so the test does not depend on a bundle.
  uiDir = mkdtempSync(join(tmpdir(), 'fp-export-ui-'));
  mkdirSync(join(uiDir, 'assets', 'fonts'), { recursive: true });
  writeFileSync(join(uiDir, 'assets', 'app.css'), "@font-face { src: url('./fonts/inter.woff2') format('woff2'); }\n.app { color: red }\n");
  // A script that contains the end of a script tag: it must not end the one it is written into.
  writeFileSync(join(uiDir, 'assets', 'app.js'), 'const end = "</script>"; console.log(end);\n');
  writeFileSync(join(uiDir, 'assets', 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  writeFileSync(join(uiDir, 'assets', 'fonts', 'inter.woff2'), Buffer.from('wOF2fake'));
});
afterAll(() => {
  store.close();
  rmSync(uiDir, { recursive: true, force: true });
});

function embedded(html: string): StaticPayload {
  const m = /<script type="application\/json" id="shadowlap-data">(.*?)<\/script>/s.exec(html);
  expect(m, 'the data block is there and ends where it should').not.toBeNull();
  return JSON.parse(m![1]!.split('<\\/').join('</')) as StaticPayload;
}

describe('export html', () => {
  it('carries every view the file can open, and nothing it would need a network for', () => {
    const result = exportHtml({ store, runIds: [forkId, runId], uiDir, version: '0.1.0', now: 1_800_000_000_000 });
    expect(result).toMatchObject({ runIds: [forkId, runId], calls: 34, redacted: false });
    const data = embedded(result.html);
    expect(data.responses['meta']).toMatchObject({ actions: false, static: true, dbPath: null, exportedAt: 1_800_000_000_000, version: '0.1.0' });
    expect((data.responses['runs'] as { runs: unknown[] }).runs).toHaveLength(2);
    expect(data.responses[`runs/${runId}`]).toBeDefined();
    expect(data.responses[`runs/${runId}/calls/30`]).toMatchObject({ actions: [] });
    expect(data.responses[`runs/${forkId}/lineage`]).toBeDefined();
    expect(data.responses[`compare?a=${runId}&b=${forkId}`]).toMatchObject({ identicalPrefix: 4, onlyInA: 26 });
    // The fork's parent is in the file, so it stays linked; a run left out would not be.
    expect(data.responses[`runs/${forkId}`]).toMatchObject({ parent: { runId } });
    expect(data.responses[`runs/${runId}`]).toMatchObject({ parent: null });

    // Everything is inline: no stylesheet, script or font is fetched, and the font became a data URI.
    expect(result.html).not.toMatch(/<script[^>]+src=/);
    expect(result.html).not.toMatch(/<link rel="stylesheet"/);
    expect(result.html).toContain('url(data:font/woff2;base64,');
    expect(result.html).toContain("default-src 'none'");
    // The bundled script survives intact, including the text that would have closed its tag.
    expect(result.html).toContain('const end = "<\\/script>"');
  });

  it('leaves out the runs it was not asked for, and links only what it holds', () => {
    const only = exportHtml({ store, runIds: [forkId], uiDir });
    const data = embedded(only.html);
    expect((data.responses['runs'] as { runs: Array<{ runId: string }> }).runs.map((r) => r.runId)).toEqual([forkId]);
    expect(data.responses[`runs/${forkId}`]).toMatchObject({ parent: null });
    expect((data.responses[`runs/${forkId}/lineage`] as { nodes: unknown[] }).nodes).toHaveLength(1);
    expect(data.responses[`runs/${runId}`]).toBeUndefined();
  });

  it('applies redaction rules, as pack does', () => {
    const rules = [{ pattern: 'email', replace: '<EMAIL>' }];
    const plain = exportHtml({ store, runIds: [runId], uiDir });
    expect(plain.html).toContain('team@example.com');
    const redacted = exportHtml({ store, runIds: [runId], uiDir, redact: rules });
    expect(redacted.redacted).toBe(true);
    expect(redacted.html).not.toContain('team@example.com');
    expect(redacted.html).toContain('<EMAIL>');
  });

  it('leaves out who made each run, with or without redaction rules, unless asked to keep it', () => {
    const own = Store.open(':memory:');
    try {
      const parent = unpackRun(own, GOLDEN).imported[0]!;
      own.updateRunMeta(parent, { author: 'dana.private@example.com' });
      const fork = own.createRun({ mode: 'replay', parentRunId: parent, command: { argv: ['node', 'agent.js'], cwd: '.' }, meta: { author: 'dana.private@example.com' } });
      own.endRun(fork.runId, 'completed');
      for (const redact of [undefined, [{ pattern: 'email', replace: '<EMAIL>' }]]) {
        const out = exportHtml({ store: own, runIds: [fork.runId, parent], uiDir, ...(redact ? { redact } : {}) });
        expect(out.html, redact ? 'with rules' : 'without rules').not.toContain('dana.private');
        const data = embedded(out.html);
        expect((data.responses[`runs/${parent}`] as { run: { meta: Record<string, unknown> } }).run.meta).not.toHaveProperty('author');
      }
      // The store keeps it: only the file leaves it out.
      expect(own.getRun(parent)!.meta?.author).toBe('dana.private@example.com');
      expect(exportHtml({ store: own, runIds: [parent], uiDir, keepAuthor: true }).html).toContain('dana.private@example.com');
    } finally {
      own.close();
    }
  });

  it('lists a run with its ancestors, oldest first', () => {
    expect(withAncestors(store, forkId)).toEqual([runId, forkId]);
    expect(withAncestors(store, runId)).toEqual([runId]);
  });
});
