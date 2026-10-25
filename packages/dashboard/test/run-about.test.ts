import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { lineage, listRuns, runDetail } from '../src/api.js';
import { exportHtml, type StaticPayload } from '../src/index.js';
import { asksRead } from '../src/run-stats.js';
import { listRunsPage, type RunRow } from '../src/runs-list.js';
import { addRun, blameOf, capture, DAY, HOUR } from './read-model-store.js';

/**
 * A run is named by its id, with one quiet line that says what it was (decision 10): the server
 * works it out for every run it lists, its page and its family, the Runs filter matches it, and an
 * exported copy works it out from its own redacted copy of the runs, so it quotes nothing a rule
 * masks.
 */

const NOW = Date.UTC(2026, 9, 1, 10, 15);
const ASK = { system: 'You are a support agent.', messages: [{ role: 'user', content: 'A customer asks for a refund of order A-1131. They paid $40 and wrote from c-311@example.com.' }] };
/** The same conversation, one turn on: the agent's second model call. */
const ON = { ...ASK, messages: [...ASK.messages, { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'issue_refund', input: { order: 'A-1131' } }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'refunded' }] }] };

let dir: string;
let path: string;
let uiDir: string;
const id: Record<string, string> = {};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'shadowlap-about-'));
  path = join(dir, 'shadowlap.db');
  const store = Store.open(path);
  id.rec = addRun(store, { startedAt: NOW - DAY, argv: ['node', 'refund_agent.mjs', 'T-8812'], calls: [{ code: 'l', request: ASK }, { code: 'l', kind: 'tool' }, { code: 'l', request: ON }] });
  id.fork = addRun(store, { parent: id.rec, startedAt: NOW - 3 * HOUR, divergence: 3, calls: 'rrl', meta: { interventions: [{ kind: 'override', at: 2, flag: '--override 2=@policy.json' }, { kind: 'writes', at: null, flag: '--writes stub' }] } });
  id.clean = addRun(store, { parent: id.rec, startedAt: NOW - 2 * HOUR, calls: 'rrr' });
  id.test = addRun(store, { parent: id.rec, startedAt: NOW - HOUR, calls: 'rrr', meta: { test: { golden: 'goldens/refund-in-limit', session: 's-1' } } });
  id.capture = capture(store, NOW - 30 * 60_000, 'cap/2026-09-30.jsonl');
  store.close();
  uiDir = mkdtempSync(join(tmpdir(), 'shadowlap-about-ui-'));
  mkdirSync(join(uiDir, 'assets', 'fonts'), { recursive: true });
  writeFileSync(join(uiDir, 'assets', 'app.css'), '.app { color: red }\n');
  writeFileSync(join(uiDir, 'assets', 'app.js'), 'console.log(1);\n');
  writeFileSync(join(uiDir, 'assets', 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(uiDir, { recursive: true, force: true });
});

const open = <T>(read: (store: Store) => T): T => {
  const store = Store.open(path);
  try {
    return read(store);
  } finally {
    store.close();
  }
};

describe('a run’s about line, as the server serves it', () => {
  it('in /api/runs: what each run was, worked out from it, with where it comes from and a change apart', () => {
    const runs = open((s) => listRuns(s));
    const about = (runId: string) => runs.find((r) => r.runId === runId)!.about;
    // A recording: the first sentence of the first thing its user asked, with no full stop.
    expect(about(id.rec)).toEqual({ text: 'A customer asks for a refund of order A-1131', from: 'user' });
    // A fork: what it changed, the call it changed with #, its flag and fork point apart; never the fence.
    expect(about(id.fork)).toEqual({ text: 'override #2', from: 'change', change: { flag: '--override', callNo: 2, forkAt: 3 } });
    expect(about(id.clean)).toEqual({ text: 'clean replay', from: 'nothing', change: null });
    // A test replay: its golden, by its name.
    expect(about(id.test)).toEqual({ text: 'refund-in-limit', from: 'golden' });
    // An import: its source, the file by its name alone.
    expect(about(id.capture)).toEqual({ text: '2026-09-30.jsonl', from: 'source' });
  });

  it('on the run’s page and in its family, the same line', () => {
    expect(open((s) => runDetail(s, id.fork))!.about).toEqual({ text: 'override #2', from: 'change', change: { flag: '--override', callNo: 2, forkAt: 3 } });
    expect(open((s) => runDetail(s, id.rec))!.about?.text).toBe('A customer asks for a refund of order A-1131');
    const family = open((s) => lineage(s, id.test))!;
    expect(family.map((n) => [n.runId, n.about?.text])).toEqual([
      [id.rec, 'A customer asks for a refund of order A-1131'],
      [id.fork, 'override #2'],
      [id.clean, 'clean replay'],
      [id.test, 'refund-in-limit'],
    ]);
  });

  it('is what Runs’ filter matches, besides the id, command, labels and revision', () => {
    const found = (q: string) => open((s) => listRunsPage(s, { q })).runs.map((r) => r.runId);
    // The golden's name is only in the test replay's about line.
    expect(found('refund-in-limit')).toEqual([id.test]);
    // The order is only in what the recording's user asked: no command or label names it.
    expect(found('A-1131')).toEqual([id.rec]);
    expect(found('override')).toEqual([id.fork]);
    expect(found('A-1131 nothing-like-it')).toEqual([]);
  });

  it('numbers an attempt as its banner does: the fork blame rescued its run with is one of its probe’s attempts', () => {
    // A store of its own, so the lists above keep the runs they name.
    const store = Store.open(join(dir, 'attempts.db'));
    try {
      const lost = addRun(store, { startedAt: NOW - 6 * HOUR, argv: ['node', 'agent.mjs', 'A-1042'], status: 'failed', calls: 'llllll' });
      // Blame asked the model #5 again four times; the second attempt passed, and rescued the run.
      const probe = [1, 2, 3, 4].map((n) => addRun(store, { parent: lost, startedAt: NOW - 5 * HOUR + n * 60_000, divergence: 5, calls: 'rrrrll', meta: { probe: { of: lost, callNo: 5, passed: n === 2 }, repeat: { group: 'b1-5', attempt: n, of: 4 } } }));
      store.updateRunMeta(lost, { blame: blameOf(5, probe[1], NOW - 4 * HOUR) });
      const shown = (runId: string) => {
        const d = runDetail(store, runId)!;
        return [d.about?.text, d.attemptPlace && `${d.attemptPlace.k} of ${d.attemptPlace.n}`];
      };
      expect(probe.map(shown)).toEqual([
        ['resampled #5, attempt 1', '1 of 4'],
        // It shows as a fork of its own, and says what it rescued.
        ['rescued #5', '2 of 4'],
        // The attempts after it count it, as their banners do.
        ['resampled #5, attempt 3', '3 of 4'],
        ['resampled #5, attempt 4', '4 of 4'],
      ]);
      expect(lineage(store, lost)!.filter((n) => n.runId !== lost).map((n) => n.about?.text)).toEqual(['resampled #5, attempt 1', 'rescued #5', 'resampled #5, attempt 3', 'resampled #5, attempt 4']);

      // A run verified twice: each verify's attempts are numbered within it, as its bundle and banners number them.
      const good = addRun(store, { startedAt: NOW - 3 * HOUR, argv: ['node', 'agent.mjs', 'A-1120'], calls: 'll' });
      const verify = (group: string, of: number, from: number) => Array.from({ length: of }, (_, i) => addRun(store, { parent: good, startedAt: from + i * 60_000, calls: 'rl', meta: { verify: { role: 'good', passed: true }, repeat: { group, attempt: i + 1, of } } }));
      verify(`v1-${good}`, 2, NOW - 2 * HOUR);
      const again = verify(`v2-${good}`, 3, NOW - HOUR);
      expect(again.map(shown)).toEqual([
        ['verify · good, attempt 1', '1 of 3'],
        ['verify · good, attempt 2', '2 of 3'],
        ['verify · good, attempt 3', '3 of 3'],
      ]);
    } finally {
      store.close();
    }
  });

  it('is kept with a finished run’s totals: a dashboard opened again reads no request for it', () => {
    open((s) => listRuns(s));
    const again = open((s) => {
      listRuns(s);
      listRunsPage(s, { q: 'A-1131' });
      return asksRead(s);
    });
    expect(again).toBe(0);
  });
});

describe('the about line in a copy that leaves the store', () => {
  it('quotes the redacted copy: a rule masks what the user asked in the list, the run’s page and its family', () => {
    const result = open((s) => exportHtml({ store: s, runIds: [id.rec, id.fork], uiDir, now: NOW, redact: [{ pattern: '/order A-\\d+/', replace: 'order <ORDER>' }] }));
    const m = /<script type="application\/json" id="shadowlap-data">(.*?)<\/script>/s.exec(result.html)!;
    const data = JSON.parse(m[1].split('<\\/').join('</')) as StaticPayload;
    const listed = (data.responses['runs'] as { runs: RunRow[] }).runs;
    expect(listed.find((r) => r.runId === id.rec)!.about).toEqual({ text: 'A customer asks for a refund of order <ORDER>', from: 'user' });
    expect((data.responses[`runs/${id.rec}`] as { about: { text: string } }).about.text).toBe('A customer asks for a refund of order <ORDER>');
    expect((data.responses[`runs/${id.fork}/lineage`] as { nodes: Array<{ runId: string; about: { text: string } | null }> }).nodes.map((n) => n.about?.text)).toEqual(['A customer asks for a refund of order <ORDER>', 'override #2']);
    expect(result.html).not.toContain('order A-1131');
  });

  it('quotes a replay’s flag as the copy masks it: a --set value a rule matches is masked in the about line and the banner’s flags', () => {
    const forked = open((s) => addRun(s, { parent: id.rec, startedAt: NOW - 10 * 60_000, divergence: 3, calls: 'rrl', meta: { interventions: [{ kind: 'set', at: 3, flag: '--set metadata.user=c-311@example.com', args: ['--set', 'metadata.user=c-311@example.com'] }] } }));
    // As recorded, the line quotes the value it set.
    expect(open((s) => listRuns(s)).find((r) => r.runId === forked)!.about).toMatchObject({ text: 'metadata.user=c-311@example.com #3', from: 'change' });
    const result = open((s) => exportHtml({ store: s, runIds: [id.rec, forked], uiDir, now: NOW, redact: [{ pattern: 'email', replace: '<EMAIL>' }] }));
    const m = /<script type="application\/json" id="shadowlap-data">(.*?)<\/script>/s.exec(result.html)!;
    const data = JSON.parse(m[1].split('<\\/').join('</')) as StaticPayload;
    expect((data.responses['runs'] as { runs: RunRow[] }).runs.find((r) => r.runId === forked)!.about.text).toBe('metadata.user=<EMAIL> #3');
    const detail = data.responses[`runs/${forked}`] as { about: { text: string }; interventions: Array<{ flag: string; value?: string }> };
    expect(detail.about.text).toBe('metadata.user=<EMAIL> #3');
    expect(result.html).not.toContain('c-311@example.com');
  });

  it('without rules, quotes the run as recorded, as the rest of the copy does', () => {
    const result = open((s) => exportHtml({ store: s, runIds: [id.rec], uiDir, now: NOW }));
    expect(result.html).toContain('A customer asks for a refund of order A-1131');
  });
});
