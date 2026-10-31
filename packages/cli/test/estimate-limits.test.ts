import { Command } from 'commander';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { BLAME_SCAN, CLEAN_GATE as ESTIMATED_CLEAN_GATE, MIGRATE_SAMPLES, PREVIEW_SAMPLES, pricedCalls, REPAIR_CANDIDATES, REPAIRER_LIMITS, repairerBound, repairEstimate, SPRT_DEFAULTS, type CallRecord } from '@shadowlap/engine';
import { DECISIONS_SAMPLES } from '../src/decisions.js';
import { CLEAN_GATE } from '../src/injection.js';
import { mostDecided } from '../src/repair-pick.js';
import { PROMPT_CHARS_PER_TOKEN, repairerMost } from '../src/repair.js';
import { CLAUDE_CODE_TURNS, DEFAULT_ANTHROPIC_REPAIRER, REPAIRER_ANSWER_TOKENS } from '../src/repairer.js';

/**
 * Each billed job's estimate is worked out in the engine (estimates/), so the dashboard's server, its
 * pages and the terminal UI say the same price, from the limits the CLI bounds the job by. Those the
 * engine holds a copy of until the CLI reads them from it are held equal here: the repairer's bound,
 * Find cause's gate, the samples a preview and a migration ask, blame's scan and repair's candidates.
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

  it('decide as many candidates as repair may: twice what it asks the repairer for, never past ⌊1/risk⌋', () => {
    expect(defaultOf('repair', '--candidates')).toBe(REPAIR_CANDIDATES);
    const run: CallRecord = { runId: 'r', callNo: 1, kind: 'api', name: 'POST /v1/messages', fingerprint: 'f', occurrence: 0, origin: 'live', effect: null, requestRef: null, meta: { model: 'claude-sonnet-5' }, at: 1, end: { runId: 'r', callNo: 1, attempt: 0, responseRef: null, outcome: 'ok', meta: { model: 'claude-sonnet-5', usage: { inputTokens: 100, outputTokens: 10 } }, at: 1 }, attempts: [] };
    for (const risk of [0.05, 0.2, 0.3, 0.45]) {
      const e = repairEstimate({ failing: [{ runId: 'r', startedAt: 1, calls: pricedCalls([run]) }], rule: { gate: { kind: 'sprt', ...SPRT_DEFAULTS, risk } } });
      expect(e.parts[0], String(risk)).toBe(`a new blame, then up to ${Math.min(2 * REPAIR_CANDIDATES, mostDecided(risk))} candidates`);
    }
  });

  it('take Find cause’s gate, blame’s scan and the samples a preview and a migration ask as the commands do', () => {
    expect(ESTIMATED_CLEAN_GATE).toEqual(CLEAN_GATE);
    expect(defaultOf('blame', '--scan')).toBe(BLAME_SCAN);
    expect([PREVIEW_SAMPLES, defaultOf('decisions', '--samples')]).toEqual([DECISIONS_SAMPLES, DECISIONS_SAMPLES]);
    expect(defaultOf('migrate', '--samples')).toBe(MIGRATE_SAMPLES);
  });
});
