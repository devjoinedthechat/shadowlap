import { Command } from 'commander';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { agentCallsOf, BLAME_DEFAULTS, BLAME_SCAN, blameBound, blameEstimate, blameRules, blameSteps, JUDGE_SCOPE, maxProbes, MIGRATE_SAMPLES, pinRule, PREVIEW_SAMPLES, pricedCalls, probedCalls, probeGate, REPAIR_CANDIDATES, REPAIRER_LIMITS, repairerBound, repairEstimate, SPRT_DEFAULTS, Store, type CallRecord, type RunRecord, type SprtGate } from '@shadowlap/engine';
import { makeRun } from '../../engine/test/fix-fixtures.js';
import { blameRuleOf } from '../src/blame.js';
import { blamePlan } from '../src/commands/fix-blame.js';
import { DECISIONS_SAMPLES } from '../src/decisions.js';
import { mostDecided } from '../src/repair-pick.js';
import { PROMPT_CHARS_PER_TOKEN, repairerMost } from '../src/repair.js';
import { CLAUDE_CODE_TURNS, DEFAULT_ANTHROPIC_REPAIRER, REPAIRER_ANSWER_TOKENS } from '../src/repairer.js';

/**
 * Each billed job's estimate is worked out in the engine (estimates/), so the dashboard's server, its
 * pages and the terminal UI say the same price, from the limits the CLI bounds the job by. Those the
 * engine holds a copy of until the CLI reads them from it are held equal here: the repairer's bound,
 * the samples a preview and a migration ask, blame's scan and repair's candidates. Blame's search
 * runs by the engine's rules, which its estimate prices it by: held here to what bounded the search
 * before, and to the bound blame says before it starts.
 */

let program: Command;
beforeAll(async () => {
  // main() builds the program and hands it to parseAsync; keep it instead of running it.
  const spy = vi.spyOn(Command.prototype, 'parseAsync').mockImplementation(async function (this: Command) {
    program = this;
    return this;
  });
  try {
    const { main } = await import('../src/index.js');
    await main(['node', 'shadowlap']);
  } finally {
    spy.mockRestore();
  }
}, 120_000);

/** An option's default, as `shadowlap <command> --help` shows it. */
const defaultOf = (command: string, flag: string): unknown => program.commands.find((c) => c.name() === command)?.options.find((o) => o.long === flag)?.defaultValue;

describe('the limits an estimate is worked out from', () => {
  it('bound the repairer’s answer as repair does before it asks', () => {
    expect(REPAIRER_LIMITS).toEqual({ answerTokens: REPAIRER_ANSWER_TOKENS, claudeCodeTurns: CLAUDE_CODE_TURNS, model: DEFAULT_ANTHROPIC_REPAIRER, charsPerToken: PROMPT_CHARS_PER_TOKEN });
    const prompt = { system: 'x'.repeat(5000), user: 'y'.repeat(7001) };
    const chars = prompt.system.length + prompt.user.length;
    expect(repairerBound('claude-code', chars).usd).toBe(repairerMost({ provider: 'claude-code', model: '' }, prompt));
    expect(repairerBound('anthropic', chars).usd).toBe(repairerMost({ provider: 'anthropic', model: DEFAULT_ANTHROPIC_REPAIRER }, prompt));
    expect(repairerBound('openai:gpt-5', chars).usd).toBe(repairerMost({ provider: 'openai', model: 'gpt-5' }, prompt));
    expect(repairerBound('openai:gpt-5', chars, { 'gpt-5': { input: 9, output: 9 } }).usd).toBe(repairerMost({ provider: 'openai', model: 'gpt-5' }, prompt, { 'gpt-5': { input: 9, output: 9 } }));
  });

  it('decide as many candidates as repair may: what it asks the repairer for, the most it tries, never past ⌊1/risk⌋', () => {
    expect(defaultOf('repair', '--candidates')).toBe(REPAIR_CANDIDATES);
    const run: CallRecord = { runId: 'r', callNo: 1, kind: 'api', name: 'POST /v1/messages', fingerprint: 'f', occurrence: 0, origin: 'live', effect: null, requestRef: null, meta: { model: 'claude-sonnet-5' }, at: 1, end: { runId: 'r', callNo: 1, attempt: 0, responseRef: null, outcome: 'ok', meta: { model: 'claude-sonnet-5', usage: { inputTokens: 100, outputTokens: 10 } }, at: 1 }, attempts: [] };
    const failing = [{ runId: 'r', startedAt: 1, calls: pricedCalls([run]) }];
    for (const candidates of [undefined, 1, 8]) {
      for (const risk of [0.05, 0.2, 0.3, 0.45, 0.6]) {
        const e = repairEstimate({ failing, rule: { gate: { kind: 'sprt', ...SPRT_DEFAULTS, risk } }, ...(candidates ? { candidates } : {}) });
        const most = Math.min(candidates ?? REPAIR_CANDIDATES, mostDecided(risk));
        expect(e.parts[0], `${candidates} at ${risk}`).toBe(`a new blame, then up to ${most} candidate${most === 1 ? '' : 's'}`);
      }
    }
  });

  it('take blame’s scan and the samples a preview and a migration ask as the commands do', () => {
    expect(defaultOf('blame', '--scan')).toBe(BLAME_SCAN);
    expect([PREVIEW_SAMPLES, defaultOf('decisions', '--samples')]).toEqual([DECISIONS_SAMPLES, DECISIONS_SAMPLES]);
    expect(defaultOf('migrate', '--samples')).toBe(MIGRATE_SAMPLES);
  });
});

describe('blame’s bound', () => {
  const gate: SprtGate = { kind: 'sprt', ...BLAME_DEFAULTS };
  // As parseBlame reads them: blame's gate, a lower bar as blame's own advice gives it (--gate '{"good":0.4,"max":40}'), and a fixed count (--attempts 5).
  const RULES = {
    'the blame gate': { gate, attempts: gate.max, needed: 0 },
    'a lower bar': { gate: { ...gate, good: 0.4, max: 40 }, attempts: 40, needed: 0 },
    'a fixed count': { gate: null, attempts: 5, needed: 2 },
  };
  const cases = [1, 3, 30].flatMap((steps) => Object.entries(RULES).map(([name, rule]) => ({ steps, rule, what: `${name}, ${steps} model calls` })));
  const parent: RunRecord = { runId: '01K5CQ2E8M0000000000000000', parentRunId: null, mode: 'record', status: 'failed', divergence: null, command: { argv: ['node', 'agent.mjs'], cwd: '.' }, codeVersion: null, startedAt: 1, endedAt: 2 };
  /** What blame says before it starts, as a pipe gets it. */
  const plan = (steps: number, rule: (typeof RULES)[keyof typeof RULES]) => blamePlan({ rule, fields: {}, parent, steps, argv: ['node', 'agent.mjs'] }, { scan: BLAME_SCAN, writes: 'stub' }, null).join('\n').replace(/\x1b\[[0-9;]*m/g, '');

  it('is what runBlame searches by: the most probes, each probe’s gate at its share of the risk, and the check of a call they pin', () => {
    for (const { steps, rule, what } of cases) {
      const probes = maxProbes(steps, BLAME_SCAN);
      const each = rule.gate ? probeGate(rule.gate, probes) : null;
      const runs = blameRules(steps, blameRuleOf({ ...rule, scan: BLAME_SCAN }));
      expect(runs, what).toEqual({ probes, gate: each, limit: each ? each.max : rule.attempts, pin: pinRule(each, probes) });
      // Two attempts a pair of the check, and none for a run of one call, with no next call to check it against.
      const pin = steps > 1 ? 2 * runs.pin.max : 0;
      expect(blameBound(steps, blameRuleOf({ ...rule, scan: BLAME_SCAN })), what).toEqual({ steps, probes, each: runs.limit, pin, attempts: probes * runs.limit + pin });
    }
  });

  it('is what blame says before it starts: at most so many probes and attempts, and so many more to check a call they pin', () => {
    for (const { steps, rule, what } of cases) {
      const said = /at most (\d+) probes?(?:, the \S+ risk spent across them)? and (\d+) attempts?(?:, and (\d+) more to check a call they pin)?;/.exec(plan(steps, rule));
      const b = blameBound(steps, blameRuleOf({ ...rule, scan: BLAME_SCAN }));
      expect(said && [Number(said[1]), Number(said[2]), Number(said[3] ?? 0)], what).toEqual([b.probes, b.probes * b.each, b.pin]);
    }
  });

  it('counts the model calls the search probes, a judge check’s left out, as its estimate prices them', () => {
    const store = Store.open(':memory:');
    try {
      // Four of the agent's model calls and one of a judge check's: five calls would give six probes.
      const run = makeRun(store, { calls: ['api', 'tool', 'api', 'api', 'api', { kind: 'api', scope: JUDGE_SCOPE }] });
      const calls = store.getCalls(run);
      // What blame says it probes (parseBlame), what it searches (runBlame, from the agent's calls), and what its estimate prices.
      const said = blameSteps(calls, null).map((c) => c.callNo);
      expect(said).toEqual([1, 3, 4, 5]);
      expect(blameSteps(agentCallsOf(calls), null).map((c) => c.callNo)).toEqual(said);
      expect(probedCalls(pricedCalls(calls), null).map((c) => c.callNo)).toEqual(said);
      expect(plan(said.length, RULES['the blame gate'])).toMatch(/: 4 model calls\n[^]*at most 5 probes, /);
      expect(blameEstimate(pricedCalls(calls)).parts[0]).toMatch(/^up to 5 probes of /);
    } finally {
      store.close();
    }
  });
});
