import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store, unpackRun } from '@shadowlap/engine';
import { forkDifferences } from '../src/fork-differences.js';
import { requestDiff } from '../src/request-diff.js';
import { addRun } from './read-model-store.js';
import { exportHtml, withAncestors, type StaticPayload } from '../src/index.js';
import { parseRoute } from '../ui/route.js';
import { defaultComparePair, type RunLike } from '../ui/runs.js';
import { docTitle } from '../ui/title.js';

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

const EMAIL = 'dana.lee@example.com';
const SECRET = 'sk-test-4f9Qx7Lm2Np8Rt3V';
const ASKED = `Refund order 1042 for ${EMAIL}, key ${SECRET}`;

/** A recording and a fork whose first request changed, both carrying an address and a made-up key. */
function divergedPair(): { fork: string; parent: string } {
  const body = (asked: string) => ({ model: 'claude-sonnet-4-5', max_tokens: 512, system: `Write to ${EMAIL} when done.`, messages: [{ role: 'user', content: asked }] });
  const parent = addRun(store, { startedAt: Date.UTC(2026, 10, 2, 9), calls: [{ code: 'l', request: body(ASKED) }] });
  const fork = addRun(store, { parent, startedAt: Date.UTC(2026, 10, 2, 10), calls: [{ code: 'l', request: body(ASKED.replace('1042', '1043')) }] });
  store.setDivergence(fork, { type: 'request_changed', callNo: 1, kind: 'api', name: 'POST /v1/messages', replayedBefore: 0, counterpart: { runId: parent, callNo: 1 }, diff: [{ path: '$.messages[0].content', op: 'changed', before: ASKED, after: ASKED.replace('1042', '1043') }] });
  return { fork, parent };
}

function embedded(html: string): StaticPayload {
  return JSON.parse(dataAsParsed(html)) as StaticPayload;
}

/**
 * Where an HTML parser ends a script element whose text starts at `from`: the script data states of
 * the HTML tokenizer (escaped and double-escaped included), up to the end tag that closes it. -1
 * when nothing does. What the file's own regex finds is beside the point: this is what a browser does.
 */
function scriptEnd(html: string, from: number): number {
  type State = 'data' | 'lt' | 'endOpen' | 'endName' | 'escStart' | 'escStartDash' | 'esc' | 'escDash' | 'escDashDash' | 'escLt' | 'escEndOpen' | 'escEndName' | 'dblStart' | 'dbl' | 'dblDash' | 'dblDashDash' | 'dblLt' | 'dblEnd';
  const alpha = (c: string) => /[A-Za-z]/.test(c);
  const ends = (c: string) => /[\t\n\f />]/.test(c);
  let state = 'data' as State;
  let buf = '';
  let tagAt = -1;
  for (let i = from; i < html.length; i++) {
    const c = html[i];
    const again = (s: State) => {
      state = s;
      i--;
    };
    switch (state) {
      case 'data': if (c === '<') state = 'lt'; break;
      case 'lt': if (c === '/') { buf = ''; tagAt = i - 1; state = 'endOpen'; } else if (c === '!') state = 'escStart'; else again('data'); break;
      case 'endOpen': if (alpha(c)) again('endName'); else again('data'); break;
      case 'endName': if (ends(c) && buf === 'script') return tagAt; else if (alpha(c)) buf += c.toLowerCase(); else again('data'); break;
      case 'escStart': if (c === '-') state = 'escStartDash'; else again('data'); break;
      case 'escStartDash': if (c === '-') state = 'escDashDash'; else again('data'); break;
      case 'esc': if (c === '-') state = 'escDash'; else if (c === '<') state = 'escLt'; break;
      case 'escDash': state = c === '-' ? 'escDashDash' : c === '<' ? 'escLt' : 'esc'; break;
      case 'escDashDash': state = c === '-' ? 'escDashDash' : c === '<' ? 'escLt' : c === '>' ? 'data' : 'esc'; break;
      case 'escLt': if (c === '/') { buf = ''; tagAt = i - 1; state = 'escEndOpen'; } else if (alpha(c)) { buf = ''; again('dblStart'); } else again('esc'); break;
      case 'escEndOpen': if (alpha(c)) again('escEndName'); else again('esc'); break;
      case 'escEndName': if (ends(c) && buf === 'script') return tagAt; else if (alpha(c)) buf += c.toLowerCase(); else again('esc'); break;
      case 'dblStart': if (ends(c)) state = buf === 'script' ? 'dbl' : 'esc'; else if (alpha(c)) buf += c.toLowerCase(); else again('esc'); break;
      case 'dbl': if (c === '-') state = 'dblDash'; else if (c === '<') state = 'dblLt'; break;
      case 'dblDash': state = c === '-' ? 'dblDashDash' : c === '<' ? 'dblLt' : 'dbl'; break;
      case 'dblDashDash': state = c === '-' ? 'dblDashDash' : c === '<' ? 'dblLt' : c === '>' ? 'data' : 'dbl'; break;
      case 'dblLt': if (c === '/') { buf = ''; state = 'dblEnd'; } else again('dbl'); break;
      case 'dblEnd': if (ends(c)) state = buf === 'script' ? 'esc' : 'dbl'; else if (alpha(c)) buf += c.toLowerCase(); else again('dbl'); break;
    }
  }
  return -1;
}

/** The data block as a browser reads it: from its start tag to wherever the parser ends it. */
function dataAsParsed(html: string): string {
  const open = '<script type="application/json" id="shadowlap-data">';
  const at = html.indexOf(open) + open.length;
  const end = scriptEnd(html, at);
  expect(end, 'the data block ends').toBeGreaterThan(0);
  return html.slice(at, end);
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

  it('carries the copy’s own script, with the pages a copy shows, never the one the dashboard serves', () => {
    // A built UI has both (build-ui.mjs): the dashboard's app.js loads each page's code from the server.
    const built = mkdtempSync(join(tmpdir(), 'fp-export-built-'));
    try {
      mkdirSync(join(built, 'assets'), { recursive: true });
      writeFileSync(join(built, 'assets', 'app.css'), '.app { color: red }\n');
      writeFileSync(join(built, 'assets', 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
      writeFileSync(join(built, 'assets', 'app.js'), 'import("./chunks/Overview.js");\n');
      writeFileSync(join(built, 'assets', 'copy.js'), 'console.log("the copy");\n');
      const { html } = exportHtml({ store, runIds: [forkId, runId], uiDir: built });
      expect(html).toContain('<script type="module">console.log("the copy");\n</script>');
      expect(html).not.toContain('chunks/Overview.js');
    } finally {
      rmSync(built, { recursive: true, force: true });
    }
  });

  it('names its tab by the run it opens on, as the page’s own title does once it has drawn', () => {
    const { html } = exportHtml({ store, runIds: [forkId, runId], uiDir });
    expect(/<title>([^<]*)<\/title>/.exec(html)?.[1]).toBe(docTitle(parseRoute(`#/run/${forkId}`)));
    expect(html).toContain(`<title>${forkId.slice(0, 10)} — shadowlap</title>`);
  });

  it('names no folder of the machine it was made on, not even the one a run was recorded in', () => {
    const folder = join(tmpdir(), 'dana', 'projects', 'support-agent');
    const here = store.createRun({ mode: 'record', command: { argv: ['node', 'agent.js'], cwd: folder } });
    store.endRun(here.runId, 'completed');
    for (const redact of [[], [{ pattern: 'email', replace: '<EMAIL>' }]]) {
      const { html } = exportHtml({ store, runIds: [here.runId], uiDir, redact });
      expect(html).not.toContain(folder);
      // The command stays: the page shows it. Where it ran is left out.
      expect(embedded(html).responses[`runs/${here.runId}`]).toMatchObject({ run: { command: { argv: ['node', 'agent.js'], cwd: '' } } });
    }
  });

  it('leaves out the runs it was not asked for, and links only what it holds', () => {
    const only = exportHtml({ store, runIds: [forkId], uiDir });
    const data = embedded(only.html);
    expect((data.responses['runs'] as { runs: Array<{ runId: string }> }).runs.map((r) => r.runId)).toEqual([forkId]);
    expect(data.responses[`runs/${forkId}`]).toMatchObject({ parent: null });
    expect((data.responses[`runs/${forkId}/lineage`] as { nodes: unknown[] }).nodes).toHaveLength(1);
    expect(data.responses[`runs/${runId}`]).toBeUndefined();
    // What the fork did differently quotes its parent's calls: left out with the parent.
    expect(data.responses[`runs/${forkId}/differences`]).toBeUndefined();
  });

  it('holds what a fork did differently when it holds its parent too, redacted as the runs are', () => {
    const both = embedded(exportHtml({ store, runIds: [forkId, runId], uiDir }).html);
    expect(both.responses[`runs/${forkId}/differences`]).toEqual(JSON.parse(JSON.stringify({ differences: forkDifferences(store, forkId) })));
    expect(both.responses[`runs/${forkId}/differences`]).toMatchObject({ differences: { runId: forkId, parentRunId: runId, from: 3 } });
    // A recording did nothing differently: nothing held for it.
    expect(both.responses[`runs/${runId}/differences`]).toBeUndefined();
    // The parent's send_email the fork no longer makes, quoted with its address, unless a rule masks it.
    expect(JSON.stringify(both.responses[`runs/${forkId}/differences`])).toContain('team@example.com');
    const rules = [{ pattern: 'email', replace: '<EMAIL>' }];
    const redacted = JSON.stringify(embedded(exportHtml({ store, runIds: [forkId, runId], uiDir, redact: rules }).html).responses[`runs/${forkId}/differences`]);
    expect(redacted).not.toContain('team@example.com');
    expect(redacted).toContain('<EMAIL>');
  });

  it('holds Show diff’s request for each run that diverged: whole with the run it is compared with, else its changes alone', () => {
    const { fork, parent } = divergedPair();
    const both = embedded(exportHtml({ store, runIds: [fork, parent], uiDir }).html);
    expect(both.responses[`runs/${fork}/diff`]).toEqual(JSON.parse(JSON.stringify({ diff: requestDiff(store, store.getRun(fork)!, null, [], new Set([fork, parent])) })));
    expect(both.responses[`runs/${fork}/diff`]).toMatchObject({ diff: { at: 1, whole: true, against: { runId: parent, callNo: 1 }, path: '$.messages[0].content' } });
    // A recording never diverged: nothing held for it.
    expect(both.responses[`runs/${parent}/diff`]).toBeUndefined();
    // Without the run it is compared with, the divergence's own changes, as the file holds them anyway,
    // as far as the diff needs them: the model this run asked, the change, the conversation left out.
    const alone = embedded(exportHtml({ store, runIds: [fork], uiDir }).html).responses[`runs/${fork}/diff`] as { diff: { whole: boolean; was: unknown; now: unknown } };
    const model = 'claude-sonnet-4-5';
    expect(alone.diff).toMatchObject({ whole: false, was: { model, 'messages[0]': { content: ASKED } }, now: { model, 'messages[0]': { content: ASKED.replace('1042', '1043') } }, leftOut: ['messages'] });
  });

  it('redacts Show diff’s request as the runs are: neither a secret nor a value a rule masks reaches the file in any form', () => {
    const { fork, parent } = divergedPair();
    const rules = [
      { pattern: 'email', replace: '<EMAIL>' },
      { pattern: '/sk-test-[A-Za-z0-9]+/', replace: '<KEY>' },
    ];
    for (const runIds of [[fork, parent], [fork]]) {
      const { html } = exportHtml({ store, runIds, uiDir, redact: rules });
      for (const value of [SECRET, EMAIL]) {
        for (const form of [value, encodeURIComponent(value), Buffer.from(value).toString('base64'), JSON.stringify(value).slice(1, -1)]) expect(html, `${runIds.length} runs: ${form}`).not.toContain(form);
      }
      const diff = JSON.stringify(embedded(html).responses[`runs/${fork}/diff`]);
      expect(diff).toContain('<EMAIL>');
      expect(diff).toContain('<KEY>');
    }
  });

  it('keeps a copy of many runs that diverged within what their requests weigh', () => {
    const forks = Array.from({ length: 6 }, () => divergedPair().fork);
    const data = embedded(exportHtml({ store, runIds: forks, uiDir }).html);
    for (const fork of forks) {
      const request = JSON.stringify(data.responses[`runs/${fork}/calls/1`]);
      // Its two bodies and the words beside them, never more than the call's own details again and a little.
      expect(JSON.stringify(data.responses[`runs/${fork}/diff`]).length).toBeLessThan(request.length + 2048);
    }
  });

  it('says apart in Show diff’s request what the rules matching applies mask, as the dashboard’s own read does', () => {
    const rule = { kind: 'api' as const, path: '$.metadata.user_id', pattern: 'uuid', replace: '<UUID>' };
    const [a, b] = ['3f1c9a2e-5b7d-4e8a-9c1f-2a6b8d0e4f13', '9b2e4d6f-1a3c-4b5d-8e7f-0c2a4e6b8d10'];
    const body = (user: string, asked: string) => ({ model: 'claude-sonnet-4-5', metadata: { user_id: user }, messages: [{ role: 'user', content: asked }] });
    const parent = addRun(store, { startedAt: Date.UTC(2026, 10, 3, 9), calls: [{ code: 'l', request: body(a, 'Refund order 1042') }] });
    const fork = addRun(store, { parent, startedAt: Date.UTC(2026, 10, 3, 10), calls: [{ code: 'l', request: body(b, 'Refund order 1043') }] });
    const diff = [
      { path: '$.metadata.user_id', op: 'changed' as const, before: a, after: b },
      { path: '$.messages[0].content', op: 'changed' as const, before: 'Refund order 1042', after: 'Refund order 1043' },
    ];
    store.setDivergence(fork, { type: 'request_changed', callNo: 1, kind: 'api', name: 'POST /v1/messages', replayedBefore: 0, counterpart: { runId: parent, callNo: 1 }, diff });
    const held = embedded(exportHtml({ store, runIds: [fork, parent], uiDir, normalize: [rule] }).html).responses[`runs/${fork}/diff`] as { diff: { masked: string[]; paths: Array<{ path: string; fix: unknown }> } };
    expect(held.diff.masked).toEqual(['$.metadata.user_id']);
    expect(held.diff.paths).toEqual([{ path: '$.messages[0].content', what: 'user message', fix: null }]);
    expect(held).toEqual(JSON.parse(JSON.stringify({ diff: requestDiff(store, store.getRun(fork)!, null, [rule], new Set([fork, parent])) })));
    // Without the rules, the value made anew is a change of its own, with the normalizer that masks it.
    const bare = embedded(exportHtml({ store, runIds: [fork, parent], uiDir }).html).responses[`runs/${fork}/diff`] as typeof held;
    expect(bare.diff.masked).toEqual([]);
    expect(bare.diff.paths.map((p) => p.path)).toEqual(['$.metadata.user_id', '$.messages[0].content']);
  });

  it('compares its runs after the rules matching applies, Compare and a fork’s differences alike, as the dashboard does', () => {
    // A recording and its fork that each opened a ticket, its id the one thing between them.
    const ticket = (id: string, parent: string | null) => {
      const r = store.createRun({ mode: parent ? 'replay' : 'record', ...(parent ? { parentRunId: parent } : {}), command: { argv: ['node', 'agent.mjs'], cwd: '.' }, startedAt: Date.UTC(2026, 10, 4, parent ? 10 : 9) });
      const identity = { kind: 'tool' as const, name: 'create_ticket', fingerprint: `ticket ${id}`, occurrence: 1 };
      store.appendCallStart({ runId: r.runId, callNo: 1, ...identity, origin: 'live', effect: 'write', requestRef: store.putJson({ args: { id } }), meta: {}, at: 1 });
      store.appendCallEnd(identity, { runId: r.runId, callNo: 1, attempt: 0, responseRef: store.putJson({ result: { ok: true } }), outcome: 'ok', meta: {}, at: 2 });
      if (parent) store.setDivergence(r.runId, { type: 'request_changed', callNo: 1, kind: 'tool', name: 'create_ticket', replayedBefore: 0 });
      store.endRun(r.runId, 'completed');
      return r.runId;
    };
    const parent = ticket('T-1', null);
    const fork = ticket('T-2', parent);
    const held = (normalize?: Array<{ kind: 'tool'; path: string; replace: string }>) => {
      const r = embedded(exportHtml({ store, runIds: [fork, parent], uiDir, ...(normalize ? { normalize } : {}) }).html).responses;
      const pair = r[`compare?a=${parent}&b=${fork}`] as { pair: { verdict: { words: string } } };
      const differences = r[`runs/${fork}/differences`] as { differences: { rank: number | null } };
      return [pair.pair.verdict.words, differences.differences.rank];
    };
    expect(held()).toEqual(['Different writes', 1]);
    expect(held([{ kind: 'tool', path: '$.args.id', replace: '<id>' }])).toEqual(['The same decisions', null]);
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
      const parent = unpackRun(own, GOLDEN).imported[0];
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

  it('compares each run of a copy of more than six with the first only, and opens on a pair it holds', () => {
    const own = Store.open(':memory:');
    try {
      // A lineage of seven, root first, as the dashboard's download of a run's lineage orders it.
      const root = unpackRun(own, GOLDEN).imported[0];
      const ids = [root];
      for (let i = 1; i < 7; i++) {
        const r = own.createRun({ mode: 'replay', parentRunId: ids[i - 1], command: { argv: ['node', 'agent.js'], cwd: '.' }, startedAt: 2_000_000_000_000 + i });
        own.endRun(r.runId, 'completed');
        ids.push(r.runId);
      }
      const data = embedded(exportHtml({ store: own, runIds: withAncestors(own, ids.at(-1)!), uiDir }).html);
      expect(data.responses['meta']).toMatchObject({ compareWith: root });
      const pairs = Object.keys(data.responses).filter((k) => k.startsWith('compare?')).map((k) => new URLSearchParams(k.slice('compare?'.length)));
      // Each run with the first, both ways round, and nothing else.
      expect(pairs).toHaveLength(12);
      expect(pairs.every((q) => q.get('a') === root || q.get('b') === root)).toBe(true);
      // Compare opens on the first run against the newest other: a pair the file holds.
      const runs = (data.responses['runs'] as { runs: RunLike[] }).runs;
      const [a, b] = defaultComparePair(runs, root)!;
      expect([a, b]).toEqual([root, ids.at(-1)]);
      expect(data.responses[`compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`]).toBeDefined();
      // Without it, the newest fork and its parent: a pair the file doesn't hold.
      const [x, y] = defaultComparePair(runs)!;
      expect(data.responses[`compare?a=${encodeURIComponent(x)}&b=${encodeURIComponent(y)}`]).toBeUndefined();
      // Up to six runs, every pair.
      const six = embedded(exportHtml({ store: own, runIds: ids.slice(0, 6), uiDir }).html);
      expect(six.responses['meta']).toMatchObject({ compareWith: null });
      expect(Object.keys(six.responses).filter((k) => k.startsWith('compare?'))).toHaveLength(30);
      // Each pair holds what its second run decided differently from its first after the calls they
      // share, as the dashboard answers it: the verdict, both endings and the rows, at most 200.
      const answers = Object.entries(six.responses).filter(([k]) => k.startsWith('compare?')).map(([, v]) => v as { pair?: { verdict: unknown; rows: unknown[]; more: number } | null });
      expect(answers.every((c) => !!c.pair && c.pair.rows.length <= 200)).toBe(true);
      expect(answers.filter((c) => c.pair?.verdict).length).toBeGreaterThan(0);
    } finally {
      own.close();
    }
  });

  it('ends the data block where it should whatever the runs hold: an HTML head cut short in a model answer included', () => {
    const own = Store.open(':memory:');
    try {
      const parent = unpackRun(own, GOLDEN).imported[0];
      // A model answer that quotes a page's head and stops before the comment it opened is closed.
      const answers = ['Here is the page head:\n<html><head><!-- tag manager\n<script src="/t.js">', 'and <SCRIPT>, <!-- again, </script> and </SCRIPT >'];
      const run = own.createRun({ mode: 'record', command: { argv: ['node', 'agent.js', '<!-- <script'], cwd: '.' } });
      for (const [i, c] of own.getCalls(parent).slice(0, 2).entries()) {
        const { end, attempts, ...start } = c;
        void attempts;
        own.appendCallStart({ ...start, runId: run.runId });
        own.appendCallEnd(c, { ...end!, runId: run.runId, responseRef: own.putBlob(Buffer.from(JSON.stringify({ type: 'message', role: 'assistant', content: [{ type: 'text', text: answers[i] }] }))) });
      }
      own.endRun(run.runId, 'completed');
      const { html } = exportHtml({ store: own, runIds: [run.runId], uiDir });
      // A browser ends the block at its own end tag, so the app after it runs: before, it read on to the end of the file.
      const text = dataAsParsed(html);
      const data = JSON.parse(text) as StaticPayload;
      expect(data.runIds).toEqual([run.runId]);
      expect(html.slice(html.indexOf(text) + text.length)).toMatch(/^<\/script>\n<script type="module">/);
      // What the runs hold comes back as it was recorded.
      expect(JSON.stringify(data.responses)).toContain(JSON.stringify(answers[0]).slice(1, -1));
      expect(JSON.stringify(data.responses)).toContain(JSON.stringify(answers[1]).slice(1, -1));
      expect(text).not.toMatch(/<!--|<script|<\//i);
    } finally {
      own.close();
    }
  });

  it('lists a run with its ancestors, oldest first', () => {
    expect(withAncestors(store, forkId)).toEqual([runId, forkId]);
    expect(withAncestors(store, runId)).toEqual([runId]);
  });
});
