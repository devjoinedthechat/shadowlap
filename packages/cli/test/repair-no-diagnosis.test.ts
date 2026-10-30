import { describe, expect, it } from 'vitest';
import { noDiagnosisWhy } from '../src/repair.js';

/** Why a repair had no passing path to learn from, as its report says it: what blame found, or did not settle. */
describe('noDiagnosisWhy', () => {
  const target = (runId: string, outcome: 'unrescuable' | 'stopped' | 'passes' | 'error', note: string | null = null) => ({ runId, outcome, callNo: null, step: null, steps: 3, rescuedRunId: null, rescuedBy: null, reused: false, recorded: null, rescued: null, note });
  const WRITE = "every attempt failed on post_digest's recorded error (channel_not_found: #refunds)";
  const SAME = 'every attempt that passed at #1 answered it as the recording did';
  const A = '01M540RX39AAAAAAAAAAAAAAAA';
  const B = '01M540RX40BBBBBBBBBBBBBBBB';

  it("says what blame found when no answer of the model's lost the runs, not to try a stronger model", () => {
    const why = noDiagnosisWhy([{ target: target(A, 'unrescuable'), notTheAnswer: WRITE }], null);
    expect(why).toBe(`${WRITE}: no answer of the model's lost the run; look at the tools, the harness or the command`);
    expect(noDiagnosisWhy([{ target: target(A, 'unrescuable'), notTheAnswer: WRITE }], 'big-model')).toBe(why);
    // The same finding for two runs is said once; different ones, each with its run.
    expect(noDiagnosisWhy([{ target: target(A, 'unrescuable'), notTheAnswer: WRITE }, { target: target(B, 'unrescuable'), notTheAnswer: WRITE }], null)).toBe(`${WRITE}: no answer of the model's lost these runs; look at the tools, the harness or the command`);
    expect(noDiagnosisWhy([{ target: target(A, 'unrescuable'), notTheAnswer: WRITE }, { target: target(B, 'unrescuable'), notTheAnswer: SAME }], null)).toBe(`01M540RX39: ${WRITE}; 01M540RX40: ${SAME}: no answer of the model's lost these runs; look at the tools, the harness or the command`);
    // A run it couldn't search beside one it did: what it found stands.
    expect(noDiagnosisWhy([{ target: target(B, 'passes', `${B.slice(0, 10)} passes its oracle when replayed`), notTheAnswer: null }, { target: target(A, 'unrescuable'), notTheAnswer: WRITE }], null)).toContain(`${WRITE}: no answer`);
  });

  it('says why when no run could be searched, and suggests a stronger model only when a search rescued nothing', () => {
    const passes = `${B.slice(0, 10)} passes its oracle when replayed (the agent exits 0), so there is no failure to blame. Say what it should have done with --expect.`;
    expect(noDiagnosisWhy([{ target: target(B, 'passes', passes), notTheAnswer: null }], null)).toBe(`no failing run could be blamed: ${passes}`);
    // A run blame searched with nothing to say for it, beside one it found a write's error in: no telling it isn't the prompt.
    const unknown = noDiagnosisWhy([{ target: target(A, 'unrescuable'), notTheAnswer: WRITE }, { target: target(B, 'unrescuable'), notTheAnswer: null }], null);
    expect(unknown).toContain('--stronger <model>');
    expect(noDiagnosisWhy([{ target: target(A, 'unrescuable'), notTheAnswer: null }], 'big-model')).toBe('neither resampling nor big-model rescued any failing run, so there is no passing path to learn from: the cause is likely in the code or the tools');
    // A search that stopped part way is no search: the run that couldn't be blamed says why.
    expect(noDiagnosisWhy([{ target: target(A, 'stopped'), notTheAnswer: null }, { target: target(B, 'passes', passes), notTheAnswer: null }], null)).toBe(`no failing run could be blamed: ${passes}`);
  });

  it('says blame did not settle a run whose first probe could not tell, never that resampling rescued nothing', () => {
    const unsettled = (runId: string) => ({ target: { ...target(runId, 'unrescuable'), unsettled: true }, notTheAnswer: null });
    expect(noDiagnosisWhy([unsettled(A)], 'big-model')).toBe('blame did not settle where the failing run was lost: its first probe could not tell whether resampling rescues it, so there is no passing path to learn from yet; shadowlap blame 01M540RX39 says what settles it');
    expect(noDiagnosisWhy([unsettled(A), unsettled(B)], null)).toBe('blame did not settle where the failing runs were lost: its first probe could not tell whether resampling rescues them, so there is no passing path to learn from yet; shadowlap blame 01M540RX39 01M540RX40 says what settles it');
    // Beside a run resampling rescued nothing in, the search found that much.
    expect(noDiagnosisWhy([unsettled(A), { target: target(B, 'unrescuable'), notTheAnswer: null }], null)).toContain('resampling rescued no failing run');
  });
});
