import { describe, expect, it } from 'vitest';
import { endToast, jobHeader, jobStatus, lastLine, lineTone } from '../ui/jobs.js';

const done = (o: Partial<Parameters<typeof jobStatus>[0]> & { code: number | null }) => ({ args: ['x'], done: true, ...o });

describe('how a job ends, in the words of its kind', () => {
  it('a session says its verdict and its tally, never counting an inconclusive golden as passed or failed', () => {
    const test = (code: number, line: string) => jobStatus(done({ kind: 'test', args: ['test'], code }), [line]);
    expect(test(1, '2 passed, 5 failed · 3 upstream requests')).toEqual({ text: 'failed · 2 of 7 goldens passed · exit 1', tone: 'err' });
    expect(test(3, '5 passed, 0 failed, 2 inconclusive (failing the run: --inconclusive warn lets them through) · 0 upstream requests')).toEqual({ text: 'inconclusive · 5 of 7 goldens passed · exit 3', tone: 'warn' });
    expect(test(0, '7 passed, 0 failed · 0 upstream requests')).toEqual({ text: 'passed · 7 of 7 goldens passed · exit 0', tone: 'ok' });
    expect(test(130, '3 passed, 0 failed, 4 not run: interrupted · 0 upstream requests')).toEqual({ text: 'interrupted · exit 130', tone: 'warn' });
    expect(test(2, '1 passed, 0 failed · 0 upstream requests')).toEqual({ text: '1 passed · exit 2', tone: 'err' });
  });

  it('one golden needs no tally', () => {
    const one = (code: number, line: string) => jobStatus(done({ kind: 'pack-test', code }), [line]);
    expect(one(0, '1 passed, 0 failed')).toEqual({ text: 'passed · exit 0', tone: 'ok' });
    expect(one(1, '0 passed, 1 failed')).toEqual({ text: 'failed · exit 1', tone: 'err' });
    expect(one(3, '0 passed, 0 failed, 1 inconclusive (failing the run)')).toEqual({ text: 'inconclusive · exit 3', tone: 'warn' });
  });

  it('an update says whether it held', () => {
    const update = (kind: string, code: number, line: string) => jobStatus(done({ kind, code }), [line]);
    expect(update('test-update', 0, '1 passed, 0 failed')).toEqual({ text: 'updated · exit 0', tone: 'ok' });
    expect(update('test-update', 1, '0 passed, 1 failed')).toEqual({ text: 'diverged again · exit 1', tone: 'err' });
    expect(update('task-update', 0, '1 passed, 0 failed')).toEqual({ text: 'updated · exit 0', tone: 'ok' });
    expect(jobStatus(done({ kind: 'normalize-and-test', title: 'Adding normalizer and updating golden', code: 1 }), ['0 passed, 1 failed']).text).toBe('diverged again · exit 1');
  });

  it('Add normalizer and re-run names what still failed', () => {
    const rerun = (code: number, ...lines: string[]) => jobStatus(done({ kind: 'normalize-and-test', title: 'Adding normalizer and re-running', code }), lines);
    expect(rerun(0, '1 passed, 0 failed').text).toBe('passed · exit 0');
    expect(rerun(1, '✗ a: check failed: issue_refund called 1×', '0 passed, 1 failed').text).toBe('check failed · exit 1');
    expect(rerun(1, '✗ a: diverged at call 3 (api POST /v1/messages)', '0 passed, 1 failed').text).toBe('diverged · exit 1');
  });

  it('a search names the commit, or says none was found in amber, or that it never searched', () => {
    const bisect = (code: number, ...lines: string[]) => jobStatus(done({ kind: 'bisect', args: ['bisect'], code }), lines);
    expect(bisect(0, '✓ first bad commit 9a3c5e0 · Send the id · Ravi · 2026-09-30')).toEqual({ text: 'first bad commit 9a3c5e0 · exit 0', tone: 'ok' });
    expect(bisect(1, '✗ no first bad commit: every commit in the range passes')).toEqual({ text: 'no first bad commit · exit 1', tone: 'warn' });
    expect(bisect(3, '✗ no first bad commit: 7f20b6a could not be tested')).toEqual({ text: 'not searched · exit 3', tone: 'err' });
    expect(bisect(2, 'shadowlap: no such revision')).toEqual({ text: 'not searched · exit 2', tone: 'err' });
    expect(endToast(done({ kind: 'bisect', title: 'Finding breaking commit', args: ['bisect'], code: 0 }), ['✓ first bad commit 9a3c5e0 · Send the id'])).toBe('Found breaking commit · first bad commit 9a3c5e0 · exit 0');
    expect(endToast(done({ kind: 'bisect', title: 'Finding breaking commit', args: ['bisect'], code: 1 }), ['✗ no first bad commit: x'])).toBe('Searched for breaking commit · no first bad commit · exit 1');
  });

  it('a revert says what git left, then how its test came out, and its toast names the commit', () => {
    const revert = (code: number, git: 'done' | 'untouched' | 'conflicts') => done({ kind: 'revert', title: 'Reverting 9a3c5e0', args: ['test', 'goldens/a'], code, git });
    const status = (j: ReturnType<typeof revert>, ...lines: string[]) => jobStatus(j, lines);
    expect(status(revert(0, 'done'), '1 passed, 0 failed')).toEqual({ text: 'passed · exit 0', tone: 'ok' });
    expect(status(revert(1, 'done'), '0 passed, 1 failed')).toEqual({ text: 'reverted · test failed · exit 1', tone: 'err' });
    // The test after it came out inconclusive, or refused before it ran: its words, after what git did.
    expect(status(revert(3, 'done'), '0 passed, 0 failed, 1 inconclusive')).toEqual({ text: 'reverted · inconclusive · exit 3', tone: 'warn' });
    expect(status(revert(2, 'done'), '✗ goldens/a: no run.json in it')).toEqual({ text: 'reverted · test failed · exit 2', tone: 'err' });
    expect(status(revert(128, 'untouched'), 'error: Your local changes to the following files would be overwritten by merge:')).toEqual({ text: 'not reverted · exit 128', tone: 'err' });
    expect(status(revert(1, 'conflicts'), 'CONFLICT (content): Merge conflict in agent.py')).toEqual({ text: 'conflicts left in your working tree · exit 1', tone: 'err' });
    expect(endToast(revert(0, 'done'), ['1 passed, 0 failed'])).toBe('Reverted 9a3c5e0 · passed · exit 0');
    expect(endToast(revert(1, 'done'), ['0 passed, 1 failed'])).toBe('Reverted 9a3c5e0 · test failed · exit 1');
    expect(endToast(revert(3, 'done'), ['0 passed, 0 failed, 1 inconclusive'])).toBe('Reverted 9a3c5e0 · inconclusive · exit 3');
    expect(endToast(revert(128, 'untouched'), [])).toBe('Tried reverting 9a3c5e0 · not reverted · exit 128');
  });

  it('a verify says its verdict, and a rejected one claims no more than a check', () => {
    const verify = (code: number, verdict: string) => done({ kind: 'verify', title: 'Verifying', args: ['verify'], code, result: { verdict } });
    expect(jobStatus(verify(0, 'accepted'), [])).toEqual({ text: 'accepted · exit 0', tone: 'ok' });
    expect(jobStatus(verify(1, 'rejected'), [])).toEqual({ text: 'rejected · exit 1', tone: 'err' });
    expect(jobStatus(verify(3, 'inconclusive'), [])).toEqual({ text: 'inconclusive · exit 3', tone: 'warn' });
    expect(endToast(verify(1, 'rejected'), [])).toBe('Checked · rejected · exit 1');
    expect(endToast(verify(0, 'accepted'), [])).toBe('Verified · accepted · exit 0');
  });

  it('a repeat says whether its attempts took one path, and a planted instruction no more than that it replayed', () => {
    const repeat = (report: unknown, code = 0, more: string[] = []) => done({ args: ['replay', 'X', '--repeat', '5', ...more], title: 'Repeating', code, result: { report } });
    const runs = (n: number) => Array.from({ length: n }, (_, i) => `r${i}`);
    expect(jobStatus(repeat({ forkedAt: [null], paths: [{ runIds: runs(5) }] }), []).text).toBe('identical · exit 0');
    expect(jobStatus(repeat({ forkedAt: [4], paths: [{ runIds: runs(4) }, { runIds: runs(1) }] }), []).text).toBe('4 of 5 same path · exit 0');
    expect(jobStatus(repeat({ forkedAt: [4], paths: [{ runIds: runs(5) }] }), []).text).toBe('5 of 5 same path · exit 0');
    expect(jobStatus(repeat({ forkedAt: [4], paths: [{ runIds: runs(5) }] }, 1), ['✗ check failed in 5 of 5']).text).toBe('check failed · exit 1');
    const plant = (lines: string[], code = 0) => jobStatus(repeat(null, code, ['--inject-result', '3=x']), lines);
    expect(plant(['! nothing judged whether the agent obeyed']).text).toBe('replayed · exit 0');
    expect(plant(['✓ 3 checks passed']).text).toBe('check passed · exit 0');
    expect(plant(['✗ check failed'], 1).text).toBe('check failed · exit 1');
  });

  it('a check tried on the recordings says its tally', () => {
    const check = (code: number, result: unknown) => jobStatus(done({ kind: 'check', title: 'Checking recordings', code, result }), []);
    expect(check(1, { recordings: [1, 2, 3], counts: { passed: 2, failed: 1 } }).text).toBe('failed · 2 of 3 recordings passed · exit 1');
    expect(check(3, { recordings: [1, 2, 3], counts: { passed: 2, inconclusive: 1 } }).text).toBe('inconclusive · 2 of 3 recordings passed · exit 3');
    expect(check(0, { recordings: [1], counts: { passed: 1 } }).text).toBe('passed · 1 of 1 recording passed · exit 0');
    expect(check(2, { recordings: [], counts: {} })).toEqual({ text: 'nothing to check · exit 2', tone: 'warn' });
    // A recording no check applied to is counted apart, as the command counts it, and never as passed.
    expect(check(0, { recordings: [1, 2], counts: { passed: 1, notApplicable: 1 } })).toEqual({ text: 'passed · 1 of 2 recordings passed, 1 not applicable · exit 0', tone: 'ok' });
    expect(check(0, { recordings: [1], counts: { passed: 0, notApplicable: 1 } })).toEqual({ text: 'not applicable · 0 of 1 recording passed, 1 not applicable · exit 0', tone: '' });
  });

  it('Save check says the check changed, with the verdicts that stopped counting, or that nothing changed, and its toast leads with what ran', () => {
    const fixCheck = (code: number, result: unknown) => done({ kind: 'fix-check', title: 'Changing check', args: ['fix', 'check', 'fx-1'], code, result });
    // Its lines are a check's: never "check passed" or "check failed".
    const lines = ['✓ Changed the check of fx-01K8RG000 · Refunds issued without approval', '  failing ✓ 01K8RG0000  failed'];
    expect(jobStatus(fixCheck(0, { status: 'changed', uncounted: [] }), lines)).toEqual({ text: 'changed · exit 0', tone: 'ok' });
    expect(jobStatus(fixCheck(0, { status: 'changed', uncounted: ['vf-1'] }), lines).text).toBe('changed · 1 verdict no longer counts · exit 0');
    expect(jobStatus(fixCheck(0, { status: 'changed', uncounted: ['vf-1', 'vf-2'] }), lines).text).toBe('changed · 2 verdicts no longer count · exit 0');
    expect(jobStatus(fixCheck(0, { status: 'unchanged', uncounted: [] }), [])).toEqual({ text: 'unchanged · exit 0', tone: 'warn' });
    expect(jobStatus(fixCheck(2, { status: 'error', error: { message: 'no' } }), [])).toEqual({ text: 'refused · exit 2', tone: 'warn' });
    expect(endToast(fixCheck(0, { status: 'changed', uncounted: [] }), lines)).toBe('Changed check · exit 0');
    expect(endToast(fixCheck(0, { status: 'unchanged', uncounted: [] }), [])).toBe('Tried changing check · unchanged · exit 0');
    expect(endToast(fixCheck(2, { status: 'error', error: { message: 'no' } }), [])).toBe('Tried changing check · refused · exit 2');
  });
});

describe('an injection job’s end', () => {
  const plant = (code: number, verdict: string) => jobStatus(done({ kind: 'injection', title: 'Running injection test', args: ['injection', 'X'], code, result: { results: [{ mode: 'plant' }], verdict } }), []);
  const clean = (code: number, verdict: string) => jobStatus(done({ kind: 'injection', title: 'Finding cause: testing #4', args: ['injection', 'X', '--clean', '4'], code, result: { results: [{ mode: 'clean', verdict }], verdict: 'passed' } }), []);
  const gate = (code: number, line: string) => jobStatus(done({ kind: 'pack-test', title: 'Packing with injection gate', args: ['test', 'goldens/x'], code }), ['  added to shadowlap.config.json, under "tests": "goldens/x": { "injection": { "obeyed": 0, "repeat": 3 } }', line]);

  it('says a test’s verdict with its real code: inconclusive exits 3', () => {
    expect(plant(1, 'failed')).toEqual({ text: 'failed · exit 1', tone: 'err' });
    expect(plant(3, 'inconclusive')).toEqual({ text: 'inconclusive · exit 3', tone: 'warn' });
    expect(plant(0, 'passed')).toEqual({ text: 'passed · exit 0', tone: 'ok' });
    expect(plant(130, 'inconclusive')).toEqual({ text: 'interrupted · exit 130', tone: 'warn' });
  });

  it('says Find cause’s answer: caused in red, not caused plain', () => {
    expect(clean(0, 'caused')).toEqual({ text: 'caused · exit 0', tone: 'err' });
    expect(clean(0, 'not caused')).toEqual({ text: 'not caused · exit 0', tone: '' });
    expect(clean(3, 'inconclusive')).toEqual({ text: 'inconclusive · exit 3', tone: 'warn' });
  });

  it('says Pack with injection gate packed, then how its test came out', () => {
    expect(gate(1, '0 passed, 1 failed · 4 upstream requests')).toEqual({ text: 'packed · its test failed · exit 1', tone: 'err' });
    expect(gate(3, '0 passed, 0 failed, 1 inconclusive (failing the run: --inconclusive warn lets them through) · 0 upstream requests')).toEqual({ text: 'packed · its test inconclusive · exit 3', tone: 'warn' });
    expect(gate(0, '1 passed, 0 failed · 4 upstream requests')).toEqual({ text: 'packed · its test passed · exit 0', tone: 'ok' });
    // Its header: packed, whatever its test said, and the test after it.
    expect(jobHeader({ kind: 'pack-test', title: 'Packing with injection gate', args: ['test', 'goldens/x'], done: true, code: 1 }, ['0 passed, 1 failed · 4 upstream requests'])).toEqual({ title: 'Packed with injection gate', text: 'its test failed · exit 1', tone: 'err' });
    // A Pack as golden… is a session's words, as before.
    expect(jobStatus(done({ kind: 'pack-test', title: 'Packing and testing', args: ['test', 'goldens/x'], code: 1 }), ['0 passed, 1 failed · 4 upstream requests']).text).toBe('failed · exit 1');
  });

  it('ends Find cause as a search, whatever the answer', () => {
    const header = (code: number, verdict: string) => jobHeader({ kind: 'injection', title: 'Finding cause: testing #4', args: ['injection', 'X', '--clean', '4'], done: true, code, result: { results: [{ mode: 'clean', verdict }] } }, []);
    expect(header(0, 'not caused')).toEqual({ title: 'Searched for cause: testing #4', text: 'not caused · exit 0', tone: '' });
    expect(header(0, 'caused')).toEqual({ title: 'Searched for cause: testing #4', text: 'caused · exit 0', tone: 'err' });
    expect(jobHeader({ kind: 'injection', title: 'Running injection test', args: ['injection', 'X'], done: true, code: 1, result: { results: [{ mode: 'plant' }], verdict: 'failed' } }, [])).toEqual({ title: 'Ran injection test', text: 'failed · exit 1', tone: 'err' });
  });
});

describe('the drawer’s header', () => {
  it('runs in the -ing form, and ends in the past tense its toast leads with', () => {
    const replay = { args: ['replay', 'X'], done: false, code: null };
    expect(jobHeader(replay, [])).toEqual({ title: 'Replaying', text: 'running', tone: '' });
    expect(jobHeader({ ...replay, stopped: true }, [])).toEqual({ title: 'Replaying', text: 'stopping', tone: '' });
    expect(jobHeader({ ...replay, done: true, code: 0 }, ['✓ Replay clean: 30/30 calls replayed'])).toEqual({ title: 'Replayed', text: 'reproduced · exit 0', tone: 'ok' });
  });

  it('never repeats its title in its status', () => {
    expect(jobHeader({ args: ['replay', 'X', '--inject', '1=x'], done: true, code: 0 }, ['⑂ Forked at call 1'])).toEqual({ title: 'Forked', text: 'exit 0', tone: 'ok' });
    const apply = (result: unknown) => ({ kind: 'apply', title: 'Applying fix', args: ['fix', 'apply', 'fx-1'], done: true, code: 0, result });
    expect(jobHeader(apply({ status: 'applied' }), [])).toMatchObject({ title: 'Applied fix', text: 'exit 0' });
    expect(jobHeader(apply({ status: 'applied', tests: 'passed' }), [])).toMatchObject({ title: 'Applied fix', text: 'tests passed · exit 0' });
    expect(jobHeader({ args: ['pack', 'X', 'share/x'], done: true, code: 0 }, ['✓ packed share/x · 14 calls'])).toMatchObject({ title: 'Packed', text: 'finished · exit 0' });
  });

  it('keeps the -ing title for a job stopped by hand or lost: it ended on no outcome to say in the past', () => {
    expect(jobHeader({ args: ['test'], title: 'Running tests', done: true, code: 143, stopped: true }, [])).toEqual({ title: 'Running tests', text: 'stopped · exit 143', tone: 'warn' });
    expect(jobHeader({ args: ['test'], title: 'Running tests', done: false, code: null }, [], true)).toEqual({ title: 'Running tests', text: 'lost · the dashboard server no longer has this job', tone: 'err' });
    // A blame whose own result says it stopped has run: what ran, then.
    expect(jobHeader({ kind: 'blame', title: 'Blaming', args: ['blame'], done: true, code: 3, result: { outcome: 'stopped' } }, [])).toEqual({ title: 'Tried blaming', text: 'stopped · exit 3', tone: 'warn' });
  });

  it('says a skill installed in the past tense', () => {
    expect(jobHeader({ kind: 'skill-install', title: 'Installing the skill', args: ['init'], done: true, code: 0 }, [])).toMatchObject({ title: 'Installed the skill', text: 'finished · exit 0' });
  });
});

describe('the log', () => {
  it('colours an inconclusive golden amber and what does not apply dim', () => {
    expect(lineTone('? refund: check inconclusive')).toBe('y');
    expect(lineTone('  – tool budget: not applicable')).toBe('dim');
    expect(lineTone('✓ passed')).toBe('ok');
    expect(lineTone('✗ failed')).toBe('no');
    expect(lineTone('plain – with a dash')).toBe('');
  });

  it('keeps a job’s last line to whole words', () => {
    const long = 'Forked at call 17 and went on live for the rest of the run, which took a long while to finish';
    const cut = lastLine([long]);
    expect(cut.length).toBeLessThanOrEqual(71);
    expect(cut.endsWith('…')).toBe(true);
    expect(long.startsWith(cut.slice(0, -1))).toBe(true);
    expect(long[cut.length - 1]).toBe(' ');
    expect(lastLine(['Everything was written. See the log for what it did.'])).toBe('Everything was written');
    expect(lastLine(['shadowlap: x.har is not a HAR file'])).toBe('shadowlap: x.har is not a HAR file');
  });
});
