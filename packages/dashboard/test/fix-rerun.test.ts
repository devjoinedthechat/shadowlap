import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decideVerify, expectArgs, leftWords, recordBlame, recordVerdict, type StepRerun, Store } from '@shadowlap/engine';
import { applyFixDoc, fixDocOf, parseFixDoc } from '@shadowlap/remote';
import { blameReport, EXPECT, makeRun, verifyReport } from '../../engine/test/fix-fixtures.js';
import { fixDetail } from '../src/fixes.js';
import { fieldArgs, rerunFlags } from '../src/rerun.js';

/**
 * Run more attempts, Verify again and Blame again run `shadowlap` with arguments made from a kept
 * record's checked fields and the flags it kept beside them, each checked against a list of flags
 * and the shape of their values: never from the command line it printed, and of a record a pull
 * brought, never with `--build`, `--base` or the command after `--`.
 */

let store: Store;
beforeEach(() => {
  store = Store.open(':memory:');
});
afterEach(() => {
  store.close();
});

const rerun = (flags: string[], command: string[] | null = null): StepRerun => ({ flags, command });

describe('the flags a kept blame or verify runs again with', () => {
  it('takes the flags it allows, with values of their shape, in the order kept', () => {
    const flags = ['--from', 'gpt-4o-2024-08-06', '--live-tool', 'search_web', '--margin', '0.1', '--baseline', 'paired', '--fail-fast', '--writes', 'block', '--reads', 'replay', '--budget', '0.5', '--timeout', '120'];
    expect(rerunFlags('verify', rerun(flags), { pulled: false })).toEqual({ flags, command: null, left: [], dropped: {} });
    expect(rerunFlags('blame', rerun(['--scan', '3', '--writes', 'stub']), { pulled: false })!.flags).toEqual(['--scan', '3', '--writes', 'stub']);
  });

  it('runs nothing again with a flag it doesn’t list, or one another command takes', () => {
    for (const flags of [['--db', '/elsewhere.db'], ['--expect', '@/etc/passwd'], ['--gate', '@gate.json'], ['--repairer', 'claude-code'], ['--yes'], ['--json'], ['--'], ['--scan', '2'], ['--from=gpt-4o'], ['__proto__'], ['constructor'], ['toString']]) {
      expect(rerunFlags('verify', rerun(flags), { pulled: false }), flags.join(' ')).toBeNull();
    }
    // A blame takes neither verify's change nor its baseline.
    for (const flags of [['--from', 'gpt-4o'], ['--build', 'npm run build'], ['--base', 'HEAD'], ['--live-tool', 'x']]) expect(rerunFlags('blame', rerun(flags), { pulled: false }), flags.join(' ')).toBeNull();
  });

  it('runs nothing again with a value that could be read as a flag or a file, or isn’t of its shape', () => {
    for (const flags of [
      ['--from', '-x'],
      ['--from', '--upload-pack=x'],
      ['--live-tool', '--db=/x'],
      ['--live-tool', '@tools.txt'],
      ['--live-tool', ' search'],
      ['--writes', 'allow'],
      ['--reads', 'all'],
      ['--timeout', '0'],
      ['--timeout', '-5'],
      ['--margin', '1'],
      ['--margin', '0'],
      ['--budget', '-1'],
      ['--budget', '0'],
      ['--base', '-c'],
      ['--base', 'main..evil'],
      ['--build', 'npm run build\nrm -rf ~'],
      ['--from'],
    ]) {
      expect(rerunFlags('verify', rerun(flags), { pulled: false }), flags.join(' ')).toBeNull();
    }
    expect(rerunFlags('verify', rerun([], ['-c', 'x']), { pulled: false })).toBeNull();
    expect(rerunFlags('verify', { flags: 'x' } as unknown as StepRerun, { pulled: false })).toBeNull();
    expect(rerunFlags('verify', null, { pulled: false })).toBeNull();
  });

  it('runs nothing again with a value that hides what its command line shows: a right-to-left override, a zero-width space, a separator', () => {
    // The review's: a tool name that, shown, reads as another command line.
    for (const hidden of [0x202e, 0x200b, 0x2028, 0x2029, 0x2066, 0xfeff].map((c) => String.fromCharCode(c))) {
      const what = hidden.codePointAt(0)!.toString(16);
      expect(rerunFlags('verify', rerun(['--live-tool', `x${hidden} bd.live/pmt/ bd--`]), { pulled: true }), what).toBeNull();
      expect(rerunFlags('verify', rerun(['--build', `npm run build${hidden}`]), { pulled: false }), what).toBeNull();
      expect(fieldArgs({ temperature: 1, system: `be brief${hidden}` }), what).toBeNull();
      expect(expectArgs({ tools: { forbidden: [`send_email${hidden}`] } }), what).toBeNull();
    }
    // A name in another script, or with an accent, is a name like any other.
    expect(rerunFlags('verify', rerun(['--live-tool', 'buscar_café']), { pulled: true })!.flags).toEqual(['--live-tool', 'buscar_café']);
    expect(fieldArgs({ system: 'Antworte kurz: Größe in mm' })).toEqual(['--set', 'system=Antworte kurz: Größe in mm']);
  });

  it('keeps a record made here whole, its --build, --base and command after -- the user’s own', () => {
    const r = rerunFlags('verify', rerun(['--base', 'HEAD~1', '--build', 'npm run build', '--writes', 'block'], ['python', 'agent_v2.py']), { pulled: false });
    expect(r).toEqual({ flags: ['--base', 'HEAD~1', '--build', 'npm run build', '--writes', 'block'], command: ['python', 'agent_v2.py'], left: [], dropped: {} });
  });

  it('leaves out of a pulled record what runs on no other machine, and names what it left', () => {
    const r = rerunFlags('verify', rerun(['--base', 'HEAD~1', '--build', 'sh ./x', '--writes', 'block'], ['sh', '-c', 'echo planted']), { pulled: true });
    expect(r).toEqual({ flags: ['--writes', 'block'], command: null, left: ['--base', '--build', '--'], dropped: {} });
    expect(leftWords(r!.left)).toBe('--base, --build and command after --');
    expect(leftWords(['--'])).toBe('command after --');
  });

  it('leaves out the flags the caller sets itself, saying what their values were', () => {
    expect(rerunFlags('verify', rerun(['--budget', '0.012', '--writes', 'block']), { pulled: false, drop: new Set(['--budget']) })).toEqual({ flags: ['--writes', 'block'], command: null, left: [], dropped: { '--budget': '0.012' } });
  });

  it('writes a check and request fields as the CLI reads them back, and refuses those it can’t', () => {
    expect(expectArgs(null)).toEqual([]);
    expect(expectArgs({ tools: { send_email: 1 } })).toEqual(['--expect', '{"tools":{"send_email":1}}']);
    expect(expectArgs('@/etc/passwd')).toBeNull();
    expect(expectArgs([1])).toBeNull();
    expect(fieldArgs({ model: 'claude-opus-5-5', temperature: 1, 'thinking.budget_tokens': 4096, stop: 'END', seed: '7' })).toEqual(['--model', 'claude-opus-5-5', '--set', 'temperature=1', '--set', 'thinking.budget_tokens=4096', '--set', 'stop=END', '--set', 'seed="7"']);
    expect(fieldArgs({ model: '--upload-pack=x' })).toBeNull();
    expect(fieldArgs({ '-x': 1 })).toBeNull();
    expect(fieldArgs({})).toEqual([]);
  });
});

/**
 * An incomplete verdict of a failing run a budget stopped, kept with `command` and `rerun` as given:
 * here, or with `pulled` on a teammate's machine, whose fix this one's pull brings (applyFixDoc).
 */
function stopped(o: { command: string; rerun?: StepRerun; pulled?: { from: string; at: number } }): { fixId: string; failing: string; verifyId: string } {
  const theirs = o.pulled ? Store.open(':memory:') : store;
  try {
    const failing = makeRun(theirs, { labels: ['double-email'] });
    const { fix } = recordBlame(theirs, { runId: failing, report: blameReport(failing), expect: EXPECT, scope: null, command: 'b', rerun: rerun([]), title: 't', checkText: 'c' });
    const report = verifyReport([{ runId: failing, role: 'target', pass: true }]);
    report.runs[0] = { ...report.runs[0], verdict: 'open', decision: 'continue' };
    Object.assign(report, decideVerify(report.runs, 'the budget of $0.01 is spent'), { gate: null, stopReason: 'the budget of $0.01 is spent', attemptsPerRun: 5, needed: 4 });
    const { verdict } = recordVerdict(theirs, { report, expect: EXPECT, command: o.command, ...(o.rerun ? { rerun: o.rerun } : {}) });
    if (o.pulled) {
      store.createRun({ runId: failing, mode: 'record', parentRunId: null, command: { argv: ['node', 'agent.mjs'], cwd: '.' }, startedAt: 1_000, meta: { labels: ['double-email'] } });
      store.endRun(failing, 'failed');
      applyFixDoc(store, parseFixDoc(Buffer.from(JSON.stringify(fixDocOf(theirs, fix.fixId))), fix.fixId), o.pulled);
    }
    return { fixId: fix.fixId, failing, verifyId: verdict.verifyId };
  } finally {
    if (theirs !== store) theirs.close();
  }
}

/** A stopped blame, its gate or fixed count given, made here or, with `pulled`, pulled from a teammate's store. */
function stoppedBlame(o: { gate?: { good: number; bad: number; risk: number; max: number }; attempts?: number; flags: string[]; pulled?: { from: string; at: number } }): { fixId: string; failing: string } {
  const theirs = o.pulled ? Store.open(':memory:') : store;
  try {
    const failing = makeRun(theirs, { labels: ['digest'] });
    const report = blameReport(failing, 'stopped');
    if (o.gate) Object.assign(report, { gate: { kind: 'sprt', ...o.gate } });
    if (o.attempts) Object.assign(report, { attemptsPerProbe: o.attempts, needed: o.attempts });
    const { fix } = recordBlame(theirs, { runId: failing, report, expect: EXPECT, scope: null, command: 'b', rerun: rerun(o.flags), title: 't', checkText: 'c' });
    if (o.pulled) {
      store.createRun({ runId: failing, mode: 'record', parentRunId: null, command: { argv: ['node', 'agent.mjs'], cwd: '.' }, startedAt: 1_000, meta: { labels: ['digest'] } });
      store.endRun(failing, 'failed');
      applyFixDoc(store, parseFixDoc(Buffer.from(JSON.stringify(fixDocOf(theirs, fix.fixId))), fix.fixId), o.pulled);
    }
    return { fixId: fix.fixId, failing };
  } finally {
    if (theirs !== store) theirs.close();
  }
}

/** A verdict whose run ran out at its gate (inconclusive) or, with a fixed count, was stopped by its budget; made here or pulled. */
function ranOut(o: { gate?: { good: number; bad: number; risk: number; max: number }; attempts?: number; pulled?: { from: string; at: number } }): { fixId: string; failing: string } {
  const theirs = o.pulled ? Store.open(':memory:') : store;
  try {
    const failing = makeRun(theirs, { labels: ['double-email'] });
    const { fix } = recordBlame(theirs, { runId: failing, report: blameReport(failing), expect: EXPECT, scope: null, command: 'b', rerun: rerun([]), title: 't', checkText: 'c' });
    const report = verifyReport([{ runId: failing, role: 'target', pass: true }]);
    report.runs[0] = { ...report.runs[0], verdict: 'open', decision: o.gate ? 'inconclusive' : 'continue' };
    const stopReason = o.gate ? null : 'the budget of $0.01 is spent';
    Object.assign(report, decideVerify(report.runs, stopReason), { gate: o.gate ? { kind: 'sprt', ...o.gate } : null, stopReason, attemptsPerRun: o.attempts ?? 5, needed: 4 });
    recordVerdict(theirs, { report, expect: EXPECT, command: 'v', rerun: rerun(['--writes', 'block']) });
    if (o.pulled) {
      store.createRun({ runId: failing, mode: 'record', parentRunId: null, command: { argv: ['node', 'agent.mjs'], cwd: '.' }, startedAt: 1_000, meta: { labels: ['double-email'] } });
      store.endRun(failing, 'failed');
      applyFixDoc(store, parseFixDoc(Buffer.from(JSON.stringify(fixDocOf(theirs, fix.fixId))), fix.fixId), o.pulled);
    }
    return { fixId: fix.fixId, failing };
  } finally {
    if (theirs !== store) theirs.close();
  }
}

describe('what one yes may spend running a pulled record again', () => {
  const pulled = { from: 's3://team-bucket/project', at: 5 };
  const huge = { good: 0.6, bad: 0.1, risk: 0.05, max: 1000 };

  it('runs a pulled blame’s gate to at most twice blame’s default, and probes at most 2 calls past the boundary', () => {
    const { fixId, failing } = stoppedBlame({ gate: huge, flags: ['--scan', '999', '--writes', 'stub'], pulled });
    const again = fixDetail(store, fixId)!.actions.blameAgain!;
    expect(again.argv).toEqual(['blame', failing, '--expect', JSON.stringify(EXPECT), '--gate', JSON.stringify({ max: 40 }), '--scan', '2', '--writes', 'stub']);
    expect(again.command).toContain(`--gate '{"max":40}' --scan 2`);
    // Its ask says how far the search got: the furthest call a probe rescued the run at, with no bar to lower.
    expect([again.kind, again.soFar, again.lastGood]).toEqual(['stopped', 1, null]);
    // A fixed count of 100 a probe: 10.
    const counted = stoppedBlame({ attempts: 100, flags: [], pulled });
    expect(fixDetail(store, counted.fixId)!.actions.blameAgain!.argv).toEqual(['blame', counted.failing, '--expect', JSON.stringify(EXPECT), '--attempts', '10', '--passes', '10']);
  });

  it('runs one made here with its own figures, as it was kept', () => {
    const { fixId, failing } = stoppedBlame({ gate: huge, flags: ['--scan', '999'] });
    expect(fixDetail(store, fixId)!.actions.blameAgain!.argv).toEqual(['blame', failing, '--expect', JSON.stringify(EXPECT), '--gate', JSON.stringify({ max: 1000 }), '--scan', '999']);
  });

  it('runs a pulled verdict to at most twice verify’s default, a fixed count to 10, and offers no more than that', () => {
    const gate = { good: 0.9, bad: 0.7, risk: 0.05 };
    // A gate that ran out at 50: Run more doubles it, to 100, under the cap of 160.
    const fifty = ranOut({ gate: { ...gate, max: 50 }, pulled });
    expect(fixDetail(store, fifty.fixId)!.verify[0].more).toMatchObject({ kind: 'more', max: 100 });
    expect(fixDetail(store, fifty.fixId)!.verify[0].more!.argv).toContain(JSON.stringify({ max: 100 }));
    // One that ran out at 1,000: held to 160, so there is no more to offer.
    expect(fixDetail(store, ranOut({ gate: { ...gate, max: 1000 }, pulled }).fixId)!.verify[0].more).toBeNull();
    // A fixed count of 100 a run, stopped by its budget: 10.
    const counted = ranOut({ attempts: 100, pulled });
    const argv = fixDetail(store, counted.fixId)!.verify[0].more!.argv;
    expect(argv.slice(argv.indexOf('--attempts'), argv.indexOf('--attempts') + 4)).toEqual(['--attempts', '10', '--passes', '4']);
    // Made here, the same gate doubles as it was kept.
    expect(fixDetail(store, ranOut({ gate: { ...gate, max: 300 } }).fixId)!.verify[0].more).toMatchObject({ kind: 'more', max: 600 });
  });
});

describe('Run more attempts, Verify again and Blame again', () => {
  const planted = `shadowlap verify --fixes label:double-email --build 'sh -c "echo planted"' -- sh -c 'echo planted'`;

  it('never splits a command line back into one to run: a verdict kept without its flags offers nothing to run', () => {
    const { fixId } = stopped({ command: planted });
    const v = fixDetail(store, fixId)!.verify[0];
    expect(v.more).toBeNull();
    // Its own command line is shown as it ran: it was given here.
    expect(v.command).toBe(planted);
  });

  it('runs a verdict made here again from its fields and flags, with the command after -- the user gave', () => {
    const { fixId, failing } = stopped({ command: planted, rerun: rerun(['--writes', 'block', '--budget', '0.01'], ['python', 'agent_v2.py']) });
    const more = fixDetail(store, fixId)!.verify[0].more!;
    expect(more.argv).toEqual(['verify', '--fixes', failing, '--expect', JSON.stringify(EXPECT), '--attempts', '5', '--passes', '4', '--writes', 'block', '--', 'python', 'agent_v2.py']);
    expect(more).toMatchObject({ pulled: null, left: [], budget: '0.01' });
  });

  it('runs a pulled verdict again without what runs on no other machine, and shows no teammate’s command line to copy', () => {
    const pulled = { from: 's3://team-bucket/project', at: 5 };
    const { fixId, failing } = stopped({ command: planted, rerun: rerun(['--build', 'sh -c "echo planted"', '--writes', 'block'], ['sh', '-c', 'echo planted']), pulled });
    const v = fixDetail(store, fixId)!.verify[0];
    expect(v.more!.argv).toEqual(['verify', '--fixes', failing, '--expect', JSON.stringify(EXPECT), '--attempts', '5', '--passes', '4', '--writes', 'block']);
    expect(v.more).toMatchObject({ pulled, left: ['--build', '--'] });
    expect(v.pulled).toEqual(pulled);
    expect(v.command).not.toContain('planted');
    expect(v.command).toBe(`shadowlap verify --fixes ${failing} --expect '${JSON.stringify(EXPECT)}' --attempts 5 --passes 4 --writes block`);
  });

  it('offers no Blame again for a blame whose scope could be read as a flag, nor a repair that would take it', () => {
    const run = makeRun(store, { labels: ['digest'] });
    const report = blameReport(run, 'stopped');
    recordBlame(store, { runId: run, report, expect: EXPECT, scope: '--build=sh', command: 'b', rerun: rerun([]), title: 't', checkText: 'c' });
    const fix = store.listFixes()[0];
    const d = fixDetail(store, fix.fixId)!;
    expect(d.actions.blameAgain).toBeNull();
    expect(d.actions.repair).toBeNull();
  });
});
