import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Store, unpackRun, type CallRecord } from '@shadowlap/engine';
import { App } from '../src/app.js';
import { attemptsText } from '../src/attempts.js';
import { forkEffects } from '../src/fork-effects.js';
import { marked, markToast } from '../src/marks.js';
import { failedCheckText, unrecordedConsequence, unrecordedName, verdictOf } from '../src/verdict.js';
import { renderAt } from './terminal.js';

const GOLDEN = fileURLToPath(new URL('../../../testing/golden/reference-agent/', import.meta.url));
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const plain = (frame: string | undefined) => (frame ?? '').replace(/\x1b\[[0-9;]*m/g, '');

async function frameWhere(lastFrame: () => string | undefined, ok: (frame: string) => boolean, timeoutMs = 5000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let frame = plain(lastFrame());
  while (!ok(frame) && Date.now() < deadline) {
    await tick();
    frame = plain(lastFrame());
  }
  return frame;
}

const FIX = 'fx-01M61QZ7Y3E8';

/**
 * A failure as Shadowlap works one through: a recording that failed its check, which blame found
 * lost at #9 and a verified fix took care of; five `replay --repeat` attempts of it, one failed; and
 * a fork from #9 whose email was fenced and which searched for something else.
 */
function story(options: { dropEmail?: boolean } = {}) {
  const s = Store.open(':memory:');
  const rec = unpackRun(s, GOLDEN).imported[0];
  const parent = s.getCalls(rec);
  s.updateRunMeta(rec, {
    labels: ['refund'],
    checks: [
      { status: 'failed', ok: false, label: 'send_email called 1 time', detail: 'called 2 times (2 blocked)' },
      { status: 'passed', ok: true, label: 'answers in under 200 words', detail: null },
    ],
    blame: { at: Date.now(), outcome: 'blamed', callNo: 9, confidence: 'high', range: { from: 9, to: 9 }, rescuedRunId: null, fields: [], oracle: [], probes: [], spent: 0 },
  } as never);
  s.insertFix({ fixId: FIX, title: 'Ask before emailing the customer twice', labels: ['refund'], check: { expect: null, key: 'check:exit', oracle: [], text: 'exit 0' }, status: 'verified', openedAt: Date.now(), verifiedAt: Date.now(), appliedAt: null, data: {} });
  s.addFixLink(FIX, 'failing', rec);
  const copy = (runId: string, change: (c: CallRecord) => Partial<CallRecord> | null = () => ({})) => {
    for (const c of parent) {
      const patch = change(c);
      if (!patch) continue;
      const { end, attempts, ...start } = c;
      void attempts;
      s.appendCallStart({ ...start, origin: 'replayed', ...patch, runId });
      if (end) s.appendCallEnd(c, { ...end, runId });
    }
  };
  for (let i = 1; i <= 5; i++) {
    const a = s.createRun({ mode: 'replay', parentRunId: rec, command: { argv: ['node', 'agent.js'], cwd: '.' }, meta: { repeat: { group: 'g', attempt: i, of: 5 }, checks: [{ status: i === 3 ? 'failed' : 'passed', ok: i !== 3, label: 'send_email called 1 time', detail: null }] } });
    copy(a.runId);
    s.endRun(a.runId, 'completed');
  }
  const fork = s.createRun({ mode: 'replay', parentRunId: rec, command: { argv: ['node', 'agent.js'], cwd: '.' } });
  const search = parent.find((c) => c.callNo > 9 && c.kind === 'tool' && c.name === 'search_web')!;
  copy(fork.runId, (c) => {
    if (c.callNo < 9) return {};
    if (c.kind === 'tool' && c.name === 'send_email') return options.dropEmail ? null : { origin: 'blocked' };
    if (c.callNo === search.callNo) return { origin: 'live', requestRef: s.putJson({ args: { query: 'refund policy EU limit' } }) };
    return { origin: 'live' };
  });
  s.setDivergence(fork.runId, { type: 'request_changed', callNo: 9, kind: 'api', name: 'POST /v1/messages', replayedBefore: 8, diff: [{ path: '$.system', op: 'changed', before: 'a', after: 'b' }] });
  s.updateRunMeta(fork.runId, { checks: [{ status: 'passed', ok: true, label: 'send_email called 1 time', detail: null }] });
  s.endRun(fork.runId, 'completed');
  return { s, rec, fork: fork.runId };
}

describe('how a run stands, in the terminal', () => {
  it('opens a failed run where blame found it lost, on why it failed, with its fix', async () => {
    const { s, rec } = story();
    const { lastFrame, stdin, unmount } = renderAt(<App store={s} runId={rec} columns={120} rows={40} />, 120, 40);
    const frame = await frameWhere(lastFrame, (f) => f.includes('How this run stands'));
    const lines = frame.split('\n');
    // The verdict line under the header, and the list's line before the call blame named.
    expect(lines[1]).toContain('✗ check failed: send_email called 1 time, but called 2 times (2 blocked) · lost at model call #9 (high confidence)');
    const at = lines.findIndex((l) => /> #9\s/.test(l));
    expect(lines[at - 1]).toContain('── lost here · blame, high confidence');
    // The run tab, whole: z widens it.
    stdin.write('z');
    const tab = await frameWhere(lastFrame, (f) => f.includes('z unzoom') && f.includes('Attempts'));
    expect(tab).toContain('fixed: “Ask before emailing the customer twice”, verified');
    expect(tab).toContain(`${FIX} “Ask before emailing the customer twice”: verified`);
    expect(tab).toContain('5 attempts, 4 passed');
    stdin.write('z');
    await frameWhere(lastFrame, (f) => f.includes('z zoom'));
    // b goes back to that call from anywhere.
    stdin.write('g');
    await frameWhere(lastFrame, (f) => /> #1\s/.test(f));
    stdin.write('b');
    expect(await frameWhere(lastFrame, (f) => /> #9\s/.test(f))).toMatch(/> #9\s/);
    unmount();
    s.close();
  });

  it('folds attempts under their run with how many passed, shows where blame lost it, and a unfolds them', async () => {
    const { s } = story();
    const { lastFrame, stdin, unmount } = renderAt(<App store={s} columns={140} rows={30} />, 140, 30);
    let frame = await frameWhere(lastFrame, (f) => f.includes('2 runs'));
    expect(frame).toMatch(/recording\s+✗ 1\/2\s+lost at #9\s+refund\s+5 attempts, 4 passed/);
    stdin.write('a');
    frame = await frameWhere(lastFrame, (f) => f.includes('7 runs'));
    expect(frame.split('\n').filter((l) => l.includes('clean replay'))).toHaveLength(5);
    unmount();
    s.close();
  });

  it('marks a run good or bad with + and -, never both, as the dashboard does', async () => {
    const { s, rec } = story();
    const { lastFrame, stdin, unmount } = renderAt(<App store={s} columns={120} rows={30} />, 120, 30);
    await frameWhere(lastFrame, (f) => f.includes('2 runs'));
    stdin.write('g');
    await frameWhere(lastFrame, (f) => /^> 01/m.test(f));
    stdin.write('+');
    await frameWhere(lastFrame, (f) => f.includes('is good: a fix must not make it worse'));
    expect(s.getRun(rec)!.meta?.labels).toEqual(['refund', 'good']);
    stdin.write('-');
    await frameWhere(lastFrame, (f) => f.includes('is bad: one to fix'));
    expect(s.getRun(rec)!.meta?.labels).toEqual(['refund', 'bad']);
    stdin.write('-');
    await frameWhere(lastFrame, (f) => f.includes('is no longer marked bad'));
    expect(s.getRun(rec)!.meta?.labels).toEqual(['refund']);
    unmount();
    s.close();
  });

  it('says what a fork did differently: a write fenced, a read asked otherwise, and that it no longer fails', async () => {
    const { s, fork } = story();
    const run = s.getRun(fork)!;
    const fx = forkEffects(s, run, s.getCalls(fork))!;
    expect(fx.most).toBe('a write changed');
    expect(fx.changes.map((c) => c.text)).toEqual([
      '~ send_email is fenced, where its parent\'s ran',
      'it does not fail, where its parent did',
      '~ search_web asked differently: {"query":"agent determinism"} → {"query":"refund policy EU limit"}',
    ]);
    expect(fx.ends).toEqual({ parent: 'failed, lost at #9', fork: '1 check passed' });
    // On the diff tab, under what changed at the fork.
    const { lastFrame, stdin, unmount } = renderAt(<App store={s} runId={fork} columns={120} rows={40} />, 120, 40);
    await frameWhere(lastFrame, (f) => f.includes('Diverged at call 9'));
    stdin.write('z');
    const frame = await frameWhere(lastFrame, (f) => f.includes('What the fork did differently'));
    expect(frame).toContain('~ send_email is fenced, where its parent\'s ran');
    expect(frame).toContain('parent  failed, lost at #9');
    unmount();
    s.close();
  });

  it('warns of a tool the model called that the run never recorded, in the words shadowlap show uses', () => {
    const { s, fork } = story({ dropEmail: true });
    const v = verdictOf(s, s.getRun(fork)!, s.getCalls(fork));
    expect(v.unrecorded.map((t) => t.name)).toEqual(['send_email']);
    expect(v.facts.map((f) => f.text)).toContain('not recorded: send_email');
    expect(unrecordedName({ ...v.unrecorded[0], count: 2, firstCallNo: 28, effect: 'write' })).toBe('send_email (2 calls from #28, writes)');
    expect(unrecordedConsequence([{ ...v.unrecorded[0], effect: 'write' }])).toBe('a replay runs it for real, and refuses to while one writes');
    expect(unrecordedConsequence([{ ...v.unrecorded[0], effect: 'read' }])).toBe('a replay runs it for real');
    s.close();
  });

  it('words a check, an attempt bundle and a mark as the dashboard does', () => {
    expect(failedCheckText({ ok: false, label: 'send_email called 1 time', detail: 'called 2 times (2 blocked)' })).toBe('check failed: send_email called 1 time, but called 2 times (2 blocked)');
    expect(attemptsText({ kind: 'repeat', count: 5, passed: 4 })).toBe('5 attempts, 4 passed');
    expect(attemptsText({ kind: 'probe', count: 1, passed: 0 })).toBe('1 probe, 0 passed');
    expect(marked(['refund', 'bad'], 'good')).toEqual({ labels: ['refund', 'good'], on: true });
    expect(marked(['refund', 'good'], 'good')).toEqual({ labels: ['refund'], on: false });
    expect(markToast('01M5GRX8K4ABCDEF', 'good', true)).toBe('01M5GRX8K4 is good: a fix must not make it worse than its own baseline (--keeps label:good)');
  });
});
