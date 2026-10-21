import { describe, expect, it } from 'vitest';
import { describeBlocks, describeRescue, formatBlame, maxProbes, notTheAnswer, probeBound, probeFinding, probeTally, probeVerdict, probeWord, rescueRule, searchBlame, unrescuedWhy, unsettledFirst, type BlameProbe, type BlameReport } from '../src/blame.js';
import { BLAME_DEFAULTS, decide, gateResult, type SprtGate } from '../src/stats.js';

/** A probe that passes `rate(i)` of `n` attempts at model call `steps[i]`. */
function probes(steps: number[], rate: (i: number) => number, n = 5, needed = 2) {
  const seen: number[] = [];
  const probe = async (callNo: number, step: number): Promise<BlameProbe> => {
    seen.push(callNo);
    const passes = rate(step - 1);
    return {
      callNo,
      step,
      passes,
      rescued: passes >= needed,
      attempts: Array.from({ length: n }, (_, i) => ({ runId: `r${callNo}-${i}`, passed: i < passes, exitCode: 0, failures: i < passes ? [] : ['x'], spent: 0, upstreamRequests: 1 })),
    };
  };
  return { probe, seen };
}

const calls = (n: number) => Array.from({ length: n }, (_, i) => 3 + i * 4);

describe('probeVerdict', () => {
  it('settles as soon as the attempts left cannot change the outcome', () => {
    expect(probeVerdict(2, 2, 5, 2)).toBe('rescued');
    expect(probeVerdict(1, 1, 5, 2)).toBe('open');
    // Four failures of five: even a pass on the last attempt leaves one, short of two.
    expect(probeVerdict(0, 4, 5, 2)).toBe('lost');
    expect(probeVerdict(0, 3, 5, 2)).toBe('open');
    expect(probeVerdict(1, 4, 5, 2)).toBe('open');
    expect(probeVerdict(1, 5, 5, 2)).toBe('lost');
    expect(probeVerdict(0, 1, 1, 1)).toBe('lost');
  });

  it('never decides differently from running every attempt', () => {
    // Every sequence of 5 outcomes: stopping at the first settled verdict agrees with the full count.
    for (let bits = 0; bits < 32; bits++) {
      const outcomes = Array.from({ length: 5 }, (_, i) => ((bits >> i) & 1) === 1);
      const full = outcomes.filter(Boolean).length >= 2 ? 'rescued' : 'lost';
      let passes = 0;
      let early: string = 'open';
      for (let done = 1; done <= 5 && early === 'open'; done++) {
        if (outcomes[done - 1]) passes++;
        early = probeVerdict(passes, done, 5, 2);
      }
      expect(early, outcomes.join()).toBe(full);
    }
  });
});

describe('searchBlame', () => {
  it('finds the last model call whose resampling rescues the run, wherever it is', async () => {
    for (let n = 1; n <= 17; n++) {
      for (let boundary = 0; boundary < n; boundary++) {
        const steps = calls(n);
        const { probe, seen } = probes(steps, (i) => (i <= boundary ? 4 : 0));
        const r = await searchBlame({ steps, probe, scan: 0 });
        expect(r.outcome).toBe('blamed');
        expect(r.blamed?.callNo, `n=${n} boundary=${boundary}`).toBe(steps[boundary]);
        expect(r.lost?.callNo ?? null).toBe(boundary + 1 < n ? steps[boundary + 1] : null);
        expect(r.confidence).toBe('high');
        expect(seen.length).toBeLessThanOrEqual(maxProbes(n, 0));
        expect(new Set(seen).size, 'no call probed twice').toBe(seen.length);
      }
    }
  });

  it('probes a run of 30 model calls about six times, not thirty', async () => {
    const steps = calls(30);
    const { probe, seen } = probes(steps, (i) => (i <= 16 ? 3 : 0));
    const r = await searchBlame({ steps, probe, scan: 2 });
    expect(r.blamed?.step).toBe(17);
    expect(seen.length).toBeLessThanOrEqual(maxProbes(30, 2));
    expect(maxProbes(30, 2)).toBe(8);
  });

  it('reports a run that no resample rescues, after one probe', async () => {
    const steps = calls(8);
    const { probe, seen } = probes(steps, () => 0);
    const r = await searchBlame({ steps, probe, scan: 2 });
    expect(r).toMatchObject({ outcome: 'unrescuable', blamed: null, confidence: 'high' });
    expect(r.lost?.callNo).toBe(steps[0]);
    expect(seen).toEqual([steps[0]]);
  });

  it('blames the last model call when resampling it still rescues the run', async () => {
    const steps = calls(6);
    const { probe } = probes(steps, () => 5);
    const r = await searchBlame({ steps, probe, scan: 2 });
    expect(r).toMatchObject({ outcome: 'blamed', lost: null, confidence: 'high' });
    expect(r.blamed?.callNo).toBe(steps[5]);
  });

  it('lowers the confidence when the call after the boundary still passes sometimes', async () => {
    const steps = calls(6);
    const { probe } = probes(steps, (i) => (i <= 2 ? 3 : i === 3 ? 1 : 0));
    const r = await searchBlame({ steps, probe, scan: 0 });
    expect(r.blamed?.step).toBe(3);
    expect(r.confidence).toBe('medium');
  });

  it('moves past a boundary that rescue crosses again, and says so', async () => {
    // Rescuable at steps 1-3, not at 4 or 5, again at 6, never after: not monotone. The binary
    // search meets the first boundary (3 | 4), and only the scan past it sees step 6.
    const steps = calls(8);
    const rescuable = new Set([0, 1, 2, 5]);
    const { probe } = probes(steps, (i) => (rescuable.has(i) ? 4 : 0));
    const scanned = await searchBlame({ steps, probe, scan: 2 });
    expect(scanned.blamed?.step).toBe(6);
    expect(scanned.confidence).toBe('low');
    expect(scanned.nonMonotone).toEqual([{ lost: steps[3], rescued: steps[5] }]);

    // Without a scan the search stops at the first boundary and has no evidence against it.
    const { probe: probe2 } = probes(steps, (i) => (rescuable.has(i) ? 4 : 0));
    const unscanned = await searchBlame({ steps, probe: probe2, scan: 0 });
    expect(unscanned.blamed?.step).toBe(3);
    expect(unscanned.confidence).toBe('high');
  });

  it('can land past a dip it never probed: binary search finds a boundary, not every one', async () => {
    const steps = calls(12);
    const rescuable = new Set([0, 1, 2, 5, 6]);
    const { probe } = probes(steps, (i) => (rescuable.has(i) ? 4 : 0));
    const r = await searchBlame({ steps, probe, scan: 2 });
    expect(r.blamed?.step).toBe(7);
    expect(r.nonMonotone).toEqual([]);
  });

  it('stops when a probe cannot run, and keeps what it found', async () => {
    const steps = calls(16);
    let left = 3;
    const inner = probes(steps, (i) => (i <= 9 ? 4 : 0));
    const r = await searchBlame({ steps, probe: (c, s) => (left-- > 0 ? inner.probe(c, s) : Promise.resolve(null)), scan: 2 });
    expect(r.outcome).toBe('stopped');
    expect(r.confidence).toBe('low');
    expect(r.probes).toHaveLength(3);
    expect(r.blamed).not.toBeNull();
  });

  it('refuses a run without model calls', async () => {
    await expect(searchBlame({ steps: [], probe: async () => null, scan: 0 })).rejects.toThrow(/no model calls/);
  });
});

describe('formatBlame', () => {
  const probe = (callNo: number, step: number, passes: number, n: number, rescued: boolean): BlameProbe => ({
    callNo,
    step,
    passes,
    rescued,
    attempts: Array.from({ length: n }, (_, i) => ({ runId: `01K5CR${callNo}${i}`.padEnd(26, '0'), passed: i < passes, exitCode: 0, failures: [], spent: 0.01, upstreamRequests: 2 })),
  });
  const base = (over: Partial<BlameReport>): BlameReport => ({
    outcome: 'blamed',
    blamed: null,
    lost: null,
    probes: [],
    nonMonotone: [],
    confidence: 'high',
    runId: '01K5CQ4N7G8M2XWQH6V3T9RB1D',
    steps: 4,
    attemptsPerProbe: 5,
    needed: 2,
    rescue: { fields: {} },
    oracle: ['exit code 0', 'issue_refund called 0 times'],
    recordedFailures: ['issue_refund called 1 time'],
    contrast: null,
    attempts: 9,
    spent: 0.09,
    upstreamRequests: 18,
    unknownModels: [],
    stopReason: null,
    warnings: [],
    ...over,
  });

  it('names the blamed call, the evidence on both sides of it, and what the model did there', () => {
    const a = probe(3, 1, 2, 3, true);
    const b = probe(11, 3, 2, 2, true);
    const c = probe(15, 4, 0, 4, false);
    const text = formatBlame(
      base({
        blamed: b,
        lost: c,
        probes: [a, b, c],
        contrast: { callNo: 11, recorded: [{ type: 'tool_call', name: 'issue_refund', input: { order_id: 'A-1042' } }], rescued: [{ type: 'text', text: 'Over the limit.' }, { type: 'tool_call', name: 'escalate', input: {} }], rescuedRunId: '01K5CR1100000000000000000' },
      }),
    );
    expect(text).toContain('The run was lost at model call #11 (3 of 4)');
    expect(text).toContain('Resampling #11 rescued 2 of 2 attempts; resampling #15, the next model call, rescued 0 of 4.');
    expect(text).toContain('Confidence: high');
    expect(text).toContain('issue_refund({"order_id":"A-1042"})');
    expect(text).toContain('"Over the limit.", escalate({})');
    expect(text).toMatch(/#11 +3 of 4 +2 of 2 passed +rescued  ◂ blamed/);
    expect(text).toContain('9 attempts · 18 upstream requests');
    expect(text).toContain('shadowlap diff 01K5CQ4N7G 01K5CR1100');
  });

  it('says what an unrescuable run means', () => {
    const text = formatBlame(base({ outcome: 'unrescuable', probes: [probe(3, 1, 0, 4, false)], lost: probe(3, 1, 0, 4, false) }));
    expect(text).toContain('Not rescued from any model call');
    expect(text).toContain('passed 0 of 4 attempts, fewer than the 2 a rescue needs');
    expect(text).toContain('--model');
    expect(text).not.toContain('Confidence');
  });

  it('says no answer lost a run whose attempts met its recorded write error again, or passed answering as it did', () => {
    const met = formatBlame(base({ outcome: 'unrescuable', probes: [probe(1, 1, 0, 4, false)], failedWrite: { name: 'post_digest', message: 'channel_not_found: #refunds', callNo: 1 } }));
    expect(met).toContain('Not rescued from any model call');
    expect(met).toContain("Every attempt from the first model call, #1, made post_digest's recorded call again and failed on its error, as the recording did: channel_not_found: #refunds.");
    expect(met).toContain("No answer of the model's lost this run: look at the tools, the harness or the command.");
    expect(met).not.toContain('--model');

    const why = "Every attempt that passed at #7 answered it as the recording did. They passed because post_digest was stubbed after the fork, and the recording failed on post_digest's error: channel_not_found: #refunds.";
    const same = formatBlame(base({ outcome: 'unrescuable', probes: [probe(1, 1, 2, 2, true), probe(7, 3, 2, 2, true)], sameAnswer: { callNo: 7, runId: '01K5CR7000000000000000000', why } }));
    expect(same).toContain(why);
    expect(same).not.toContain('Resampling from the first model call');
    expect(same).not.toContain('◂ blamed');
    expect(same).toContain('an attempt that passed: shadowlap diff 01K5CQ4N7G 01K5CR7000    shadowlap ui 01K5CR7000 --call 7');
    expect(unrescuedWhy({ probes: [], needed: 2 })).toEqual({ evidence: null, look: expect.stringContaining('--model') });
    // The same findings, as a clause for a repair's reason; none when blame found nothing that says so.
    expect(notTheAnswer({ failedWrite: { name: 'post_digest', message: 'channel_not_found: #refunds', callNo: 1 } })).toBe("every attempt failed on post_digest's recorded error (channel_not_found: #refunds)");
    expect(notTheAnswer({ sameAnswer: { callNo: 7, runId: '01K5CR7000000000000000000', why } })).toBe('every attempt that passed at #7 answered it as the recording did');
    expect(notTheAnswer({ sameAnswer: null, failedWrite: null })).toBeNull();
    expect(notTheAnswer({})).toBeNull();
  });

  it('describes a rescue that changes the request', () => {
    const fields = { model: 'claude-opus-5-5', temperature: 1 };
    expect(describeRescue(fields)).toBe('resample from the probed call on with model=claude-opus-5-5, temperature=1');
    // In the report, under the rule, broken where it would pass 80 columns.
    const text = formatBlame(base({ blamed: probe(3, 1, 3, 3, true), probes: [probe(3, 1, 3, 3, true)], rescue: { fields } }));
    expect(text).toContain('\n          resample from the probed call on with\n          model=claude-opus-5-5, temperature=1)\n');
  });
});

describe('describeBlocks', () => {
  it('shows tool calls with their arguments and the start of the text, and skips reasoning', () => {
    expect(describeBlocks([{ type: 'thinking', text: 'hmm' }, { type: 'text', text: '  Checking\nthe policy.  ' }, { type: 'tool_call', name: 'check_policy', input: { id: 7 } }])).toBe('"Checking the policy.", check_policy({"id":7})');
    expect(describeBlocks([])).toBe('(no text or tool calls)');
    expect(describeBlocks([{ type: 'text', text: 'x'.repeat(300) }], 40).length).toBeLessThanOrEqual(42);
  });
});

describe('probes decided by a gate', () => {
  const GATE: SprtGate = { kind: 'sprt', ...BLAME_DEFAULTS };
  /** A probe whose attempts came out as `outcomes`, decided by blame's gate. */
  const gated = (callNo: number, step: number, outcomes: boolean[]): BlameProbe => {
    const passes = outcomes.filter(Boolean).length;
    const decision = decide(passes, outcomes.length, GATE);
    return { callNo, step, passes, rescued: decision === 'pass', decision, gate: gateResult(GATE, outcomes, { decision }), attempts: outcomes.map((passed, i) => ({ runId: `01K5CR${callNo}${i}`.padEnd(26, '0'), passed, exitCode: 0, failures: [], spent: 0, upstreamRequests: 1 })) };
  };
  const report = (over: Partial<BlameReport>): BlameReport => ({ outcome: 'blamed', blamed: null, lost: null, probes: [], nonMonotone: [], confidence: 'high', runId: '01K5CQ4N7G8M2XWQH6V3T9RB1D', steps: 4, attemptsPerProbe: 20, needed: 2, gate: GATE, rescue: { fields: {} }, oracle: ['exit code 0'], recordedFailures: [], contrast: null, attempts: 10, spent: 0, upstreamRequests: 20, unknownModels: [], stopReason: null, warnings: [], ...over });
  /** Seven passes in twenty, never far enough either way: inconclusive at the default 20 attempts. */
  const UNSURE = [...Array(6).fill([true, false, false]).flat(), true, false] as boolean[];

  // The verdict word, the tally and the Wilson bound; the rule said once, by rescueRule. Never
  // "passes at least 60% of the time": the gate bounds its error only at its two rates.
  it('says what each probe found: its verdict, its tally and the Wilson bound', () => {
    expect(probeFinding(gated(5, 3, [true, false, true, true]), GATE)).toBe('rescued · 3 of 4 · rate >= 0.30 (95%)');
    expect(probeFinding(gated(7, 4, [false, false, false, false]), GATE)).toBe('lost · 0 of 4 · rate <= 0.49 (95%)');
    const unsure = gated(7, 4, UNSURE);
    expect(unsure.decision).toBe('inconclusive');
    expect(probeWord(unsure)).toBe('inconclusive');
    expect(probeFinding(unsure, GATE)).toBe('inconclusive · 7 of 20 · rate 0.18 to 0.57 (95%)');
    expect(probeBound(unsure, GATE)).toBe('rate 0.18 to 0.57 (95%)');
    // A probe a fixed count decided says its tally, as before.
    expect(probeFinding({ rescued: true, passes: 2, attempts: [1, 2, 3] as never }, null)).toBe('rescued · 2 of 3');
    expect(probeBound({ passes: 2, attempts: [1, 2, 3] as never }, null)).toBeNull();
    expect(rescueRule({ gate: GATE, needed: 2, attemptsPerProbe: 20 })).toBe('gate: rescue at 60%+, lost at 10%-, <= 5% risk, up to 20 attempts');
    expect(rescueRule({ gate: null, needed: 2, attemptsPerProbe: 5 })).toBe('a rescue needs 2 of 5 attempts to pass');
  });

  it('puts the Probes rule and what a probe changes on one line when it fits 80 columns, and wraps them so every line does', () => {
    const probes = [gated(2, 1, [true, true])];
    const probesOf = (text: string) => text.split('\n').slice(text.split('\n').findIndex((l) => l.startsWith('  Probes ')), text.split('\n').findIndex((l) => l.startsWith('    #')));
    // A fixed count: rule and change on one line.
    const fixed = probesOf(formatBlame(report({ gate: null, attemptsPerProbe: 5, needed: 2, probes })));
    expect(fixed).toEqual(['  Probes (a rescue needs 2 of 5 attempts to pass; resample the probed call)']);
    // A gate's rule takes a line of its own.
    expect(probesOf(formatBlame(report({ probes })))).toEqual(['  Probes (gate: rescue at 60%+, lost at 10%-, <= 5% risk, up to 20 attempts;', '          resample the probed call)']);
    // --model with a long name, and --set besides: the change wraps after a comma, under the parenthesis.
    for (const fields of [{ model: 'claude-sonnet-4-5-20250929' }, { model: 'claude-opus-5-5', temperature: 1 }, { model: 'claude-sonnet-4-5-20250929', temperature: 1, max_tokens: 4096, top_p: 0.95 }]) {
      const lines = probesOf(formatBlame(report({ probes, rescue: { fields } })));
      expect(lines.filter((l) => l.length > 80), JSON.stringify(fields)).toEqual([]);
      expect(lines.slice(1).every((l) => l.startsWith('          ') && !l.startsWith('           ')), JSON.stringify(lines)).toBe(true);
      expect(lines.join(' ').replace(/ +/g, ' ')).toBe(`  Probes (gate: rescue at 60%+, lost at 10%-, <= 5% risk, up to 20 attempts; ${describeRescue(fields)})`.replace(/ +/g, ' '));
    }
    expect(probesOf(formatBlame(report({ probes, rescue: { fields: { model: 'claude-opus-5-5', temperature: 1 } } })))).toEqual([
      '  Probes (gate: rescue at 60%+, lost at 10%-, <= 5% risk, up to 20 attempts;',
      '          resample from the probed call on with',
      '          model=claude-opus-5-5, temperature=1)',
    ]);
  });

  it('says what it decided on when attempts running at once ended after it decided', () => {
    // Two straight passes rescued; a third attempt, started before the second ended, failed after.
    const p = gated(5, 3, [true, true]);
    const late = { ...p, passes: 2, attempts: [...p.attempts, { ...p.attempts[0]!, runId: '01K5CR5900000000000000000Z', passed: false }] };
    expect(probeFinding(late, GATE)).toBe('rescued · 2 of 2 (and 1 more that ended after it decided) · rate >= 0.34 (95%)');
  });

  it('takes an inconclusive probe as not rescued, and lowers the confidence when it is the one after the boundary', async () => {
    const outcomes: Record<number, boolean[]> = { 1: [true, true], 2: [true, true], 3: UNSURE, 4: [false, false, false, false] };
    const r = await searchBlame({ steps: [1, 2, 3, 4], probe: async (callNo, step) => gated(callNo, step, outcomes[step]!), scan: 0 });
    expect(r).toMatchObject({ outcome: 'blamed', blamed: { callNo: 2 }, lost: { callNo: 3, decision: 'inconclusive' }, confidence: 'medium' });
    const text = formatBlame(report({ ...r, probes: r.probes }));
    expect(text).toContain('The re-asked call #2: rescued · 2 of 2 · rate >= 0.34 (95%); #3, the next model call: inconclusive · 7 of 20 · rate 0.18 to 0.57 (95%).');
    expect(text).toContain('Confidence: medium (#3 was inconclusive: the run was not reliably lost there)');
    // The rule, and under it what a probe changes: each line fits an 80-column terminal.
    expect(text).toContain('  Probes (gate: rescue at 60%+, lost at 10%-, <= 5% risk, up to 20 attempts;\n          resample the probed call)');
    expect(text).toMatch(/#3 +3 of 4 +7 of 20 passed · rate 0\.18 to 0\.57 \(95%\) +inconclusive/);
    expect(text).toMatch(/#2 +2 of 4 +2 of 2 passed · rate >= 0\.34 \(95%\) +rescued +◂ blamed/);
    expect(text).not.toMatch(/at least|at most|of the time/);
  });

  it('says a search that stopped reached an inconclusive probe, never that the run was lost there', () => {
    const rescued = gated(1, 1, [true, true]);
    const stopped = { outcome: 'stopped' as const, blamed: rescued, confidence: 'low' as const, stopReason: 'the budget of $0.50 is spent' };
    const unsure = gated(3, 2, UNSURE);
    const text = formatBlame(report({ ...stopped, lost: unsure, probes: [rescued, unsure] }));
    expect(text).toContain('So far: rescued up to #1, inconclusive at #3.');
    expect(text).not.toContain('lost from');
    const lost = gated(3, 2, [false, false, false, false]);
    expect(formatBlame(report({ ...stopped, lost, probes: [rescued, lost] }))).toContain('So far: rescued up to #1, lost from #3.');
  });

  it('reads a first probe that couldn\'t tell apart from one that found no rescue, at low confidence', async () => {
    const r = await searchBlame({ steps: [1, 2, 3], probe: async (callNo, step) => gated(callNo, step, step === 1 ? UNSURE : [false, false, false, false]), scan: 0 });
    expect(r).toMatchObject({ outcome: 'unrescuable', lost: { callNo: 1, decision: 'inconclusive' }, confidence: 'low' });
    const full = report({ ...r, probes: r.probes });
    expect(unsettledFirst(full)).toBe(true);
    const why = unrescuedWhy(full);
    expect(why.evidence).toBe('Resampled from the first model call, #1: inconclusive · 7 of 20 · rate 0.18 to 0.57 (95%).');
    expect(why.look).toContain('Not settled: resampled from #1, the run passes some of the time, too often to call it lost and too rarely to call it rescued');
    expect(why.look).toContain(`--gate '{"good":0.4,"max":40}'`);
    expect(why.look).not.toContain('not one unlucky answer');
    const text = formatBlame(full);
    expect(text).toContain('? Not settled from the first model call');
    expect(text).not.toContain('Not rescued from any model call');
    expect(text).toContain('Confidence: low (#1 was inconclusive)');
    // One that found the first call lost is still the finding it was.
    const lost = gated(1, 1, [false, false, false, false]);
    expect(unsettledFirst(report({ outcome: 'unrescuable', probes: [lost] }))).toBe(false);
    expect(formatBlame(report({ outcome: 'unrescuable', probes: [lost], lost }))).toContain('Not rescued from any model call');
  });

  it('reads a probe an attempt that could not be judged stopped as inconclusive, never lost, under a gate or a count', async () => {
    const why = 'judge "issued" answers yes, but it is inconclusive: not judged: the judge\'s call failed: HTTP 400';
    /** A probe whose attempts came out as `outcomes`, then one that could not be judged. */
    const undecided = (callNo: number, step: number, outcomes: boolean[], gate: SprtGate | null): BlameProbe => {
      const p = gated(callNo, step, outcomes);
      const last = { runId: `01K5CR${callNo}Z`.padEnd(26, '0'), passed: false, verdict: 'inconclusive' as const, exitCode: 0, failures: [why], spent: 0, upstreamRequests: 1 };
      return { ...p, rescued: false, decision: 'inconclusive', ...(gate ? { gate: gateResult(gate, outcomes, { decision: 'continue' }) } : { gate: null }), attempts: [...p.attempts.map((a) => ({ ...a, verdict: a.passed ? ('passed' as const) : ('failed' as const) })), last], undecided: why };
    };
    const first = undecided(1, 1, [], GATE);
    expect(probeWord(first)).toBe('inconclusive');
    expect(probeFinding(first, GATE)).toBe('inconclusive · an attempt not judged');
    expect(probeBound(first, GATE)).toBeNull();
    expect(probeFinding(undecided(1, 1, [true], null), null)).toBe('inconclusive · 1 of 1 passed, an attempt not judged');
    // The search takes it as not rescued, and says it is not settled, with why, never that no call rescues the run.
    const r = await searchBlame({ steps: [1, 2], probe: async (callNo, step) => (step === 1 ? first : gated(callNo, step, [false, false, false, false])), scan: 0 });
    expect(r).toMatchObject({ outcome: 'unrescuable', confidence: 'low' });
    const full = report({ ...r, probes: r.probes });
    expect(unsettledFirst(full)).toBe(true);
    expect(unrescuedWhy(full)).toEqual({ evidence: `Resampled from the first model call, #1: an attempt could not be judged: ${why}.`, look: 'Not settled: a check could not be decided on an attempt, so no probe can say whether resampling rescues the run. Give it what decides it (a judge that can answer, a value its condition can read), and blame again.' });
    const text = formatBlame(full);
    expect(text).toContain('? Not settled from the first model call');
    expect(text).toMatch(/#1 +1 of 4 +an attempt not judged +inconclusive/);
    expect(text).not.toMatch(/Not rescued from any model call|0 of 1|lost · /);
    // As the one after the boundary, under a fixed count: inconclusive there, not lost.
    const countedRescue = (callNo: number, step: number): BlameProbe => {
      const { decision: _decision, ...p } = gated(callNo, step, [true, true]);
      return { ...p, gate: null };
    };
    const counted = await searchBlame({ steps: [1, 2], probe: async (callNo, step) => (step === 1 ? countedRescue(callNo, step) : undecided(callNo, step, [false], null)), scan: 0 });
    expect(counted).toMatchObject({ outcome: 'blamed', blamed: { callNo: 1 }, lost: { callNo: 2 }, confidence: 'medium' });
    expect(formatBlame(report({ ...counted, gate: null, needed: 2, attemptsPerProbe: 5 }))).toContain('Resampling #1 rescued 2 of 2 attempts; #2, the next model call, was inconclusive: 0 of 1 passed, an attempt not judged.');
  });

  it('counts an attempt that could not be judged after its probe decided apart, never as one that failed', () => {
    const why = 'judge "issued" answers yes, but it is inconclusive: not judged: the judge\'s call failed: HTTP 400';
    // Two straight passes rescued; a third, started before the second ended, could not be judged after it.
    const p = gated(5, 3, [true, true]);
    const late: BlameProbe = { ...p, attempts: [...p.attempts, { runId: '01K5CR5900000000000000000Z', passed: false, verdict: 'inconclusive', exitCode: 0, failures: [why], spent: 0, upstreamRequests: 1 }] };
    expect(probeFinding(late, GATE)).toBe('rescued · 2 of 2 (and 1 more that ended after it decided) · rate >= 0.34 (95%)');
    expect(probeTally(late, ' passed')).toBe('2 of 2 passed, an attempt not judged');
    expect(formatBlame(report({ blamed: late, probes: [late] }))).toMatch(/#5 +3 of 4 +2 of 2 passed, an attempt not judged · rate >= 0\.34 \(95%\) +rescued +◂ blamed/);
    // Under a fixed count too: the tally leaves it out of the attempts that passed or failed.
    const { decision: _decision, gate: _gate, ...rest } = late;
    const counted: BlameProbe = rest;
    expect(probeFinding(counted, null)).toBe('rescued · 2 of 2, an attempt not judged');
    const text = formatBlame(report({ blamed: counted, probes: [counted], gate: null, needed: 2, attemptsPerProbe: 5 }));
    expect(text).toContain('Resampling #5 rescued 2 of 2 attempts, an attempt not judged; it is the last model call');
    expect(text).toMatch(/#5 +3 of 4 +2 of 2 passed, an attempt not judged +rescued/);
    expect(text).not.toMatch(/2 of 3|not judged passed|not judged attempts/);
  });

  it('keeps a clean boundary at high confidence: lost under the gate is lost, whatever the odd pass', async () => {
    const outcomes: Record<number, boolean[]> = { 1: [true, true], 2: [false, false, false, false] };
    const r = await searchBlame({ steps: [1, 2], probe: async (callNo, step) => gated(callNo, step, outcomes[step]!), scan: 0 });
    expect(r).toMatchObject({ blamed: { callNo: 1 }, lost: { callNo: 2, decision: 'fail' }, confidence: 'high' });
  });

  it('says why no call was blamed in the gate\'s words', () => {
    const first = gated(1, 1, [false, false, false, false]);
    expect(unrescuedWhy({ probes: [first], needed: 2, gate: GATE, sameAnswer: null, failedWrite: null }).evidence).toBe('Resampled from the first model call, #1: lost · 0 of 4 · rate <= 0.49 (95%).');
  });
});
