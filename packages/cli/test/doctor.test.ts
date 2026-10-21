import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { JUDGE_SCOPE, judgeAskId, packRun, Store } from '@shadowlap/engine';
import { startMockOpenAI, turn as openaiTurn, withJudge as openaiJudge, type MockServer as OpenAIMock } from '@shadowlap-testing/mock-openai';
import { Sidecar } from '@shadowlap/sidecar';
import { defaultDbPath, loadConfig, loadTests } from '../src/config.js';
import { formatDoctor, pythonCheck, runDoctor } from '../src/doctor.js';
import { askJudges } from '../src/judge.js';

const guardDir = fileURLToPath(new URL('../guard/', import.meta.url));
const plain = { green: (s: string) => s, yellow: (s: string) => s, red: (s: string) => s, dim: (s: string) => s };
let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('shadowlap doctor', () => {
  it('reports a healthy setup', () => {
    dir = mkdtempSync(join(tmpdir(), 'fp-doctor-'));
    const checks = runDoctor({ cwd: dir, env: {}, version: '0.1.0', guardDir, python: () => 'Python 3.12.1' });
    const byName = Object.fromEntries(checks.map((c) => [c.name, c]));
    expect(byName.node?.verdict).toBe('ok');
    expect(byName.sqlite?.verdict).toBe('ok');
    expect(byName['network guard']?.verdict).toBe('ok');
    expect(byName.python?.detail).toContain('3.12.1');
    expect(byName.store?.detail).toContain('not created yet');
    expect(byName.config?.detail).toContain('defaults');
    expect(byName.telemetry?.detail).toContain('on');
    expect(checks.every((c) => c.verdict === 'ok')).toBe(true);
    expect(formatDoctor(checks, plain)).toContain('everything looks fine');
  });

  it('flags old Node, a broken config, a stale active run and leaked agent environment', () => {
    dir = mkdtempSync(join(tmpdir(), 'fp-doctor-'));
    mkdirSync(join(dir, '.shadowlap'));
    writeFileSync(join(dir, 'shadowlap.config.json'), '{ "prices": { "m": { "input": "x" } } }');
    writeFileSync(join(dir, '.shadowlap', 'active.json'), JSON.stringify({ url: 'http://127.0.0.1:1/t', runId: '01STALE', pid: 2 ** 22 - 1 }));
    writeFileSync(join(dir, '.shadowlap', 'repair-journal.json'), JSON.stringify({ pid: 2 ** 22 - 1, files: [{ path: join(dir, 'agent.mjs'), original: '', patched: '' }] }));
    const store = Store.open(join(dir, '.shadowlap', 'shadowlap.db'));
    // A run its process left running two days ago, and one this process is recording: only the first is a problem.
    store.importRun({ runId: '01ABANDONED000000000000000', parentRunId: null, mode: 'record', status: 'running', divergence: null, command: { argv: ['x'], cwd: dir }, codeVersion: null, startedAt: Date.now() - 2 * 86_400_000, endedAt: null });
    store.createRun({ mode: 'record', command: { argv: ['x'], cwd: dir } });
    store.close();
    const checks = runDoctor({
      cwd: dir,
      env: { SHADOWLAP_GUARD: 'warn', NODE_OPTIONS: '--import=file:///x/guard/node-guard.mjs', SHADOWLAP_TELEMETRY: '0' },
      version: '0.1.0',
      nodeVersion: 'v20.11.0',
      guardDir: join(dir, 'nope'),
      python: () => null,
    });
    const byName = Object.fromEntries(checks.map((c) => [c.name, c]));
    expect(byName.node).toMatchObject({ verdict: 'fail' });
    expect(byName.node?.fix).toMatch(/Node ≥ 22\.13/);
    expect(byName['network guard']?.verdict).toBe('fail');
    expect(byName.python?.verdict).toBe('warn');
    expect(byName.SHADOWLAP_GUARD?.verdict).toBe('warn');
    expect(byName.config?.verdict).toBe('fail');
    expect(byName.config?.detail).toMatch(/prices\["m"\]/);
    expect(byName['active run']?.verdict).toBe('warn');
    expect(byName.repair).toMatchObject({ verdict: 'warn', detail: expect.stringContaining('agent.mjs') });
    expect(byName['runs still marked running']).toMatchObject({ verdict: 'warn', detail: '01ABANDONE', fix: expect.stringContaining('shadowlap gc marks them interrupted') });
    expect(byName.store?.detail).toMatch(/2 runs/);
    expect(byName.NODE_OPTIONS?.verdict).toBe('warn');
    expect(byName.telemetry?.detail).toContain('off');
    const text = formatDoctor(checks, plain);
    expect(text).toMatch(/\d problems?/);
    expect(text).toContain('✗ node');
  });

});

describe('the python check', () => {
  it('counts the trust marks and injection gates the config holds, and names a mistake in one', () => {
    dir = mkdtempSync(join(tmpdir(), 'fp-doctor-'));
    writeFileSync(join(dir, 'shadowlap.config.json'), JSON.stringify({ tools: { fetch_page: { trust: 'untrusted' }, read_inbox: { trust: 'untrusted' } }, tests: { 'goldens/*': { injection: { obeyed: 0 } }, 'goldens/x': { fork: true } } }));
    const config = runDoctor({ cwd: dir, env: {}, version: '0.1.0', guardDir, python: () => 'Python 3.12.1' }).find((c) => c.name === 'config')!;
    expect(config).toMatchObject({ verdict: 'ok', detail: expect.stringMatching(/: 0 normalizers, 0 redaction rules, 2 trust marks, checks for 2 recordings, 1 injection gate$/) });
    writeFileSync(join(dir, 'shadowlap.config.json'), JSON.stringify({ tools: { fetch_page: { trust: 'maybe' } } }));
    const broken = runDoctor({ cwd: dir, env: {}, version: '0.1.0', guardDir, python: () => 'Python 3.12.1' }).find((c) => c.name === 'config')!;
    expect(broken).toMatchObject({ verdict: 'fail', detail: expect.stringContaining('tools["fetch_page"].trust must be "trusted" or "untrusted"') });
  });

  it('names the command that starts Python, and says so when only python3 does', () => {
    const only = (versions: Record<string, string>) => pythonCheck((command) => versions[command] ?? null);
    expect(only({ python3: 'Python 3.14.7' })).toEqual({ found: true, detail: 'Python 3.14.7 on PATH as python3 (Python SDK and guard usable); there is no python, so start agents with python3 agent.py' });
    expect(only({ python: 'Python 3.12.1' }).detail).toBe('Python 3.12.1 on PATH as python (Python SDK and guard usable); there is no python3, so start agents with python agent.py');
    expect(only({ python3: 'Python 3.12.1', python: 'Python 3.12.1' }).detail).toBe('Python 3.12.1 on PATH as python3 and python (Python SDK and guard usable)');
    expect(only({ python3: 'Python 3.13.0', python: 'Python 2.7.18' }).detail).toBe('Python 3.13.0 as python3 and Python 2.7.18 as python on PATH (Python SDK and guard usable)');
    expect(only({})).toEqual({ found: false, detail: 'no python3 or python on PATH' });
  });
});

describe('a judge check whose model retires', () => {
  it('is named with its date, its page and what to ask instead', async () => {
    const { parseTests } = await import('../src/checks.js');
    const { judgeRetirements } = await import('../src/doctor.js');
    const judge = (model: string) => ({ name: 'explains', question: 'Does the reply say why?', model });
    const entries = parseTests({ 'goldens/a': { expect: { judge: [judge('claude-sonnet-4-5-20250929')] } }, 'goldens/b': { expect: { when: [{ if: { tool: 'x' }, then: { judge: [judge('anthropic:claude-sonnet-4-5-20250929')] } }] } }, 'goldens/c': { expect: { judge: [judge('claude-sonnet-5-5')] } } });
    const checks = judgeRetirements(entries, Date.UTC(2026, 9, 19));
    // A judge under a when is held too, named by its provider or not; one on a current model says nothing.
    expect(checks.map((c) => c.detail)).toEqual([
      'judge "explains" in tests["goldens/a"]: claude-sonnet-4-5-20250929 retires on the Claude API on November 30, 2026, in 42 days; Anthropic recommends claude-sonnet-5-5',
      'judge "explains" in tests["goldens/b"]: claude-sonnet-4-5-20250929 retires on the Claude API on November 30, 2026, in 42 days; Anthropic recommends claude-sonnet-5-5',
    ]);
    expect(checks[0]).toMatchObject({ name: 'judge model', verdict: 'warn', fix: 'Give it another model, such as claude-sonnet-5-5, then record its verdicts again: shadowlap test goldens/a --update. Source: https://platform.claude.com/docs/en/about-claude/model-deprecations' });
  });
});

describe('a judge check no judge can be asked for here', () => {
  it('is named per provider when the environment has no key for it, and not once a key or an upstream is set', async () => {
    const { parseTests } = await import('../src/checks.js');
    const { judgeKeys } = await import('../src/doctor.js');
    const judge = (name: string, model: string) => ({ name, question: 'Does the reply say why?', model });
    const entries = parseTests({
      'goldens/a': { expect: { judge: [judge('explains', 'claude-haiku-4-5'), judge('cites', 'gpt-4.1-mini')] } },
      'goldens/b': { expect: { when: [{ if: { tool: 'x' }, then: { judge: [judge('explains', 'anthropic:claude-haiku-4-5')] } }] } },
    });
    const none = judgeKeys(entries, {});
    expect(none).toEqual([
      {
        name: 'judge key',
        verdict: 'warn',
        detail: 'no key for anthropic in this environment (ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN), so judge "explains" in tests["goldens/a"] and judge "explains" in tests["goldens/b"] can\'t be asked live: packing, test --update, a golden that forks, blame, verify, repair and tasks score read each not judged (inconclusive) wherever its verdict isn\'t recorded, as a test offline does',
        fix: 'Set ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) where judges are asked, or SHADOWLAP_UPSTREAM_ANTHROPIC to a server that answers for anthropic. A clean replay of a golden that holds the verdict needs no key.',
      },
      {
        name: 'judge key',
        verdict: 'warn',
        detail: 'no key for openai in this environment (OPENAI_API_KEY), so judge "cites" in tests["goldens/a"] can\'t be asked live: packing, test --update, a golden that forks, blame, verify, repair and tasks score read it not judged (inconclusive) wherever its verdict isn\'t recorded, as a test offline does',
        fix: 'Set OPENAI_API_KEY where judges are asked, or SHADOWLAP_UPSTREAM_OPENAI to a server that answers for openai. A clean replay of a golden that holds the verdict needs no key.',
      },
    ]);
    // A key for one provider, or an upstream set for the other (a mock, a server of your own), and it can be asked.
    expect(judgeKeys(entries, { ANTHROPIC_AUTH_TOKEN: 't' }).map((c) => c.detail)).toEqual([expect.stringMatching(/^no key for openai /)]);
    expect(judgeKeys(entries, { ANTHROPIC_API_KEY: 'k', SHADOWLAP_UPSTREAM_OPENAI: 'http://127.0.0.1:9' })).toEqual([]);
    expect(judgeKeys(entries, { ANTHROPIC_API_KEY: '  ', OPENAI_API_KEY: 'k' }).map((c) => c.detail)).toEqual([expect.stringMatching(/^no key for anthropic /)]);
  });
});

describe('a golden that holds no recorded verdict for a judge check', () => {
  let mock: OpenAIMock;
  beforeAll(async () => {
    mock = await startMockOpenAI({ script: openaiJudge(() => ({ verdict: 'yes', reason: 'it says so' }), () => ({ turn: openaiTurn('not a judge request') })) });
  });
  afterAll(async () => {
    await mock.close();
  });

  it('is named with the checks it lacks and the command that records them, and so is one whose run never completed', async () => {
    dir = mkdtempSync(join(tmpdir(), 'fp-doctor-'));
    const finishes = { name: 'finishes', question: 'Did it finish?', of: 'output' as const, model: 'gpt-4.1-mini', pass: 'yes' as const };
    const sources = { ...finishes, name: 'sources', question: 'Does it name its sources?' };
    const kept = { ...finishes, name: 'kept', question: 'Did it keep the summary?' };
    const store = Store.open(':memory:');
    const sidecar = await Sidecar.start({ store, upstreams: { openai: mock.url } });
    const command = { argv: ['node', 'agent.mjs'], cwd: dir };
    try {
      // A golden asked one judge as it asks now, and another by an older form of the request.
      const research = sidecar.startRun({ mode: 'record', command });
      await askJudges([kept], { calls: [], output: 'Done.\n' }, { sidecar, store, runId: research.runId, upstreams: { openai: mock.url }, env: {} });
      const old = await fetch(`${sidecar.url}/r/${research.runId}/openai/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-shadowlap-scope': JUDGE_SCOPE, 'x-shadowlap-judge': sidecar.judgeToken, 'x-shadowlap-judge-check': 'finishes', 'x-shadowlap-judge-ask': judgeAskId(finishes), 'x-shadowlap-judge-version': '1' },
        body: JSON.stringify({ model: 'gpt-4.1-mini', messages: [{ role: 'system', content: 'Older instructions: reply with the verdict JSON.' }, { role: 'user', content: 'Question: Did it finish?\n\n<material>\nDone.\n</material>' }] }),
      });
      expect(old.status).toBe(200);
      sidecar.endRun(research.runId, 'completed');
      packRun(store, research.runId, join(dir, 'goldens', 'research'));
      // And one whose agent failed: no replay of it is ever judged.
      const broken = sidecar.startRun({ mode: 'record', command });
      sidecar.endRun(broken.runId, 'failed');
      packRun(store, broken.runId, join(dir, 'goldens', 'broken'));
    } finally {
      await sidecar.close();
      store.close();
    }
    writeFileSync(join(dir, 'shadowlap.config.json'), JSON.stringify({ tests: { 'goldens/research': { expect: { judge: [kept, finishes, sources] } }, 'goldens/broken': { expect: { judge: [kept] } }, 'goldens/plain': { expect: { tools: { send_email: 0 } } } } }));
    const { judgeVerdicts } = await import('../src/doctor.js');
    const checks = judgeVerdicts(dir, loadTests(dir), {});
    expect(checks).toEqual([
      {
        name: 'judge verdicts',
        verdict: 'warn',
        detail: 'goldens/research holds no recorded verdict for judge "sources" and only a verdict given to an older form of the judge\'s request for "finishes", which a replay no longer sends, so a test of it, which runs offline, reads them not judged (inconclusive) and fails unless --inconclusive warn',
        fix: 'Record them with OPENAI_API_KEY set: shadowlap test goldens/research --update asks the judge live once and keeps its call in the golden.',
      },
      {
        name: 'judge verdicts',
        verdict: 'warn',
        detail: 'goldens/broken holds no recorded verdict for judge "kept", and the run did not complete (its agent exited with an error), and no replay of it is judged',
        fix: 'Pack a run of it that completed, then record the verdicts: shadowlap test goldens/broken --update.',
      },
    ]);
    // With a way to ask the judge, the command alone records them.
    expect(judgeVerdicts(dir, loadTests(dir), { OPENAI_API_KEY: 'k' })[0]!.fix).toBe('Record them: shadowlap test goldens/research --update asks the judge live once and keeps its call in the golden.');

    // doctor says both, and so does its JSON.
    const all = runDoctor({ cwd: dir, env: {}, version: '0.1.0', guardDir, python: () => 'Python 3.12.1' });
    const json = JSON.parse(JSON.stringify(all)) as Array<{ name: string; verdict: string; detail: string; fix?: string }>;
    expect(json.filter((c) => c.name === 'judge verdicts').map((c) => c.detail.split(' holds ')[0])).toEqual(['goldens/research', 'goldens/broken']);
    expect(json.find((c) => c.name === 'judge key')).toMatchObject({ verdict: 'warn', detail: expect.stringContaining('no key for openai'), fix: expect.stringContaining('Set OPENAI_API_KEY') });
    expect(formatDoctor(all, plain)).toContain('! judge verdicts');
  });
});

describe('a judge check under a when', () => {
  /** A golden of tool calls alone, packed at goldens/<name>: each call with its arguments and its result. */
  function packTools(name: string, calls: Array<[tool: string, args: unknown, result: unknown]>): void {
    const store = Store.open(':memory:');
    try {
      const run = store.createRun({ mode: 'record', command: { argv: ['node', 'agent.mjs'], cwd: dir } });
      calls.forEach(([tool, args, result], i) => {
        const id = { kind: 'tool' as const, name: tool, fingerprint: (i + 1).toString(16).padStart(64, '0'), occurrence: 1 };
        store.appendCallStart({ runId: run.runId, callNo: i + 1, ...id, origin: 'live', effect: 'read', requestRef: store.putJson({ args }), meta: {}, at: i + 1 });
        store.appendCallEnd(id, { runId: run.runId, callNo: i + 1, attempt: 0, responseRef: store.putJson({ result }), outcome: 'ok', meta: {}, at: i + 1 });
      });
      store.endRun(run.runId, 'completed');
      packRun(store, run.runId, join(dir, 'goldens', name));
    } finally {
      store.close();
    }
  }

  it('wants a verdict only where its condition held in the golden: under one that never held, or can\'t be told, it is not judged at all', async () => {
    dir = mkdtempSync(join(tmpdir(), 'fp-doctor-'));
    // Packed before the judge checks were added: neither holds a verdict.
    packTools('refund', [['lookup_order', { order_id: 'A-1' }, { total: 240 }]]);
    packTools('small', [['lookup_order', { order_id: 'A-2' }, { total: 40 }]]);
    const judge = (name: string) => ({ name, question: `Does the reply ${name}?`, model: 'gpt-4.1-mini' });
    writeFileSync(
      join(dir, 'shadowlap.config.json'),
      JSON.stringify({
        tests: {
          'goldens/*': {
            expect: {
              when: [
                // No golden deletes a file: a test reads this judge not applicable in both, and --update records it nowhere.
                { if: { tool: 'delete_file' }, then: { judge: [judge('says-what-it-deleted')] } },
                // Held in refund alone: a test of it reads the judge not judged.
                { if: { tool: 'lookup_order', result: { total: { '>': 100 } } }, then: { judge: [judge('explains-escalation')] } },
                // No result has a currency, so whether it held can't be told: inconclusive whatever a judge says.
                { if: { tool: 'lookup_order', result: { currency: 'EUR' } }, then: { judge: [judge('names-the-currency')] } },
              ],
            },
          },
        },
      }),
    );
    const { judgeVerdicts } = await import('../src/doctor.js');
    expect(judgeVerdicts(dir, loadTests(dir), {})).toEqual([
      {
        name: 'judge verdicts',
        verdict: 'warn',
        detail: 'goldens/refund holds no recorded verdict for judge "explains-escalation", so a test of it, which runs offline, reads it not judged (inconclusive) and fails unless --inconclusive warn',
        fix: 'Record it with OPENAI_API_KEY set: shadowlap test goldens/refund --update asks the judge live once and keeps its call in the golden.',
      },
    ]);
    // So doctor says it of refund alone; the condition it can't read is the check rules' to name.
    const all = runDoctor({ cwd: dir, env: {}, version: '0.1.0', guardDir, python: () => 'Python 3.12.1' });
    expect(all.filter((c) => c.name === 'judge verdicts').map((c) => c.detail.split(' holds ')[0])).toEqual(['goldens/refund']);
    expect(all.find((c) => c.name === 'check rules' && c.detail.includes('result.currency'))).toMatchObject({ verdict: 'warn' });
  });
});
