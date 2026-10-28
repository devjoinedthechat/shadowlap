import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Store, unpackRun } from '@shadowlap/engine';
import { App } from '../src/app.js';
import { renderAt } from './terminal.js';

const GOLDEN = fileURLToPath(new URL('../../../testing/golden/reference-agent/', import.meta.url));
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const plain = (frame: string | undefined) => (frame ?? '').replace(/\x1b\[[0-9;]*m/g, '');

/** Waits for a frame `ok` accepts, then returns it (or the last one seen, for the assertion to show). */
async function frameWhere(lastFrame: () => string | undefined, ok: (frame: string) => boolean, timeoutMs = 5000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let frame = plain(lastFrame());
  while (!ok(frame) && Date.now() < deadline) {
    await tick();
    frame = plain(lastFrame());
  }
  return frame;
}

/** A recording, a clean replay of it, a fork that changed its request at #3 with labels and a failed check, and a fix of the fork. */
function store(): { store: Store; recording: string; fork: string } {
  const s = Store.open(':memory:');
  const recording = unpackRun(s, GOLDEN).imported[0];
  s.updateRunMeta(recording, { labels: ['baseline'] });
  const parent = s.getCalls(recording);
  const copy = (runId: string, liveFrom?: number) => {
    for (const c of parent) {
      const { end, attempts, ...start } = c;
      void attempts;
      s.appendCallStart({ ...start, runId, origin: liveFrom && c.callNo >= liveFrom ? 'live' : 'replayed' });
      if (end) s.appendCallEnd(c, { ...end, runId });
    }
  };
  const replay = s.createRun({ mode: 'replay', parentRunId: recording, command: { argv: ['node', 'agent.js'], cwd: '.' } });
  copy(replay.runId);
  s.endRun(replay.runId, 'completed');
  const fork = s.createRun({ mode: 'replay', parentRunId: recording, command: { argv: ['node', 'agent.js', '--system-suffix', 'Be brief.'], cwd: '.' } });
  copy(fork.runId, 3);
  s.setDivergence(fork.runId, {
    type: 'request_changed',
    callNo: 3,
    kind: 'api',
    name: 'POST /v1/messages',
    replayedBefore: 2,
    counterpart: { runId: recording, callNo: 3 },
    diff: [{ path: '$.system', op: 'changed', before: 'Today is 2026-09-15.', after: 'Today is 2026-09-16. Be brief.' }],
  });
  s.updateRunMeta(fork.runId, { labels: ['be-brief'], checks: [{ ok: true, label: 'answers', detail: null }, { ok: false, label: 'under 200 words', detail: '231 words' }] });
  s.endRun(fork.runId, 'completed');
  const fix = s.createRun({ mode: 'replay', parentRunId: fork.runId, command: { argv: ['node', 'agent.js'], cwd: '.' } });
  copy(fix.runId, 3);
  s.setDivergence(fix.runId, { type: 'forced', callNo: 3, kind: 'api', name: 'POST /v1/messages', replayedBefore: 2, reason: 'forced live by --diverge-at 3' });
  s.updateRunMeta(fix.runId, { labels: ['fix: max_tokens'], checks: [{ ok: true, label: 'answers', detail: null }, { ok: true, label: 'under 200 words', detail: null }] });
  s.endRun(fix.runId, 'completed');
  return { store: s, recording, fork: fork.runId };
}

/** Every line of a frame fits the terminal, and the frame is exactly as tall as the terminal. */
function expectFits(frame: string, columns: number, rows: number, what: string) {
  const lines = frame.split('\n');
  expect(lines, `${what}: rows`).toHaveLength(rows);
  for (const l of lines) expect(l.length, `${what}: "${l}"`).toBeLessThanOrEqual(columns);
}

const SIZES: Array<[number, number]> = [
  [60, 12],
  [80, 24],
  [120, 40],
];

describe('every screen at 60×12, 80×24 and 120×40', () => {
  for (const [columns, rows] of SIZES) {
    it(`fits the runs, their help, filter and delete at ${columns}×${rows}, the selection always marked`, async () => {
      const { store: s } = store();
      const { lastFrame, stdin, unmount } = renderAt(<App store={s} columns={columns} rows={rows} />, columns, rows);
      let frame = await frameWhere(lastFrame, (f) => f.includes('4 runs'));
      expectFits(frame, columns, rows, 'runs');
      // The selected run keeps its marker however narrow the terminal: at 80 columns it once lost it.
      expect(frame.split('\n').filter((l) => l.startsWith('>'))).toHaveLength(1);
      // The two forks can be told apart: their check results stay when other columns go.
      expect(frame).toContain('✗ 1/2');
      expect(frame).toContain('✓ 2/2');

      stdin.write('?');
      frame = await frameWhere(lastFrame, (f) => f.includes('Keys'));
      expectFits(frame, columns, rows, 'runs help');
      // Nothing painted over: the closing line is there, and every key, or a way to scroll to the rest.
      expect(frame).toMatch(/any key closes|j\/k scroll/);
      if (rows >= 24) expect(frame).toContain('esc  q');
      stdin.write('x'); // closes the help
      await frameWhere(lastFrame, (f) => !f.includes('Keys'));

      stdin.write('x');
      frame = await frameWhere(lastFrame, (f) => / y \/ n$/m.test(f));
      expectFits(frame, columns, rows, 'delete');
      expect(frame.split('\n').at(-1)).toMatch(/^ delete .*\? .*y \/ n$/);
      stdin.write('n');
      await frameWhere(lastFrame, (f) => !/ y \/ n$/m.test(f));

      stdin.write('/');
      await frameWhere(lastFrame, (f) => f.includes('filter runs:'));
      stdin.write('agent');
      frame = await frameWhere(lastFrame, (f) => f.includes('filter runs: agent'));
      expectFits(frame, columns, rows, 'filter');
      expect(frame.split('\n').at(-1)).toMatch(/^ filter runs: agent/);
      unmount();
      s.close();
    });

    it(`fits a fork's timeline, its help, fork menu and zoom at ${columns}×${rows}`, async () => {
      const { store: s, fork } = store();
      const { lastFrame, stdin, unmount } = renderAt(<App store={s} runId={fork} columns={columns} rows={rows} />, columns, rows);
      let frame = await frameWhere(lastFrame, (f) => f.includes('Diverged at call 3'));
      expectFits(frame, columns, rows, 'timeline');
      expect(frame).toMatch(/│> #3\s/);
      expect(frame).toContain('── forked at #3');

      stdin.write('?');
      frame = await frameWhere(lastFrame, (f) => f.includes('Keys'));
      expectFits(frame, columns, rows, 'timeline help');
      expect(frame).toMatch(/any key closes|j\/k scroll/);
      if (rows >= 24) expect(frame).toContain('back to the runs');
      stdin.write('x');
      await frameWhere(lastFrame, (f) => !f.includes('Keys'));

      stdin.write(':');
      frame = await frameWhere(lastFrame, (f) => f.includes('Fork menu'));
      expectFits(frame, columns, rows, 'fork menu');
      expect(frame).toMatch(/> i\s+Inject/);
      expect(frame).toContain('Esc to close');
      stdin.write('\x1b');
      await frameWhere(lastFrame, (f) => !f.includes('Fork menu'));

      stdin.write('z');
      frame = await frameWhere(lastFrame, (f) => f.includes('z unzoom'));
      expectFits(frame, columns, rows, 'zoom');
      expect(frame).not.toMatch(/#4\s+tool/); // the calls give their room to the inspector
      stdin.write('\x1b');
      frame = await frameWhere(lastFrame, (f) => /#4\s+tool/.test(f));
      expect(frame).toMatch(/#4\s+tool/);
      unmount();
      s.close();
    });
  }

  it('says how to start on a first launch, at every size', async () => {
    for (const [columns, rows] of SIZES) {
      const s = Store.open(':memory:');
      const { lastFrame, unmount } = renderAt(<App store={s} columns={columns} rows={rows} />, columns, rows);
      const frame = await frameWhere(lastFrame, (f) => f.includes('shadowlap run --'));
      expectFits(frame, columns, rows, 'first launch');
      expect(frame).toContain('shadowlap demo');
      // Only the keys that do something with no runs.
      expect(frame.split('\n').at(-1)).toBe(' ? help  q quit');
      unmount();
      s.close();
    }
  });
});

describe('the timeline', () => {
  it('opens a model call on the turns its request added, and says they are new', async () => {
    const { store: s, recording } = store();
    const { lastFrame, unmount } = renderAt(<App store={s} runId={recording} callNo={9} columns={120} rows={32} />, 120, 32);
    const frame = await frameWhere(lastFrame, (f) => f.includes('· new'));
    const lines = frame.split('\n');
    const tabs = lines.findIndex((l) => l.includes('conversation  request'));
    // The first line under the tabs is the first turn #9 sent that #6 hadn't.
    expect(lines[tabs + 1]).toMatch(/assistant {2}#4 · new/);
    expect(frame).toMatch(/tool {2}#5 · new/);
    unmount();
    s.close();
  });

  it('filters as you type, and Esc puts back what was there', async () => {
    const { store: s, fork } = store();
    const { lastFrame, stdin, unmount } = renderAt(<App store={s} runId={fork} columns={100} rows={30} />, 100, 30);
    await frameWhere(lastFrame, (f) => f.includes('Diverged at call 3'));
    stdin.write('/');
    await frameWhere(lastFrame, (f) => f.includes('filter calls:'));
    stdin.write('send_e');
    let frame = await frameWhere(lastFrame, (f) => f.includes('filter calls: send_e') && !/tool\s+search_web/.test(f));
    expect(frame).toMatch(/tool\s+send_email/);
    expect(frame).not.toMatch(/tool\s+search_web/);
    stdin.write('\x1b');
    frame = await frameWhere(lastFrame, (f) => /tool\s+search_web/.test(f));
    expect(frame).toMatch(/tool\s+search_web/);
    expect(frame).not.toContain('filter:');
    unmount();
    s.close();
  });

  it('dims the calls replayed before the fork and names model calls by what they did', async () => {
    const { store: s, fork } = store();
    const { lastFrame, unmount } = renderAt(<App store={s} runId={fork} columns={120} rows={40} />, 120, 40);
    const frame = await frameWhere(lastFrame, (f) => f.includes('Diverged at call 3'));
    expect(frame).toMatch(/#3\s+model\s+-> search_web, read_file\s+live\s+ok/);
    expect(frame).toMatch(/#28\s+model\s+-> send_email/);
    unmount();
    s.close();
  });
});
