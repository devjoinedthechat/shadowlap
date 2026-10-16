import { describe, expect, it } from 'vitest';
import { connStart, connStep, onTick, reloadFor, secondsLeft, type ConnState } from '../ui/connection.js';
import { afterPollError, jobStatus } from '../ui/jobs.js';
import { followNewest, recordingEnded } from '../ui/live.js';

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
    let now = 0;
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
});
