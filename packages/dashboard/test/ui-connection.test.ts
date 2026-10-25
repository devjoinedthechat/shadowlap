import { Store } from '@shadowlap/engine';
import { describe, expect, it } from 'vitest';
import { changesView } from '../src/changes.js';
import { connStart, connStep, feedCursor, onTick, reloadFor, secondsLeft, type ConnState } from '../ui/connection.js';
import { sameRun } from '../ui/format.js';
import { addRun } from './read-model-store.js';
import { afterPollError, jobStatus } from '../ui/jobs.js';
import { endedRecordings, followNewest, recordingEnded, recordingToast, type ListedRun } from '../ui/live.js';

describe('the connection to the dashboard server', () => {
  it('goes offline when nothing answers, and counts down 5, 10, 20, then 30 seconds between tries', () => {
    let s = connStep(connStart(null), { type: 'unreachable', now: 0 });
    expect(s).toEqual({ conn: 'offline', attempt: 0, retryAt: 5_000, preview: false });
    expect(secondsLeft(s, 1_200)).toBe(4);
    expect(onTick(s, 4_999, false)).toBe('wait');
    expect(onTick(s, 5_000, false)).toBe('try');
    expect(onTick(s, 5_000, true)).toBe('wait');
    const waits: number[] = [];
    let now = 5_000;
    for (let i = 0; i < 4; i++) {
      s = connStep(s, { type: 'retry-failed', now });
      waits.push((s.retryAt! - now) / 1000);
      now = s.retryAt!;
    }
    expect(waits).toEqual([10, 20, 30, 30]);
    // A clock a moment behind the deadline just set still counts down from the wait, not one more.
    const failed = connStep(connStep(connStart(null), { type: 'unreachable', now: 0 }), { type: 'retry-failed', now: 5_000 });
    expect(secondsLeft(failed, 4_800)).toBe(10);
  });

  it('comes back as it was before it went away, and a new outage starts the schedule again', () => {
    let s = connStep(connStart(null), { type: 'unreachable', now: 0 });
    s = connStep(s, { type: 'retry-failed', now: 5_000 });
    s = connStep(s, { type: 'reconnected' });
    expect(s).toEqual({ conn: 'ok', attempt: 0, retryAt: null, preview: false });
    expect(connStep(s, { type: 'unreachable', now: 100 }).retryAt).toBe(5_100);
    // Another failed request while offline does not restart the countdown.
    const off = connStep(s, { type: 'unreachable', now: 100 });
    expect(connStep(off, { type: 'unreachable', now: 3_000 })).toBe(off);
  });

  it('stops trying once the link expired', () => {
    const s = connStep(connStep(connStart(null), { type: 'unreachable', now: 0 }), { type: 'expired' });
    expect(s.conn).toBe('expired');
    expect(onTick(s, 60_000, false)).toBe('wait');
    expect(connStep(s, { type: 'unreachable', now: 1 })).toBe(s);
    expect(connStart('expired').conn).toBe('expired');
  });

  it('previews offline through the whole schedule without reconnecting, until Retry now', () => {
    let s: ConnState = connStart('offline');
    expect(s).toEqual({ conn: 'ok', attempt: 0, retryAt: null, preview: true });
    s = connStep(s, { type: 'unreachable', now: 0 });
    const seen: number[] = [secondsLeft(s, 0)];
    let now: number;
    for (let i = 0; i < 4; i++) {
      now = s.retryAt!;
      expect(onTick(s, now, false)).toBe('advance');
      s = connStep(s, { type: 'due', now });
      seen.push(secondsLeft(s, now));
    }
    expect(seen).toEqual([5, 10, 20, 30, 30]);
    expect(s.conn).toBe('offline');
    expect(connStep(s, { type: 'reconnected' })).toEqual({ conn: 'ok', attempt: 0, retryAt: null, preview: false });
  });

  it('reloads the runs when a run or a call changed, not for a job’s output', () => {
    expect(reloadFor({ changed: true, runs: false, calls: false }, true)).toBe(true);
    expect(reloadFor({ changed: true, runs: false, calls: true }, false)).toBe(true);
    expect(reloadFor({ changed: true, runs: false, calls: false }, false)).toBe(false);
    // A server that only says whether anything changed is taken at its word.
    expect(reloadFor({ changed: true }, false)).toBe(true);
    expect(reloadFor({ changed: false }, false)).toBe(false);
    expect(reloadFor({}, false)).toBe(true);
  });

  it('takes the feed’s cursor before the first load, so the first poll reloads only for what moved since', () => {
    const store = Store.open(':memory:');
    try {
      addRun(store, { startedAt: Date.UTC(2026, 9, 1), calls: 'll' });
      const feed = (since: string | null) => changesView(store, { boot: 'b1', jobsVersion: 0, since });
      // The page asks where the feed stands, then loads the runs; nothing changes meanwhile.
      const at = feedCursor(feed(null));
      expect(at).toEqual(expect.any(String));
      const poll = feed(at);
      expect(reloadFor(poll, false)).toBe(false);
      expect(poll.jobs).toBe(false);
      // A run that starts after it is reloaded for, wherever the load had got to.
      addRun(store, { startedAt: Date.UTC(2026, 9, 1, 1), calls: 'l' });
      expect(reloadFor(feed(feedCursor(poll)), false)).toBe(true);
      // A cursor from before a restart of the server counts as everything changed.
      expect(reloadFor(changesView(store, { boot: 'b2', jobsVersion: 0, since: at }), false)).toBe(true);
    } finally {
      store.close();
    }
    expect(feedCursor({ version: 7 })).toBe('7');
    expect(feedCursor(null)).toBeNull();
  });

  it('knows a run opened by its short id when the page settles on the full one', () => {
    expect(sameRun('01K5CQ4N7G', '01K5CQ4N7GZ8B1M4Q2XW3RTY6P')).toBe(true);
    expect(sameRun('01k5cq4n7g', '01K5CQ4N7GZ8B1M4Q2XW3RTY6P')).toBe(true);
    expect(sameRun('01K5CQ4N7GZ8B1M4Q2XW3RTY6P', '01K5CQ4N7GZ8B1M4Q2XW3RTY6P')).toBe(true);
    expect(sameRun('01K5CQ4P2R', '01K5CQ4N7GZ8B1M4Q2XW3RTY6P')).toBe(false);
    expect(sameRun('', '01K5CQ4N7GZ8B1M4Q2XW3RTY6P')).toBe(false);
  });
});

describe('following a job', () => {
  it('waits while the server is unreachable, stops when the link expired, and calls a job the server lost lost', () => {
    expect(afterPollError({ status: null, unreachable: true, failures: 1 })).toBe('wait');
    expect(afterPollError({ status: 502, unreachable: true, failures: 9 })).toBe('wait');
    expect(afterPollError({ status: 401, unreachable: false, failures: 1 })).toBe('stop');
    expect(afterPollError({ status: 404, unreachable: false, failures: 1 })).toBe('lost');
    expect(afterPollError({ status: 500, unreachable: false, failures: 1 })).toBe('retry');
    expect(afterPollError({ status: 500, unreachable: false, failures: 5 })).toBe('lost');
  });

  it('says a lost job is lost rather than running', () => {
    const job = { args: ['replay', '01K5CQ4N7G'], done: false, code: null };
    expect(jobStatus(job, [], true)).toEqual({ text: 'lost · the dashboard server no longer has this job', tone: 'err' });
    expect(jobStatus(job, [])).toEqual({ text: 'running', tone: '' });
    expect(jobStatus({ ...job, done: true, code: 0 }, ['Replay clean'], true)).toEqual({ text: 'reproduced · exit 0', tone: 'ok' });
  });
});

describe('a recording followed live', () => {
  const step = (over: Partial<Parameters<typeof followNewest>[0]> = {}) => ({ wasStatus: 'running', status: 'running', prevLast: 9, last: 11, selected: 9, ...over });

  it('moves the selection to the newest call when it was on the newest', () => {
    expect(followNewest(step())).toBe(11);
    expect(followNewest(step({ selected: 4 }))).toBeNull();
    expect(followNewest(step({ last: 9 }))).toBeNull();
  });

  it('follows the last calls when they arrive with the end of the recording', () => {
    // The 30-call recording that finished with the selection left on #27.
    expect(followNewest(step({ status: 'completed', prevLast: 27, last: 30, selected: 27 }))).toBe(30);
    expect(recordingEnded(step({ status: 'completed' }))).toBe('finished');
    expect(recordingEnded(step({ status: 'failed' }))).toBe('finished');
    // Stopped before it ended (Ctrl-C, its recorder killed): the toast says so, as every list does.
    expect(recordingEnded(step({ status: 'crashed' }))).toBe('interrupted');
  });

  it('leaves a finished run alone, and says nothing about one that was never recording', () => {
    expect(followNewest(step({ wasStatus: 'completed', status: 'completed' }))).toBeNull();
    expect(recordingEnded(step())).toBeNull();
    expect(recordingEnded(step({ wasStatus: 'completed', status: 'completed' }))).toBeNull();
    expect(followNewest(step({ prevLast: null, last: 1, selected: null }))).toBeNull();
  });

  // The run list the shell loads every 2 s: what was recording at the last load, and what it says now.
  const listed = (runId: string, status: string, calls: number, over: Partial<ListedRun> = {}): ListedRun => ({ runId, status, calls, ...over });

  it('says on any page that a recording finished, from two loads of the run list', () => {
    const before = [listed('01M53JE2Q0AAAAAAAAAAAAAAAA', 'running', 14), listed('01M53HB064AAAAAAAAAAAAAAAA', 'completed', 30)];
    // running → completed (the agent exited 0) or failed (it exited 1): finished either way.
    for (const status of ['completed', 'failed']) {
      const ended = endedRecordings(before, [listed('01M53JE2Q0AAAAAAAAAAAAAAAA', status, 32), before[1]]);
      expect(ended).toEqual([{ runId: '01M53JE2Q0AAAAAAAAAAAAAAAA', calls: 32, how: 'finished' }]);
      expect(recordingToast(ended)).toBe('Recording finished · 01M53JE2Q0 · 32 calls');
    }
    // Still recording, or a run that had already ended: nothing to say.
    expect(endedRecordings(before, [listed('01M53JE2Q0AAAAAAAAAAAAAAAA', 'running', 20), before[1]])).toEqual([]);
    expect(recordingToast([])).toBeNull();
  });

  it('says a recording stopped before its end was interrupted (Ctrl-C, or its recorder killed)', () => {
    const ended = endedRecordings([listed('01M53NQRN1AAAAAAAAAAAAAAAA', 'running', 9)], [listed('01M53NQRN1AAAAAAAAAAAAAAAA', 'crashed', 14)]);
    expect(ended).toEqual([{ runId: '01M53NQRN1AAAAAAAAAAAAAAAA', calls: 14, how: 'interrupted' }]);
    expect(recordingToast(ended)).toBe('Recording interrupted · 01M53NQRN1 · 14 calls');
    expect(recordingToast([{ runId: '01M53NQRN1AAAAAAAAAAAAAAAA', calls: 1, how: 'finished' }])).toBe('Recording finished · 01M53NQRN1 · 1 call');
  });

  it('leaves out the first load, a deleted run, attempts, test replays and what a job this page follows made', () => {
    const was = (runId: string, over: Partial<ListedRun> = {}) => listed(runId, 'running', 5, over);
    const now = (runId: string, over: Partial<ListedRun> = {}) => listed(runId, 'completed', 9, over);
    expect(endedRecordings(null, [now('A')])).toEqual([]);
    expect(endedRecordings([was('A')], [])).toEqual([]);
    expect(endedRecordings([was('P', { attempt: 'probe', attemptOf: 'R' })], [now('P', { attempt: 'probe', attemptOf: 'R' })])).toEqual([]);
    expect(endedRecordings([was('T', { test: { golden: 'goldens/a' } })], [now('T', { test: { golden: 'goldens/a' } })])).toEqual([]);
    // A Replay the dashboard started: its drawer, or its toast when it ends, says how it went.
    expect(endedRecordings([was('J'), was('K')], [now('J'), now('K')], new Set(['J']))).toEqual([{ runId: 'K', calls: 9, how: 'finished' }]);
  });

  it('names how many ended when several end between two loads', () => {
    const before = ['01M53NP35MAAAAAAAAAAAAAAAA', '01M53NPSHFAAAAAAAAAAAAAAAA', '01M53NQ97XAAAAAAAAAAAAAAAA', '01M53NQRN1AAAAAAAAAAAAAAAA'].map((id) => listed(id, 'running', 3));
    const done = before.map((r) => ({ ...r, status: 'completed' }));
    expect(recordingToast(endedRecordings(before.slice(0, 2), done.slice(0, 2)))).toBe('2 recordings finished · 01M53NP35M, 01M53NPSHF');
    expect(recordingToast(endedRecordings(before, done))).toBe('4 recordings finished · 01M53NP35M, 01M53NPSHF, 01M53NQ97X, …');
    expect(recordingToast(endedRecordings(before.slice(0, 2), [done[0], { ...done[1], status: 'crashed' }]))).toBe('2 recordings ended · 01M53NP35M, 01M53NPSHF');
    expect(recordingToast(endedRecordings(before.slice(0, 2), done.slice(0, 2).map((r) => ({ ...r, status: 'crashed' }))))).toBe('2 recordings interrupted · 01M53NP35M, 01M53NPSHF');
  });
});
