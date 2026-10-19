import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JUDGE_SCOPE, Store } from '@shadowlap/engine';
import { startMockGemini, turn as geminiTurn, withJudge as geminiJudge, judgeQuestion as geminiQuestion, type MockServer as GeminiMock } from '@shadowlap-testing/mock-gemini';
import { startMockOpenAI, turn as openaiTurn, withJudge as openaiJudge, judgeQuestion as openaiQuestion, type MockServer as OpenAIMock } from '@shadowlap-testing/mock-openai';
import { Sidecar } from '@shadowlap/sidecar';
import { askJudges } from '../src/judge.js';
import type { JudgeCheck } from '../src/judge-check.js';

/**
 * A judge on OpenAI and on Gemini, through the sidecar to their scripted fakes: each asked once,
 * live, in its own wire format, and answered from the recording when a replay asks the same.
 */

let openai: OpenAIMock;
let gemini: GeminiMock;

beforeAll(async () => {
  openai = await startMockOpenAI({ script: openaiJudge((q) => ({ verdict: q.material.includes('Done') ? 'yes' : 'no', reason: 'from OpenAI' }), () => ({ turn: openaiTurn('not a judge request') })) });
  gemini = await startMockGemini({ script: geminiJudge(() => ({ verdict: 'no', reason: 'from Gemini' }), () => ({ turn: geminiTurn('not a judge request') })) });
});
afterAll(async () => {
  await openai.close();
  await gemini.close();
});

const judges: JudgeCheck[] = [
  { name: 'openai', question: 'Did it finish?', of: 'output', model: 'gpt-4.1-mini', pass: 'yes' },
  { name: 'gemini', question: 'Did it apologize?', of: 'output', model: 'gemini-2.5-flash', pass: 'no' },
];

describe('a judge on OpenAI and Gemini', () => {
  it('is asked live in each provider\'s format, then answered from the recording', async () => {
    const store = Store.open(':memory:');
    const upstreams = { openai: openai.url, gemini: gemini.url };
    const sidecar = await Sidecar.start({ store, upstreams });
    try {
      const rec = sidecar.startRun({ mode: 'record', command: { argv: ['agent'], cwd: '/' } });
      const first = await askJudges(judges, { calls: [], output: 'Done.\n' }, { sidecar, store, runId: rec.runId, upstreams, env: {} });
      expect(first.notJudged).toEqual(new Map());
      expect(first.verdicts.get('openai')).toMatchObject({ verdict: 'yes', reason: 'from OpenAI', source: 'live' });
      expect(first.verdicts.get('gemini')).toMatchObject({ verdict: 'no', reason: 'from Gemini', source: 'live' });
      const o = openaiQuestion(openai.requests.at(-1)!.body)!;
      expect(o).toMatchObject({ question: 'Did it finish?', material: 'Done.\n', model: 'gpt-4.1-mini' });
      expect(o.request).toMatchObject({ temperature: 0, response_format: { type: 'json_schema' } });
      const g = geminiQuestion(gemini.requests.at(-1)!.body)!;
      expect(g).toMatchObject({ question: 'Did it apologize?', material: 'Done.\n' });
      expect(gemini.requests.at(-1)!.path).toBe('/v1beta/models/gemini-2.5-flash:generateContent');
      expect(sidecar.endRun(rec.runId, 'completed').summary.judge).toMatchObject({ calls: 2, live: 2, upstreamRequests: 2 });
      expect(store.getCalls(rec.runId).map((c) => [c.meta.scope, c.meta.provider, c.meta.judge?.check])).toEqual([
        [JUDGE_SCOPE, 'openai', 'openai'],
        [JUDGE_SCOPE, 'gemini', 'gemini'],
      ]);

      const sent = openai.requests.length + gemini.requests.length;
      const replay = sidecar.startRun({ mode: 'replay', parentRunId: rec.runId, command: { argv: ['agent'], cwd: '/' } });
      const again = await askJudges(judges, { calls: [], output: 'Done.\n' }, { sidecar, store, runId: replay.runId, upstreams: { openai: 'offline', gemini: 'offline' }, env: {} });
      expect([...again.verdicts.values()].map((v) => [v.verdict, v.source, v.cost])).toEqual([
        ['yes', 'recording', 0],
        ['no', 'recording', 0],
      ]);
      expect(openai.requests.length + gemini.requests.length).toBe(sent);
      expect(sidecar.endRun(replay.runId, 'completed').summary).toMatchObject({ total: 0, divergence: null, judge: { replayed: 2, upstreamRequests: 0 } });
    } finally {
      await sidecar.close();
      store.close();
    }
  });
});

describe('a judge that fails once', () => {
  it('is asked again, and the run keeps one judge call with both attempts', async () => {
    let failed = 0;
    const flaky = await startMockOpenAI({
      script: openaiJudge(
        () => (failed++ === 0 ? { status: 529, body: { error: { message: 'Overloaded' } } } : { verdict: 'yes', reason: 'second time' }),
        () => ({ turn: openaiTurn('not a judge request') }),
      ),
    });
    const store = Store.open(':memory:');
    const upstreams = { openai: flaky.url };
    const sidecar = await Sidecar.start({ store, upstreams });
    try {
      const run = sidecar.startRun({ mode: 'record', command: { argv: ['agent'], cwd: '/' } });
      const judged = await askJudges([judges[0]!], { calls: [], output: 'Done.' }, { sidecar, store, runId: run.runId, upstreams, env: {} });
      expect(judged.verdicts.get('openai')).toMatchObject({ verdict: 'yes', reason: 'second time', source: 'live' });
      sidecar.endRun(run.runId, 'completed');
      const [call, ...more] = store.getCalls(run.runId);
      expect(more).toEqual([]);
      expect(call!.attempts.map((a) => a.meta.status)).toEqual([529]);
      expect(call!.end).toMatchObject({ outcome: 'ok', meta: { status: 200 } });
    } finally {
      await sidecar.close();
      store.close();
      await flaky.close();
    }
  });
});
