import { describe, expect, it } from 'vitest';
import { decisionStepState, emptyCounts, JUDGED_IN_RECORDED_STATE, JUDGED_LATER, judgeWords, minorityChange, minorityNotes, samplesWords, stepsAsked, unchangedRunWords, unsettledWords, WITHIN_VARIATION, type DecisionJudge, type DecisionStep } from '../src/decisions.js';
import { CLEARED, changePct, endToEndWords, tallyWords, usdOrUnknown, verifiedCount, verifiedWords } from '../src/verified-words.js';

type Step = Pick<DecisionStep, 'rank' | 'majority' | 'control' | 'sampled' | 'samples' | 'error'>;
const step = (o: Partial<Step> = {}): Step => ({ rank: null, majority: null, sampled: null, control: null, error: null, samples: { asked: 3, answered: 3, changed: 0, ranks: [0, 0, 0] }, ...o });

describe('a step as a report counts it and a page draws it', () => {
  it('names each state by the rule the counts follow', () => {
    expect(decisionStepState(step({ rank: 1, majority: 1 }))).toBe('ranked');
    expect(decisionStepState(step())).toBe('same');
    expect(decisionStepState(step({ samples: { asked: 0, answered: 0, changed: 0, ranks: [] } }))).toBe('left');
    expect(decisionStepState(step({ samples: { asked: 3, answered: 0, changed: 0, ranks: [] }, error: 'the model answered 529' }))).toBe('not-asked');
    // Changed no more often than as recorded: the model's own variation.
    expect(decisionStepState(step({ sampled: 1, control: { asked: 3, answered: 3, changed: 1, ranks: [1, 0, 0] }, samples: { asked: 3, answered: 3, changed: 1, ranks: [1, 0, 0] } }))).toBe('noise');
    // Changed, with too few answers as recorded to tell it from the model's own variation.
    expect(decisionStepState(step({ sampled: 1, control: { asked: 3, answered: 1, changed: 0, ranks: [0] }, samples: { asked: 3, answered: 3, changed: 2, ranks: [1, 1, 0] } }))).toBe('unsettled');
  });

  it('says how often its samples changed, long for a cell and the terminal, short for a narrow column', () => {
    const minority = step({ rank: 1, majority: null, control: { asked: 3, answered: 3, changed: 0, ranks: [0, 0, 0] }, samples: { asked: 3, answered: 3, changed: 1, ranks: [1, 0, 0], unjudged: 2 } });
    expect(samplesWords(minority)).toBe('in 1 of 3 samples, 0 of 3 as recorded, fewer than half: not flagged, 2 of them not judged');
    expect(samplesWords(minority, { short: true })).toBe('in 1 of 3, 0 of 3 as recorded, not flagged');
    expect(samplesWords(step({ rank: 3, majority: 3, samples: { asked: 2, answered: 2, changed: 2, ranks: [3, 3] } }))).toBe('in 2 of 2 samples');
  });

  it('words a step its control couldn’t settle, a run that changed nothing, and a change within the model’s own variation, as the CLI and Preview both say them', () => {
    const unsettled = step({ sampled: 1, control: { asked: 3, answered: 1, changed: 0, ranks: [0] }, samples: { asked: 3, answered: 3, changed: 2, ranks: [1, 1, 0] } });
    expect(unsettledWords(unsettled)).toBe("in 2 of 3 samples; 1 of 3 answered as recorded: too few to tell from the model's own variation");
    expect(unsettledWords({ ...unsettled, control: { asked: 3, answered: 0, changed: 0, ranks: [], error: 'the model\nanswered 529' } }, (t) => t.replace(/\n/g, ' '))).toBe("in 2 of 3 samples; as recorded, no answer (the model answered 529): too few to tell from the model's own variation");
    expect(WITHIN_VARIATION).toBe("within the model's own variation");
    const run = { asked: 0, steps: 2, counts: { ...emptyCounts(), untouched: 2 } };
    expect([unchangedRunWords({ ...run, asked: 2 }), unchangedRunWords(run), unchangedRunWords({ ...run, counts: { ...emptyCounts(), untouched: 1, notAsked: 1 } })]).toEqual(['the same decisions', 'the change leaves its requests as recorded', 'nothing asked']);
    // A write or stop change most samples don't show is listed, not flagged.
    expect([minorityChange({ rank: 1, majority: null }), minorityChange({ rank: 2, majority: 5 }), minorityChange({ rank: 1, majority: 1 }), minorityChange({ rank: 3, majority: null })]).toEqual([true, true, false, false]);
    expect([minorityNotes([{ rank: 1, majority: null }, { rank: 3, majority: 3 }]), minorityNotes([{ rank: 1, majority: 1 }])]).toEqual([["1 step had a write, stop or judged change in fewer than half its samples: listed, not flagged, as a model's own variation."], []]);
  });

  it('says what a preview asked, and the later steps in a few words beside the whole sentence', () => {
    const counts = { ...emptyCounts(), 1: 2, 3: 1, same: 50, noise: 3 };
    const controlled = { counts, samples: 3, runs: [{ decisions: [{ control: { asked: 3, answered: 3, changed: 0, ranks: [0, 0, 0] } }] }] };
    expect(stepsAsked(controlled)).toBe('56 steps asked, 3 samples each and as many as recorded');
    expect(stepsAsked({ counts: { ...emptyCounts(), same: 1 }, samples: 1, runs: [] })).toBe('1 step asked');
    expect(JUDGED_LATER).toBe("later steps judged in the recorded run's state");
    expect(JUDGED_IN_RECORDED_STATE.startsWith("Later steps are judged in the recorded run's state:")).toBe(true);
  });

  it('words a judge check on a text-only step as the terminal does, without colour', () => {
    const side = (status: 'passed' | 'failed' | 'inconclusive', reason: string, source: 'recording' | 'kept' | 'live', cost: number | null = null) => ({ status, verdict: status === 'passed' ? ('yes' as const) : status === 'failed' ? ('no' as const) : null, reason, source, cost, request: null });
    const judge = (o: Partial<DecisionJudge>): DecisionJudge => ({ name: 'polite', recorded: side('passed', 'polite', 'recording'), now: side('failed', 'curt', 'live', 0.0004), changed: true, ...o }) as DecisionJudge;
    expect(judgeWords(judge({}))).toBe('passed → failed · curt (judged live, <$0.001)');
    expect(judgeWords(judge({ changed: false, now: side('passed', 'polite', 'kept') }))).toBe('passed, as recorded · polite (asked before and kept, free)');
    expect(judgeWords(judge({ changed: null, now: side('inconclusive', 'not judged: no key for its provider', 'live') }))).toBe('inconclusive · not judged: no key for its provider');
  });
});

describe('how verify found the runs it took', () => {
  it('tallies a run, an attempt it could not judge apart, and a good run against its baseline', () => {
    expect(tallyWords({ passes: 12, attempts: 12, bound: 'rate >= 0.76 (95%)' })).toBe(' · 12 of 12 · rate >= 0.76 (95%)');
    expect(tallyWords({ passes: 2, attempts: 3, undecided: 'the judge could not answer' })).toBe(' · 2 of 2, attempt 3 not judged');
    expect(tallyWords({ passes: 38, attempts: 38, bound: 'drop <= 0.10 (95%)', baseline: { passes: 38, attempts: 38 } })).toBe(' · 38 of 38, baseline 38 of 38 · drop <= 0.10 (95%)');
    expect(tallyWords(null)).toBe('');
    expect(verifiedWords({ verdict: 'passed', outcome: 'kept', tally: { passes: 4, attempts: 4 } })).toBe('kept, verified · 4 of 4');
    expect(verifiedWords({ verdict: 'inconclusive', outcome: 'inconclusive', tally: null })).toBe('verified');
  });

  it('counts the runs verified end to end, and says what they cost a run end to end', () => {
    expect(verifiedCount([{ verified: true }, { verified: false }])).toBe('1 of 2 runs verified end to end');
    expect(verifiedCount([{ verified: true }])).toBe('1 of 1 run verified end to end');
    const e = { recorded: { inputTokens: 4000, outputTokens: 100, cost: 0.014 }, now: { inputTokens: 5000, outputTokens: 120, cost: 0.018 } };
    expect(endToEndWords(e)).toBe('4,000 → 5,000 input tokens (+25%) · ≈$0.014 → ≈$0.018 (+29%)');
    expect(endToEndWords({ recorded: { ...e.recorded, cost: null }, now: { ...e.now, inputTokens: 4001 } })).toBe('4,000 → 4,001 input tokens');
    expect(changePct(0, 1)).toBe('');
    expect(usdOrUnknown(null)).toBe('unknown');
    expect(CLEARED).toBe("the same decisions, no write and no check it can't read: not run end to end");
  });
});
