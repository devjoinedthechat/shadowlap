import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { classifyRun, Store } from '@shadowlap/engine';
import { message, startMockAnthropic, text, toolUse, type MockServer, type ScriptContext } from '@shadowlap-testing/mock-anthropic';
import { lastLine } from '../src/chaos.js';
import { departures, docsOf, names, SHAPES } from './json-shapes.js';

/**
 * `test --chaos` and `replay --chaos`: each error-path preset played into a fork of a golden at one
 * call, judged as a fork is, gated, and kept in the store. The agent (forecast-agent.mjs) handles a
 * failing tool, an empty answer and a failing model call, and crashes on JSON it can't parse.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const AGENT = fileURLToPath(new URL('./forecast-agent.mjs', import.meta.url));

/** The model: asks for the units and the forecast at once, alerts when the forecast says it is warm, then answers. */
function script(ctx: ScriptContext) {
  const results = ctx.request.messages.flatMap((m) => (Array.isArray(m.content) ? (m.content as Array<{ type: string; content?: unknown; is_error?: boolean }>).filter((b) => b.type === 'tool_result') : []));
  const warm = results.some((r) => typeof r.content === 'string' && /^\d+°$/.test(r.content) && Number.parseInt(r.content, 10) > 20);
  const alerted = ctx.request.messages.some((m) => Array.isArray(m.content) && (m.content as Array<{ type: string; name?: string }>).some((b) => b.type === 'tool_use' && b.name === 'send_alert'));
  if (ctx.assistantTurns === 0) return { message: message([text('Checking.'), toolUse('get_units', {}, `toolu_units_${ctx.requestNo}`), toolUse('get_forecast', { city: 'Lisbon' }, `toolu_forecast_${ctx.requestNo}`)]) };
  if (warm && !alerted) return { message: message([toolUse('send_alert', { text: 'Above 20° in Lisbon.' }, `toolu_alert_${ctx.requestNo}`)]) };
  return { message: message([text(warm ? 'It is 21° in Lisbon; the subscribers are alerted.' : 'I could not get the forecast for Lisbon.')], { stop_reason: 'end_turn' }) };
}

let mock: MockServer;
let work: string;
let recording = '';
const db = () => join(work, 'store.db');

beforeAll(async () => {
  mock = await startMockAnthropic({ script, eventDelayMs: () => 0 });
  work = mkdtempSync(join(tmpdir(), 'sl-chaos-'));
}, 30_000);
afterAll(async () => {
  await mock.close();
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

function shadowlap(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; out: string; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, '--db', db(), ...args], {
      cwd: work,
      env: { ...process.env, SHADOWLAP_UPSTREAM_ANTHROPIC: mock.url, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', SHADOWLAP_GUARD: 'off', SHADOWLAP_HOME: join(work, 'home'), AGENT_OUTBOX: join(work, 'outbox.jsonl'), ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => ((out += d.toString()), (stdout += d.toString())));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('exit', (code) => resolve({ code, out, stdout }));
  });
}
const config = (tests: Record<string, unknown>) => writeFileSync(join(work, 'shadowlap.config.json'), JSON.stringify({ tests }, null, 2));

interface PresetJson {
  preset: string;
  label: string;
  verdict: string;
  callNo: number | null;
  target: { kind: string; name: string } | null;
  passes: number;
  attempts: number;
  detail: string;
  summary: string;
  reason: string | null;
  runs: Array<{ runId: string; verdict: string; passed: boolean; exitCode: number; reason: string | null; lastLine: string | null }>;
  gate: Record<string, number>;
}
interface ReportJson {
  session: string;
  passed: number;
  failed: number;
  inconclusive: number;
  notApplicable: number;
  results: Array<{ golden: string | null; runId: string | null; outcomes: PresetJson[]; judge: { source: string; checks: string[] } | null; error: string | null; skipped: string | null }>;
}
const report = (name: string) => JSON.parse(readFileSync(join(work, name), 'utf8')) as ReportJson;
const byPreset = (r: ReportJson) => Object.fromEntries(r.results[0]!.outcomes.map((o) => [o.preset, o]));

describe('test --chaos', () => {
  it('reports each preset on a golden, and the agent that crashes on malformed JSON fails that one', async () => {
    config({});
    const rec = await shadowlap(['run', '--', process.execPath, AGENT, 'Lisbon']);
    expect(rec.code, rec.out).toBe(0);
    recording = /recording run (\w{26})/.exec(rec.out)![1]!;
    expect((await shadowlap(['pack', recording, 'goldens/forecast'])).code).toBe(0);
    writeFileSync(join(work, 'outbox.jsonl'), '');

    const r = await shadowlap(['test', 'goldens/forecast', '--chaos', '--json', 'chaos.json']);
    expect(r.code, r.out).toBe(1);
    const out = report('chaos.json');
    expect(out).toMatchObject({ passed: 5, failed: 1, inconclusive: 0, notApplicable: 0 });
    const p = byPreset(out);
    // The tool presets hit the forecast (the pure units call is the agent's own code); the provider ones, the model call that reads it.
    for (const id of ['timeout', 'empty', 'malformed', 'oversized']) expect(p[id], id).toMatchObject({ callNo: 3, target: { kind: 'tool', name: 'get_forecast' }, attempts: 1 });
    for (const id of ['429', '500']) expect(p[id], id).toMatchObject({ callNo: 4, target: { kind: 'api', name: 'POST /v1/messages' }, verdict: 'passed' });
    expect(p.timeout).toMatchObject({ verdict: 'passed', detail: 'get_forecast (#3) timed out: the agent exited 0' });
    expect(p.empty).toMatchObject({ verdict: 'passed', summary: 'answered with nothing: the agent exited 0' });
    expect(p.oversized).toMatchObject({ verdict: 'passed', summary: 'answered 1,000,000 characters: the agent exited 0' });
    expect(p.malformed).toMatchObject({ verdict: 'failed', passes: 0, attempts: 1 });
    expect(p.malformed!.detail).toMatch(/^get_forecast \(#3\) answered malformed JSON: the agent exited with code 1 \(SyntaxError: .*JSON.*\)$/);
    expect(p.malformed!.runs[0]).toMatchObject({ passed: false, exitCode: 1, lastLine: expect.stringMatching(/^SyntaxError: /) });
    // Every write after a fork is stubbed: nothing reached the outbox.
    expect(readFileSync(join(work, 'outbox.jsonl'), 'utf8')).toBe('');

    // The table: preset × outcome, under the calls they hit; a failure ends on what the agent died of.
    // docs/cli.md shows it as it is (each runtime words its JSON error its own way).
    const docs = readFileSync(fileURLToPath(new URL('../../../docs/cli.md', import.meta.url)), 'utf8');
    const sample = /^```\n(⚡ goldens\/forecast[\s\S]*?)^```/m.exec(docs)![1]!;
    const mask = (t: string) => t.replace(/SyntaxError: .*/g, 'SyntaxError: …').trimEnd();
    expect(mask(r.stdout)).toContain(mask(sample));
    expect(r.stdout).toContain('⚡ goldens/forecast: 6 error-path presets at get_forecast (#3) and model call #4');
    expect(r.stdout).toMatch(/✗ malformed JSON\s+failed\s+answered malformed JSON: the agent exited with code 1\n\s+SyntaxError: /);
    expect(r.stdout).toMatch(/✓ provider 429\s+passed\s+failed with HTTP 429: the agent exited 0/);
    expect(r.stdout).toContain('5 passed, 1 failed');

    // Kept in the store: the session, each preset, and the attempts, bundled under the golden's recording.
    const store = Store.open(db());
    try {
      const [session] = store.listChaosSessions();
      expect(session).toMatchObject({ sessionId: out.session, command: ['shadowlap', 'test', 'goldens/forecast', '--chaos', '--json', 'chaos.json'], presets: ['timeout', 'empty', 'malformed', 'oversized', '429', '500'], passed: 5, failed: 1, inconclusive: 0, interrupted: false });
      expect(session!.endedAt).not.toBeNull();
      const results = store.listChaosResults({ sessionId: out.session });
      expect(results).toHaveLength(6);
      expect(results.find((x) => x.preset === 'malformed')).toMatchObject({ golden: 'goldens/forecast', runId: recording, verdict: 'failed', callNo: 3, passes: 0, attempts: 1 });
      const attempts = store.allRuns().filter((x) => x.meta?.chaos?.session === out.session);
      expect(attempts).toHaveLength(6);
      for (const a of attempts) expect(classifyRun(a)).toMatchObject({ attemptKind: 'chaos', attemptOf: recording });
      expect(store.runCounts().attempts).toBeGreaterThanOrEqual(6);
      // And the activity feed has its line.
      expect(store.listEvents({ kinds: ['chaos.session'] })[0]).toMatchObject({ ref: out.session, data: { passed: 5, failed: 1, inconclusive: 0, notApplicable: 0, goldens: 1 } });
    } finally {
      store.close();
    }
  }, 120_000);

  it('passes every preset once the agent reads the forecast in a try', async () => {
    const r = await shadowlap(['test', 'goldens/forecast', '--chaos', '--json', 'safe.json'], { AGENT_SAFE: '1' });
    expect(r.code, r.out).toBe(0);
    expect(report('safe.json')).toMatchObject({ passed: 6, failed: 0 });
  }, 120_000);

  it('judges each attempt by chaos.expect, runs the presets asked for, and leaves out a golden with chaos off', async () => {
    // Under an oversized forecast the agent still reads 21° and alerts: a check that no alert goes out fails it.
    // It hands the model only the temperature, so no request changes: the replay stays on the recording.
    config({ 'goldens/forecast': { chaos: { presets: ['oversized', 'timeout'], expect: { tools: { send_alert: 0 } } } } });
    const r = await shadowlap(['test', 'goldens/forecast', '--chaos', '--json', 'expect.json']);
    expect(r.code, r.out).toBe(1);
    const p = byPreset(report('expect.json'));
    expect(Object.keys(p)).toEqual(['timeout', 'oversized']);
    expect(p.timeout).toMatchObject({ verdict: 'passed', summary: 'timed out: the agent exited 0, 1 check passed' });
    expect(p.oversized).toMatchObject({ verdict: 'failed', reason: 'check failed: send_alert called 0 times, but called 1 time' });

    // --presets picks from the command line; a tool no call makes leaves the tool presets nothing to hit.
    const picked = await shadowlap(['test', 'goldens/forecast', '--chaos', '--presets', 'empty,500', '--chaos-tool', 'get_tides', '--json', 'picked.json']);
    expect(picked.code, picked.out).toBe(0);
    const q = byPreset(report('picked.json'));
    expect(q.empty).toMatchObject({ verdict: 'not-applicable', callNo: null, detail: 'the recording never calls get_tides', attempts: 0 });
    // With no tool hit, the provider presets fail the first model call.
    expect(q['500']).toMatchObject({ verdict: 'passed', callNo: 1 });
    expect(picked.stdout).toMatch(/– empty result\s+not applicable\s+the recording never calls get_tides/);

    config({ 'goldens/forecast': { chaos: false } });
    const off = await shadowlap(['test', 'goldens/forecast', '--chaos', '--json', 'off.json']);
    expect(off.code, off.out).toBe(0);
    expect(report('off.json').results[0]).toMatchObject({ golden: 'goldens/forecast', outcomes: [], skipped: 'its tests entry turns the presets off ("chaos": false)' });

    // A mistake under chaos fails before anything runs, as any mistake under tests does.
    config({ 'goldens/forecast': { chaos: { presets: ['flood'] } } });
    const bad = await shadowlap(['test', 'goldens/forecast', '--chaos']);
    expect(bad.code).toBe(1);
    expect(bad.out).toContain('unknown preset "flood"');
    config({ 'goldens/forecast': { chaos: { gate: { baseline: 'history', drop: 0.1, risk: 0.05 } } } });
    expect((await shadowlap(['test', 'goldens/forecast', '--chaos'])).out).toContain("a baseline gate compares a golden with its own history, which an error-path preset doesn't have");
    expect((await shadowlap(['test', 'goldens/forecast', '--presets', 'timeout'])).out).toContain('--presets and --chaos-tool go with --chaos');
    expect((await shadowlap(['test', 'goldens/forecast', '--chaos', '--update'])).out).toContain('--chaos runs the error-path presets, not a test session');
  }, 180_000);

  it("judges each attempt by the write limits of the golden's own expect when chaos.expect doesn't say", async () => {
    // The golden's expect says the forecast is read once and no alert goes out: a path through a
    // failure may read it again, but must never alert. Under an oversized forecast it still alerts.
    config({ 'goldens/forecast': { expect: { tools: { get_forecast: 1, send_alert: 0 } }, chaos: { presets: ['timeout', 'oversized'] } } });
    const r = await shadowlap(['test', 'goldens/forecast', '--chaos', '--json', 'limits.json']);
    expect(r.code, r.out).toBe(1);
    const out = report('limits.json');
    expect(out.results[0]!.judge).toEqual({ source: 'write-limits', checks: ['send_alert called 0 times'] });
    const p = byPreset(out);
    expect(p.timeout).toMatchObject({ verdict: 'passed', summary: 'timed out: the agent exited 0, 1 check passed' });
    expect(p.oversized).toMatchObject({ verdict: 'failed', reason: 'check failed: send_alert called 0 times, but called 1 time' });
    expect(r.stdout).toContain("  checks: send_alert called 0 times (the write limits of the golden's expect)");
    expect(r.stdout).not.toContain('judged on the agent exiting 0 alone');

    // shadowlap show says what an attempt is: which preset played what in where.
    const attempt = p.oversized!.runs[0]!.runId;
    const shown = await shadowlap(['show', attempt]);
    expect(shown.stdout).toContain('an attempt of the error-path presets: oversized result at get_forecast (#3) of goldens/forecast');

    // docs/error-paths.md shows a golden whose expect lets one alert out: every attempt is held to that.
    config({ 'goldens/forecast': { expect: { tools: { send_alert: 1 } } } });
    const docs = readFileSync(fileURLToPath(new URL('../../../docs/error-paths.md', import.meta.url)), 'utf8');
    const sample = /^```\n(⚡ goldens\/forecast[\s\S]*?)^```/m.exec(docs)![1]!;
    const mask = (t: string) => t.replace(/SyntaxError: .*/g, 'SyntaxError: …').trimEnd();
    const held = await shadowlap(['test', 'goldens/forecast', '--chaos']);
    expect(held.code, held.out).toBe(1);
    expect(mask(held.stdout)).toContain(mask(sample));

    // With no expect at all, the exit status alone judged them, and test --chaos says what would say more.
    config({ 'goldens/forecast': { chaos: { presets: ['timeout'] } } });
    const plain = await shadowlap(['test', 'goldens/forecast', '--chaos', '--json', 'plain.json']);
    expect(plain.code, plain.out).toBe(0);
    expect(report('plain.json').results[0]!.judge).toEqual({ source: 'exit', checks: [] });
    expect(plain.stdout).toContain('Each preset was judged on the agent exiting 0 alone: no checks say what an error path must do.\nSay it in its tests entry, as "chaos": { "expect": {"tools":{"issue_refund":"<= 1"}} }, or as upper bounds on write tools in its "expect".');
  }, 180_000);

  it('reads a preset inconclusive, after one attempt, when its check can\'t be decided', async () => {
    // A judge on a provider with no key and no upstream can't be asked: no attempt could decide it,
    // so the preset is no failure of the agent's, and no gate runs on for it.
    const judge = { name: 'calm', question: 'Does the final answer stay calm?', model: 'gemini-2.5-flash' };
    config({ 'goldens/forecast': { chaos: { presets: ['timeout'], expect: { judge: [judge] }, gate: { good: 0.9, bad: 0.5, risk: 0.1, max: 6 } } } });
    const r = await shadowlap(['test', 'goldens/forecast', '--chaos', '--json', 'undecided.json', '--junit', 'undecided.xml'], { GEMINI_API_KEY: '', GOOGLE_API_KEY: '', SHADOWLAP_UPSTREAM_GEMINI: '' });
    expect(r.code, r.out).toBe(1);
    const out = report('undecided.json');
    const p = byPreset(out);
    expect(p.timeout).toMatchObject({ verdict: 'inconclusive', attempts: 1, passes: 0 });
    expect(p.timeout!.reason).toMatch(/^check inconclusive: judge "calm" answers yes, but not judged: /);
    // Its attempt is inconclusive too, wherever it shows: the JSON, the store and, under the default
    // --inconclusive fail, the JUnit case's failure, which lists each attempt by its own verdict.
    const [attempt] = p.timeout!.runs;
    expect(attempt).toMatchObject({ verdict: 'inconclusive', passed: false, reason: p.timeout!.reason });
    const xml = readFileSync(join(work, 'undecided.xml'), 'utf8');
    expect(xml).toContain(`<![CDATA[attempt 1 (run ${attempt!.runId}): inconclusive: check inconclusive: judge "calm" answers yes, but not judged: `);
    expect(xml).not.toContain('failed:');
    const store = Store.open(db());
    try {
      expect(store.listChaosResults({ sessionId: out.session })[0]!.data?.runs?.map((x) => x.verdict)).toEqual(['inconclusive']);
    } finally {
      store.close();
    }
  }, 180_000);

  it('gates each preset as attempts come in: a sequential test stops as soon as it can say', async () => {
    // Each pass adds ln(0.9/0.5), each failure ln(0.1/0.5); the bounds are ±ln(0.9/0.1): four passes, or two failures.
    config({ 'goldens/forecast': { chaos: { presets: ['timeout', 'malformed'], gate: { good: 0.9, bad: 0.5, risk: 0.1, max: 6 } } } });
    const r = await shadowlap(['test', 'goldens/forecast', '--chaos', '--json', 'gate.json', '--markdown', 'gate.md', '--junit', 'gate.xml']);
    expect(r.code, r.out).toBe(1);
    const p = byPreset(report('gate.json'));
    // Each preset's tally and Wilson bound; the gate's rule once, under the table.
    expect(p.timeout).toMatchObject({ verdict: 'passed', passes: 4, attempts: 4, summary: 'timed out: 4 of 4 attempts passed · rate >= 0.60 (90%)', gate: { good: 0.9, bad: 0.5, risk: 0.1, max: 6 } });
    expect(p.malformed).toMatchObject({ verdict: 'failed', passes: 0, attempts: 2 });
    const rule = 'gate: tells 90%+ from 50%- at <= 10% risk, up to 6 attempts';
    expect(r.stdout).toContain(rule);
    expect(r.stdout).not.toMatch(/at least|at most|of the time/);
    // So do the reports a CI shows: the job summary once under its table, the JSON once for the
    // recording, and each JUnit case after its tally and bound, since a CI shows each case alone.
    const md = readFileSync(join(work, 'gate.md'), 'utf8');
    expect(md).toContain('| goldens/forecast | tool timeout | passed | get_forecast (#3) timed out: 4 of 4 attempts passed · rate >= 0.60 (90%) |');
    expect(md.split(rule)).toHaveLength(2);
    expect(report('gate.json').results[0]).toMatchObject({ rule });
    const xml = readFileSync(join(work, 'gate.xml'), 'utf8');
    expect(xml).toContain(`<system-out><![CDATA[get_forecast (#3) timed out: 4 of 4 attempts passed · rate >= 0.60 (90%) · ${rule}]]></system-out>`);
    expect(xml).toMatch(/<failure message="failed: get_forecast \(#3\) answered malformed JSON: 0 of 2 attempts passed · rate &lt;= 0\.\d\d \(90%\); [^"]* · gate: tells 90%\+ from 50%- at &lt;= 10% risk, up to 6 attempts">/);
    expect(`${md}${xml}`).not.toMatch(/at least|at most|of the time/);
  }, 180_000);
});

describe('a session stopped part way', () => {
  it('keeps what finished, says it was interrupted, and exits as a shell reports the signal', async () => {
    config({});
    const result = await new Promise<{ code: number | null; out: string }>((resolve) => {
      const child = spawn(process.execPath, [CLI, '--db', db(), 'test', 'goldens/forecast', '--chaos'], {
        cwd: work,
        env: { ...process.env, SHADOWLAP_UPSTREAM_ANTHROPIC: mock.url, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', SHADOWLAP_GUARD: 'off', SHADOWLAP_HOME: join(work, 'home'), AGENT_SLEEP_MS: '400' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let sent = false;
      const listen = (d: Buffer) => {
        out += d.toString();
        // Once the second preset's replay has started, the first one has a result.
        if (!sent && (out.match(/replaying run \w{26}/g) ?? []).length >= 2) {
          sent = true;
          child.kill('SIGINT');
        }
      };
      child.stdout.on('data', listen);
      child.stderr.on('data', listen);
      child.on('exit', (code) => resolve({ code, out }));
    });
    expect(result.code, result.out).toBe(130);
    expect(result.out).toContain('interrupted: the attempt running now stops, no preset after it runs');
    const store = Store.open(db());
    try {
      const [session] = store.listChaosSessions();
      expect(session).toMatchObject({ interrupted: true });
      expect(session!.endedAt).not.toBeNull();
      const kept = store.listChaosResults({ sessionId: session!.sessionId });
      expect(kept.length).toBeGreaterThanOrEqual(1);
      expect(kept.length).toBeLessThan(6);
    } finally {
      store.close();
    }
  }, 60_000);
});

describe('replay --chaos', () => {
  it('runs the presets on any run, judged by --expect, and refuses what would change the replay with them', async () => {
    config({});
    const r = await shadowlap(['replay', recording, '--chaos', '--presets', 'timeout,malformed', '--expect', '{"tools":{"send_alert":"<= 1"}}', '--summary-json', 'replay.json']);
    expect(r.code, r.out).toBe(1);
    const out = report('replay.json');
    expect(out.results[0]).toMatchObject({ golden: null, runId: recording });
    const p = byPreset(out);
    expect(p.timeout).toMatchObject({ verdict: 'passed', summary: 'timed out: the agent exited 0, 1 check passed' });
    expect(p.malformed).toMatchObject({ verdict: 'failed' });
    expect(out.results[0]!.judge).toEqual({ source: '--expect', checks: ['send_alert called at most 1 time'] });
    expect(r.stdout).toContain(`⚡ run ${recording.slice(0, 10)}: 2 error-path presets at get_forecast (#3)`);
    expect(r.stdout).toContain('  checks: send_alert called at most 1 time (--expect)');
    const store = Store.open(db());
    try {
      const results = store.listChaosResults({ sessionId: out.session });
      expect(results.map((x) => [x.preset, x.golden, x.runId])).toEqual(expect.arrayContaining([['timeout', null, recording], ['malformed', null, recording]]));
    } finally {
      store.close();
    }
    const refused = await shadowlap(['replay', recording, '--chaos', '--fail-at', '3=timeout']);
    expect(refused.code).toBe(1);
    expect(refused.out).toContain("--chaos plays each preset in alone; it doesn't combine with --fail-at");
    // Without checks, it says what judged them.
    const plain = await shadowlap(['replay', recording, '--chaos', '--presets', 'empty']);
    expect(plain.code, plain.out).toBe(0);
    expect(plain.stdout).toContain("Each preset was judged on the agent exiting 0 alone: no checks say what an error path must do.\nSay it with --expect, such as --expect '{\"tools\":{\"issue_refund\":\"<= 1\"}}'.");

    // A command that never makes the call the preset hits plays nothing in: inconclusive, and so is its attempt, never failed.
    const never = await shadowlap(['replay', recording, '--chaos', '--presets', 'timeout', '--summary-json', 'never.json', '--', process.execPath, '-e', '']);
    expect(never.code, never.out).toBe(1);
    const n = byPreset(report('never.json'));
    expect(n.timeout).toMatchObject({ verdict: 'inconclusive', attempts: 1, passes: 0, reason: expect.stringContaining('so the preset was never played in') });
    expect(n.timeout!.runs).toEqual([expect.objectContaining({ verdict: 'inconclusive', passed: false, reason: n.timeout!.reason })]);
    expect(never.stdout).toMatch(/\? tool timeout\s+inconclusive\s+timed out: the replay/);
  }, 120_000);

  it('prints what docs/cli.md says', () => {
    const out = report('chaos.json') as unknown as Record<string, unknown> & ReportJson;
    const problems = [departures('chaos', out), departures('chaosRecording', out.results[0]), departures('chaosPreset', out.results[0]!.outcomes[0]), departures('chaosRun', out.results[0]!.outcomes[0]!.runs[0])].flatMap((d) => [...d.missing, ...d.extra]);
    expect(problems).toEqual([]);
    for (const shape of ['chaos', 'chaosRecording', 'chaosPreset', 'chaosRun'] as const) expect(SHAPES[shape].fields.filter((f) => !names(docsOf(shape), f)), shape).toEqual([]);
  });
});

describe('what an agent died of', () => {
  it('is the error it printed, not the runtime\'s lines around it', () => {
    expect(lastLine('file:///x.mjs:3\n  throw err\n  ^\n\nSyntaxError: Unexpected end of JSON input\n    at JSON.parse (<anonymous>)\n\nNode.js v22.18.0\n')).toBe('SyntaxError: Unexpected end of JSON input');
    expect(lastLine('ShadowlapInjectedFailure [TimeoutError]: get_forecast timed out\n    at call (file:///sdk.js:274:27) {\n  tool: \'get_forecast\'\n}\n')).toBe('ShadowlapInjectedFailure [TimeoutError]: get_forecast timed out');
    expect(lastLine('Traceback (most recent call last):\n  File "agent.py", line 3, in <module>\njson.decoder.JSONDecodeError: Expecting value: line 1 column 1 (char 0)\n')).toBe('json.decoder.JSONDecodeError: Expecting value: line 1 column 1 (char 0)');
    expect(lastLine('done, but exiting 2\n')).toBe('done, but exiting 2');
    expect(lastLine('[shadowlap] replaying run X\n')).toBeNull();
  });
});
