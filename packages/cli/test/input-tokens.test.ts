import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { formatSummary, formatTokens, plain, Store, summarizeRepeats, summarizeRun, wholeInput, type CallRecord, type Usage } from '@shadowlap/engine';
import { passedLine } from '../src/commands/test-session.js';
import type { GoldenOutcome } from '../src/golden-test.js';
import { packResult } from '../src/golden-test.js';
import { describeCall, usageOf } from '../src/shared.js';

/**
 * Input tokens are one count wherever the CLI and the dashboard print them: everything the model
 * read, uncached, written to the prompt cache and read from it. `show`'s rows, `test`'s line and
 * JSON report, a replay's summary, `--repeat`'s and the dashboard's receipt all add the same three.
 */

/** 100 uncached, 200 written to the cache, 700 read from it: 1,000 input tokens. */
const USAGE: Usage = { inputTokens: 100, outputTokens: 50, cacheCreationInputTokens: 200, cacheReadInputTokens: 700 };

const run = { runId: 'R1', parentRunId: 'P', mode: 'replay' as const, status: 'completed' as const, divergence: null, command: { argv: ['node'], cwd: '' }, codeVersion: null, startedAt: 0, endedAt: 1 };
const call: CallRecord = {
  runId: 'R1',
  callNo: 1,
  kind: 'api',
  name: 'POST /v1/messages',
  fingerprint: 'f',
  occurrence: 1,
  origin: 'replayed',
  effect: null,
  requestRef: null,
  meta: {},
  at: 0,
  end: { runId: 'R1', callNo: 1, attempt: 0, responseRef: null, outcome: 'ok', meta: { usage: USAGE }, at: 0 },
  attempts: [],
};
const summary = summarizeRun(run, [call]);

let work = '';
afterAll(() => {
  if (work) rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('one count of input tokens', () => {
  it('adds what was read from the cache and what was written to it', () => {
    expect(wholeInput(USAGE)).toBe(1000);
    expect(wholeInput({ inputTokens: 7 })).toBe(7);
  });

  it('writes them as the dashboard does, with a tenth of a thousand: show’s 1.8k is the page’s 1.8k', () => {
    expect([950, 1000, 1834, 12_400, 245_600, 999_949, 999_950, 1_250_000].map(formatTokens)).toEqual(['950', '1.0k', '1.8k', '12.4k', '245.6k', '999.9k', '1.00M', '1.25M']);
  });

  it('counts them whole in a replay’s summary, one that ended early, and --repeat', () => {
    expect(formatSummary(summary, plain)).toContain('1/1 calls replayed (1 api, 0 tool), 0 upstream requests, 1.0k input tokens not re-spent');
    const early = { ...summary, divergence: { type: 'ended_early' as const, callNo: 2, kind: 'api' as const, name: 'POST /v1/messages', replayedBefore: 1, recorded: 2 } };
    expect(formatSummary(early, plain)).toContain('1.0k input tokens not re-spent');
    expect(summarizeRepeats('P', [{ runId: 'A1', exitCode: 0, summary, calls: [call] }]).tokensNotRespent).toBe(1000);
    expect(usageOf({ summary } as Parameters<typeof usageOf>[0], 1, 0).tokensNotRespent).toBe(1000);
  });

  it('counts them whole in a golden that passed, and in its JSON report', () => {
    const attempt = { ended: { summary }, checks: null, output: '', failure: null, kind: null, code: 0, interrupted: false };
    const outcome = {
      golden: 'goldens/a',
      dir: 'goldens/a',
      name: 'a',
      parent: null,
      spec: null,
      result: { spec: null, attempts: [attempt], shown: attempt, passed: 1, required: 1, failure: undefined, kind: null, verdict: 'passed', gate: null, inconclusive: 0, interrupted: false },
      failure: undefined,
      kind: null,
      seconds: 1,
      normalizers: [],
      interrupted: false,
      notes: [],
    } as unknown as GoldenOutcome;
    expect(passedLine(outcome)).toBe('1/1 replayed, 1.0k input tokens not re-spent');
    expect(packResult(outcome, { expect: null }).tokensNotRespent).toBe(1000);
  });

  it('counts them whole in each of show’s rows', () => {
    work = mkdtempSync(join(tmpdir(), 'sl-input-tokens-'));
    const store = Store.open(join(work, 'store.db'));
    try {
      const rec = store.createRun({ mode: 'record', command: { argv: ['node', 'agent.mjs'], cwd: work } });
      const c = { kind: 'api' as const, name: 'POST /v1/messages', fingerprint: 'm1', occurrence: 1 };
      store.appendCallStart({ runId: rec.runId, callNo: 1, ...c, origin: 'live', effect: null, requestRef: null, meta: { model: 'claude-opus-5' }, at: 1 });
      store.appendCallEnd(c, { runId: rec.runId, callNo: 1, attempt: 0, responseRef: null, outcome: 'ok', meta: { usage: USAGE, model: 'claude-opus-5', latencyMs: 5 }, at: 2 });
      store.endRun(rec.runId, 'completed');
      const row = describeCall(store, store.getCalls(rec.runId)[0]).join(' ');
      expect(row).toContain('1.0k→50 tok');
    } finally {
      store.close();
    }
  });
});
