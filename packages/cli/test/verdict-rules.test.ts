import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyCounts, NO_TOKENS, type DecisionRun, type DecisionStep, type DecisionsReport, type DecisionsVerify } from '@shadowlap/engine';
import { decisionsInconclusive, migrateExit } from '../src/commands/changes.js';
import type { MigrateReport, MigrateRunPass } from '../src/migrate.js';

/**
 * `decisions` and `migrate` exit by the engine's rules (decisionsUnsettled, migrateBreaks,
 * migrateUnsettled), the ones the dashboard's Verdicts reads a kept session by, so a preview or a
 * migration that settles nothing reads alike on both. These pin the exit status and the words of each
 * case, so neither drifts.
 */

const step = (o: Partial<DecisionStep> = {}): DecisionStep => ({ callNo: 1, step: 1, scope: null, rank: null, majority: null, changes: [], recorded: { stop: 'answer', stopReason: 'end_turn', tools: [], text: 'a' }, now: null, samples: { asked: 3, answered: 3, changed: 0, ranks: [0, 0, 0] }, model: { recorded: 'm', asked: 'n' }, tokens: { before: null, after: null }, cost: { before: null, after: null, spent: 0 }, thinkingStripped: 0, error: null, ...o });
/** A text-only step a judge check reads, whose words it could not judge in one sample: it waits on a judge. */
const waits = step({ rank: 5, majority: 5, samples: { asked: 3, answered: 3, changed: 3, ranks: [5, 5, 5], unjudged: 1 } });
/** A changed step whose request as recorded got too few answers to tell it from the model's own variation: it waits on its control. */
const uncontrolled = step({ sampled: 2, samples: { asked: 3, answered: 3, changed: 2, ranks: [2, 2, 0] }, control: { asked: 3, answered: 1, changed: 0, ranks: [0], error: 'HTTP 529' } });
const unanswered = step({ samples: { asked: 3, answered: 0, changed: 0, ranks: [] }, error: 'HTTP 529: overloaded' });

const run = (runId: string, o: Partial<DecisionRun> = {}): DecisionRun => ({ runId, golden: null, steps: 1, asked: 1, rank: null, majority: null, counts: { ...emptyCounts(), same: 1 }, cost: { before: null, after: null, spent: 0 }, tokens: { before: NO_TOKENS, after: NO_TOKENS }, thinkingStripped: 0, refused: null, decisions: [step()], warnings: [], ...o });
const verify = (o: Partial<DecisionsVerify>): DecisionsVerify => ({ verdict: 'accepted', verifyIds: [], runs: [], commands: [], spent: 0, upstreamRequests: 0, reasons: [], ...o });
const report = (runs: DecisionRun[], o: Partial<DecisionsReport> = {}) => ({ stopReason: null, flagged: [], verify: null, runs, ...o }) as DecisionsReport;


describe("a preview's rule", () => {
  it('is the one decisions exits 3 by, in its words', () => {
    const reports: DecisionsReport[] = [
      report([run('A'), run('B')]),
      report([run('A')], { stopReason: 'the budget of $0.10 is spent' }),
      report([run('A'), run('B', { asked: 0, refused: 'its first request differs in more than its system prompt and tools ($.model changed)', decisions: [] })]),
      // Every model call of a run got no answer, while the other run's did.
      report([run('A'), run('B', { asked: 0, counts: { ...emptyCounts(), notAsked: 1 }, decisions: [unanswered] })]),
      report([run('A', { steps: 2, asked: 1, counts: { ...emptyCounts(), same: 1, notAsked: 1 }, decisions: [step(), unanswered] })]),
      report([run('A', { rank: 5, counts: { ...emptyCounts(), 5: 1 }, decisions: [waits] }), run('B')]),
      report([run('A', { rank: 5, counts: { ...emptyCounts(), 5: 1 }, decisions: [waits] }), run('B', { rank: 5, counts: { ...emptyCounts(), 5: 1 }, decisions: [waits] })]),
      report([run('A', { counts: { ...emptyCounts(), notAsked: 1 }, decisions: [uncontrolled] })]),
      // A run it flags waits on nothing more: verify takes it.
      report([run('A', { rank: 1, majority: 1, decisions: [waits, uncontrolled] })], { flagged: ['A'] }),
      report([run('A', { rank: 1, majority: 1 })], { flagged: ['A'], verify: verify({ verdict: 'incomplete' }) }),
      report([run('A', { rank: 1, majority: 1 })], { flagged: ['A'], verify: verify({ verdict: 'not-run', reasons: ['it was interrupted before verify started'] }) }),
      report([run('A')], { verify: verify({ verdict: 'not-run' }) }),
    ];
    expect(reports.map((r) => decisionsInconclusive(r))).toEqual([
      null,
      'it stopped before every step was asked: the budget of $0.10 is spent',
      '1 run could not be asked',
      '1 run could not be asked',
      null,
      '1 run has a text-only change a judge check reads that could not be judged',
      '2 runs have a text-only change a judge check reads that could not be judged',
      "1 run has a changed step the request as recorded got no answer for, so it could not be told from the model's own variation",
      null,
      'verify did not settle every run it took',
      'verify did not run: it was interrupted before verify started',
      null,
    ]);
  });
});

describe("a migration's rule", () => {
  afterEach(() => vi.restoreAllMocks());

  const pass = (verdict: MigrateRunPass['verdict'], verified: boolean): MigrateRunPass => ({ runId: '01A', golden: null, verdict, outcome: verified ? 'kept' : 'unchanged', verified, tally: null });
  /** What migrate prints and exits with: why it settles nothing, with --inconclusive warn. */
  const exits = (r: MigrateReport): { status: number; why: string | null } => {
    const written: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    });
    const status = migrateExit(r);
    migrateExit(r, 'warn');
    vi.restoreAllMocks();
    const why = /lets it pass: (.*)\n$/.exec(written.join(''))?.[1] ?? null;
    return { status, why };
  };

  it('is the one migrate exits by, in its words', () => {
    const reports = [
      { stopReason: null, passes: { verdict: 'accepted', runs: [pass('passed', true), pass('passed', false)] } },
      { stopReason: null, passes: { verdict: 'rejected', runs: [pass('failed', true)] } },
      // A run verify took fails, whatever verify's verdict said.
      { stopReason: null, passes: { verdict: 'accepted', runs: [pass('failed', true)] } },
      // A run that failed as recorded, not re-run, is no run the switch broke.
      { stopReason: null, passes: { verdict: 'accepted', runs: [pass('failed', false), pass('passed', true)] } },
      { stopReason: 'the budget of $1.00 is spent', passes: { verdict: 'accepted', runs: [pass('passed', true)] } },
      { stopReason: null, passes: { verdict: 'incomplete', runs: [pass('inconclusive', true)] } },
      { stopReason: null, passes: { verdict: 'not-run', runs: [pass('inconclusive', false), pass('passed', false)] } },
      { stopReason: null, passes: { verdict: 'accepted', runs: [pass('inconclusive', false), pass('inconclusive', false)] } },
    ] as unknown as MigrateReport[];
    expect(reports.map(exits)).toEqual([
      { status: 0, why: null },
      { status: 1, why: null },
      { status: 1, why: null },
      { status: 0, why: null },
      { status: 3, why: 'it stopped before every step was asked: the budget of $1.00 is spent' },
      { status: 3, why: 'verify did not settle every run it took' },
      { status: 3, why: '1 run is inconclusive' },
      { status: 3, why: '2 runs are inconclusive' },
    ]);
  });
});
