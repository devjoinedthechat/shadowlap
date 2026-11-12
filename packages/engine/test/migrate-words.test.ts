import { describe, expect, it } from 'vitest';
import { codeChangeNeeded, emptyCounts, type DecisionRemedy, type MigratePasses } from '../src/decisions.js';
import { besidesLine, besidesWords, byHandNote, givenField, handOf, handWords, leftBehindLines, leftBehindSentence, leftOutInFile, leftOutNote, migrateApplyProblem, migrateCostLines, migrateHeadline, namedInSentence, noChangeWords, notVerifiedYet, onlyTheModel, remedyText, staysWords, verifyFlagsLine, type MigrateApplyInput } from '../src/migrate-words.js';

/**
 * A migration's report in words, the same wherever it shows: `shadowlap migrate`'s terminal report and
 * pull request body, `migrate apply`'s refusals, and the dashboard's Migrate page all word it here.
 */
const tick = (s: string) => `\`${s}\``;
const remedy = (field: string, o: Partial<DecisionRemedy> = {}): DecisionRemedy => ({ field, value: null, leftOut: true, renamedTo: null, why: 'refused', source: null, steps: 1, ...o });
const passes = (verdict: MigratePasses['verdict'], runs: MigratePasses['runs']): MigratePasses => ({ verdict, runs });
const kept = { verdict: 'passed', verified: true };

describe("a migration's first line", () => {
  const head = (p: MigratePasses, runs = p.runs.length) => migrateHeadline({ from: ['claude-old'], to: 'claude-new', runs, passes: p });

  it('says what the switch keeps passing, claiming only what ran', () => {
    expect(head(passes('accepted', [kept]))).toEqual({ tone: 'pass', text: 'claude-new keeps every run passing', rest: 'claude-old → claude-new, 1 run' });
    expect(head(passes('accepted', [kept, { verdict: 'failed', verified: false }]))).toMatchObject({ text: 'claude-new keeps every run that passed passing' });
    expect(head(passes('accepted', [kept, { verdict: 'passed', verified: false }]))).toMatchObject({ text: 'claude-new keeps the run it verified passing' });
    expect(head(passes('accepted', [kept, kept, { verdict: 'passed', verified: false }]))).toMatchObject({ text: 'claude-new keeps the 2 runs it verified passing' });
    expect(head(passes('not-run', [{ verdict: 'passed', verified: false }]))).toEqual({ tone: 'pass', text: 'claude-new decided the same in the preview', rest: 'claude-old → claude-new, 1 run' });
  });

  it('says Inconclusive for a report that settles nothing, and that the switch breaks runs', () => {
    expect(head(passes('accepted', [kept, { verdict: 'inconclusive', verified: false }]))).toEqual({ tone: 'warn', text: 'Inconclusive', rest: 'claude-old → claude-new, 2 runs, 1 inconclusive' });
    expect(head(passes('incomplete', [kept]))).toMatchObject({ tone: 'warn', text: 'Inconclusive' });
    expect(head(passes('rejected', [{ verdict: 'failed', verified: true }]))).toEqual({ tone: 'fail', text: 'claude-new breaks runs', rest: 'claude-old → claude-new, 1 run' });
  });
});

describe('what a migration reports besides', () => {
  it('counts the changes besides writes, stops and judged ones', () => {
    const judged = { rank: 5, judge: [{ changed: false }], samples: { asked: 1, answered: 1, changed: 1, ranks: [5] } };
    const open = { rank: 5, judge: [{ changed: null }], samples: { asked: 1, answered: 1, changed: 1, ranks: [5], unjudged: 1 } };
    const d = { counts: { ...emptyCounts(), 3: 1, 4: 2, 5: 2 }, runs: [{ decisions: [judged, open] }] } as unknown as Parameters<typeof besidesWords>[0];
    expect(besidesWords(d)).toBe('1 read added or removed, 2 read asked differently, 2 text only (1 judged as recorded, 1 not judged)');
    expect(besidesWords({ counts: emptyCounts(), runs: [] })).toBe('');
    expect(besidesLine(d)).toBe('besides: 1 read added or removed, 2 read asked differently, 2 text only (1 judged as recorded, 1 not judged)');
    expect(besidesLine({ counts: emptyCounts(), runs: [] })).toBe('');
  });

  it('words the lines the terminal, the pull request and the page share: no change, not verified, only the model, the flags, a given field and the costs', () => {
    expect([noChangeWords(false), noChangeWords(true)]).toEqual(['No write, stop or judged change', 'No write, stop or judged change in the steps asked']);
    expect([notVerifiedYet(['the agent asks for a key']), notVerifiedYet([])]).toEqual(['Not verified yet: the agent asks for a key', '']);
    expect([onlyTheModel('claude-new'), onlyTheModel('claude-new', tick)]).toEqual(['Only the model: claude-new', 'Only the model: `claude-new`']);
    expect([verifyFlagsLine(['--set', 'temperature=1'], tick), verifyFlagsLine([])]).toEqual(['verify takes them as: `--set temperature=1`', '']);
    expect([givenField('temperature', 1), givenField('stop', ['a'], tick)]).toEqual(['temperature=1', '`stop=["a"]`']);
    const costs = { perRun: { before: 0.04, after: 0.03 }, tokensPerRun: { before: 1200, after: 900 }, endToEnd: null, checking: { decisions: 0.01, judge: 0, verify: 0.02 } };
    expect(migrateCostLines(costs, { judged: false, unknown: [] })).toEqual([
      { label: 'per run', text: '≈$0.040 → ≈$0.030 (−25%) · 1,200 → 900 tokens' },
      { label: 'checking it', text: '≈$0.010 asking, ≈$0.020 verifying' },
    ]);
  });

  it('says what to set for each field, and what the hand still does', () => {
    expect(remedyText(remedy('temperature', { value: 1 }), tick)).toBe('leave `temperature` out (the requests were sent `temperature=1`, its default, meanwhile)');
    expect(remedyText(remedy('top_p'))).toBe('leave top_p out');
    expect(remedyText(remedy('max_tokens', { leftOut: false, renamedTo: 'max_completion_tokens' }), tick)).toBe('send `max_completion_tokens` in place of `max_tokens`, with the value it has');
    expect(remedyText(remedy('thinking', { leftOut: false, value: { type: 'adaptive' } }))).toBe('thinking = {"type":"adaptive"}');
    expect(handWords(remedy('top_p'), tick)).toBe('leave `top_p` out');
    expect(handWords(remedy('max_tokens', { leftOut: false, renamedTo: 'max_completion_tokens' }))).toBe('send max_completion_tokens in place of max_tokens');
    expect(handWords({ field: 'seed', value: 7 })).toBe('set seed to 7');
  });

  it('says what the config change takes out, and what it leaves for the hand', () => {
    expect(leftOutInFile(['temperature'])).toBe(', temperature left out');
    expect(leftOutInFile([])).toBe('');
    expect(leftOutNote(['temperature', 'top_p'], tick)).toBe('It leaves `temperature` and `top_p` out too, as What to set says.');
    expect(byHandNote([remedy('top_p')], tick)).toBe('Also leave `top_p` out, as What to set says: the patch changes the model alone.');
    expect(namedInSentence(['a.py'], ['temperature'], tick)).toBe('The model is named in `a.py`, where the config change leaves `temperature` out too.');
    expect(namedInSentence(['a.py', 'b.yaml'], [], tick)).toBe('The model is named in `a.py`, `b.yaml`.');
    // A migration kept before the patch took a field out: every field was the hand's.
    expect(handOf({ fields: [remedy('top_p')], given: { seed: 7 } })).toEqual([remedy('top_p'), { field: 'seed', value: 7, leftOut: false, renamedTo: null }]);
    expect(handOf({ fields: [remedy('top_p')], given: {}, byHand: [] })).toEqual([]);
  });

  it('names the goldens the switch leaves behind, before anything is applied', () => {
    const update = 'shadowlap test goldens/a goldens/b --update';
    expect(leftBehindLines([{ golden: 'goldens/a', callNo: 1 }, { golden: 'goldens/b', callNo: 3 }], 'claude-new', update)).toEqual(['once applied, goldens/a (#1), goldens/b (#3) diverge on $.model: they replay exactly', `re-record them under claude-new: ${update}`]);
    expect(leftBehindLines([{ golden: 'goldens/a', callNo: 1 }], 'claude-new', 'shadowlap test goldens/a --update')).toEqual(['once applied, goldens/a (#1) diverges on $.model: it replays exactly', 're-record it under claude-new: shadowlap test goldens/a --update']);
    expect(leftBehindLines([], 'claude-new', '')).toEqual([]);
    expect(leftBehindSentence([{ golden: 'goldens/a', callNo: 1 }, { golden: 'goldens/b', callNo: 3 }], 'claude-new', update, tick)).toBe(`goldens/a and goldens/b replay exactly, so each diverges on \`$.model\` once this is in: re-record them under claude-new with \`${update}\`.`);
  });
});

describe('why a migration is not applied', () => {
  const ID = 'mg-01K5CQ2E8M000000000000000A';
  const clear: MigrateApplyInput = { migrateId: ID, from: ['claude-old'], to: 'claude-new', stopReason: null, passes: passes('accepted', [kept]), configChange: { files: [{ path: 'a.py', places: 1 }] }, set: { fields: [], given: {}, byHand: [] }, files: { dir: `.shadowlap/migrations/${ID}`, patch: `.shadowlap/migrations/${ID}/config.patch` } };

  it('applies one that is all clear, whose patch is the whole switch', () => {
    expect(migrateApplyProblem(clear)).toBeNull();
    // The fields the patch took out are its own: nothing is left for the hand.
    expect(migrateApplyProblem({ ...clear, set: { fields: [remedy('temperature')], given: {}, byHand: [] } })).toBeNull();
  });

  it('refuses one that breaks runs, settles nothing, has no config change or files, or leaves a field for the hand', () => {
    expect(migrateApplyProblem({ ...clear, passes: passes('rejected', [{ verdict: 'failed', verified: true }]) })).toBe('mg-01K5CQ2E8M is not all clear: claude-new breaks runs. Nothing was changed');
    expect(migrateApplyProblem({ ...clear, passes: passes('accepted', [kept, { verdict: 'inconclusive', verified: false }]) })).toBe('mg-01K5CQ2E8M is not all clear: 1 run is inconclusive. Nothing was changed');
    expect(migrateApplyProblem({ ...clear, stopReason: 'the budget ran out' })).toBe('mg-01K5CQ2E8M is not all clear: it stopped before every step was asked: the budget ran out. Nothing was changed');
    expect(migrateApplyProblem({ ...clear, configChange: null })).toBe("mg-01K5CQ2E8M has no config change: no string in the project's code or config names claude-old, so set claude-new where your agent reads its model");
    expect(migrateApplyProblem({ ...clear, files: null })).toBe(`migrate could not write .shadowlap/migrations/${ID}/: run the migration again`);
    expect(migrateApplyProblem({ ...clear, set: { fields: [remedy('top_p')], given: { seed: 7 }, byHand: ['top_p', 'seed'] } })).toBe(`What to set says to leave top_p out and set seed to 7, which the config change can't reach: applied alone it would break runs. Change them by hand, then git apply .shadowlap/migrations/${ID}/config.patch`);
    // Kept before the patch took fields out: each remedy was the hand's.
    expect(migrateApplyProblem({ ...clear, set: { fields: [remedy('top_p')], given: {} } })).toMatch(/^What to set says to leave top_p out, which the config change can't reach/);
  });

  it('says why verify waits for the code: a field to leave out with no value, or one under another name', () => {
    expect(codeChangeNeeded([remedy('temperature', { value: 1 })], 'claude-new')).toBeNull();
    expect(codeChangeNeeded([remedy('top_p'), remedy('max_tokens', { leftOut: false, renamedTo: 'max_completion_tokens' })], 'claude-new')).toBe("verify runs your agent's code, which claude-new refuses as it stands: leave top_p out and send max_completion_tokens in place of max_tokens in your agent's requests (What to set), then verify");
  });
});

describe('why the goldens a switch leaves alone replay as recorded', () => {
  const runs = [
    { golden: 'goldens/left', diverges: { callNo: 2 } },
    { golden: 'goldens/untouched', diverges: { callNo: 1 } },
    { golden: 'goldens/forks', diverges: null, stays: 'fork' as const },
    { golden: 'goldens/other', diverges: null, stays: 'no-call' as const },
    { golden: 'goldens/other2', diverges: null, stays: 'no-call' as const },
    { golden: null, diverges: null },
  ];
  it('says it short for Apply config change’s Diverges row, and whole for migrate apply, counting only once the replay named what diverged', () => {
    expect(staysWords(runs, ['claude-old'], { short: true })).toBe('1 marked fork passes on its checks, 2 never send claude-old');
    expect(staysWords(runs, ['claude-old', 'claude-older'], { diverged: ['goldens/left'] })).toBe("1 golden marked fork passes on its checks wherever it forks, and 1 runs an agent the patch doesn't touch, and 2 never send claude-old or claude-older");
    expect(staysWords(runs.slice(0, 2), ['claude-old'])).toBe('');
  });
});
