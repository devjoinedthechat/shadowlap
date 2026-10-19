import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { message, startMockAnthropic, text, toolUse, type MockServer, type ScriptContext } from '@shadowlap-testing/mock-anthropic';
import { docsOf, fields, keys, names, SHAPES, type ShapeName } from './json-shapes.js';

/**
 * The JSON the CLI prints is a contract: scripts, CI and coding agents read it, and the docs list
 * its fields (json-shapes.ts). Here, the commands that make and read runs, each shape held to the
 * fields the reference names, exactly; json-contract-workflows.test.ts holds the rest. Exit
 * statuses are held to what the reference says as well.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const AGENT = fileURLToPath(new URL('./support-agent.mjs', import.meta.url));

/** The model: looks the order up, reads the policy, escalates, and says so. */
function script(ctx: ScriptContext) {
  switch (ctx.assistantTurns) {
    case 0:
      return { message: message([text('Looking the order up.'), toolUse('lookup_order', { order_id: 'A-1042' }, `toolu_lookup_${ctx.requestNo}`)]) };
    case 1:
      return { message: message([text('Reading the policy.'), toolUse('read_policy', {}, `toolu_policy_${ctx.requestNo}`)]) };
    case 2:
      return { message: message([text('Escalating: above the limit.'), toolUse('escalate', { reason: 'refund above $100' }, `toolu_escalate_${ctx.requestNo}`)]) };
    default:
      return { message: message([text('A manager will review the refund, write to ops@example.com with questions.')], { stop_reason: 'end_turn' }) };
  }
}

let mock: MockServer;
let work: string;
let recording: string;

beforeAll(async () => {
  mock = await startMockAnthropic({ script, eventDelayMs: () => 0 });
  work = mkdtempSync(join(tmpdir(), 'sl-json-contract-'));
});
afterAll(async () => {
  await mock.close();
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

function shadowlap(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; out: string; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, '--db', join(work, 'store.db'), ...args], {
      cwd: work,
      env: { ...process.env, SHADOWLAP_UPSTREAM_ANTHROPIC: mock.url, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', SHADOWLAP_GUARD: 'off', SHADOWLAP_HOME: join(work, 'home'), ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => ((out += d.toString()), (stdout += d.toString())));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('exit', (code) => resolve({ code, out, stdout }));
  });
}
const json = <T = Record<string, unknown>>(r: { stdout: string; out: string }): T => {
  try {
    return JSON.parse(r.stdout) as T;
  } catch {
    throw new Error(`not JSON:\n${r.out}`);
  }
};
const file = <T = Record<string, unknown>>(name: string): T => JSON.parse(readFileSync(join(work, name), 'utf8')) as T;

describe('the JSON the CLI prints', () => {
  it('run and replay: --summary-json, and their exit status', async () => {
    const rec = await shadowlap(['run', '--summary-json', 'run.json', '--', process.execPath, AGENT]);
    expect(rec.code, rec.out).toBe(0);
    const run = file<{ exitCode: number; summary: { runId: string; cost: object } }>('run.json');
    expect(keys(run)).toEqual(fields('summaryJson'));
    expect(keys(run.summary)).toEqual(fields('summary'));
    expect(keys(run.summary.cost)).toEqual(fields('cost'));
    recording = run.summary.runId;

    // A clean replay exits as the agent did; one whose check fails exits 1, and its summary says why.
    const clean = await shadowlap(['replay', recording, '--strict', '--summary-json', 'clean.json']);
    expect(clean.code, clean.out).toBe(0);
    expect(keys(file('clean.json'))).toEqual(fields('summaryJson'));
    const checked = await shadowlap(['replay', recording, '--expect', '{"tools":{"escalate":0}}', '--summary-json', 'checked.json']);
    expect(checked.code, checked.out).toBe(1);
    expect(keys(file('checked.json'))).toEqual(fields('replayChecks'));
    for (const c of file<{ checks: object[] }>('checked.json').checks) expect(keys(c)).toEqual(fields('checkResult'));

    const repeat = await shadowlap(['replay', recording, '--repeat', '2', '--summary-json', 'repeat.json']);
    expect(repeat.code, repeat.out).toBe(0);
    const r = file<{ attempts: object[]; report: object }>('repeat.json');
    expect(keys(r)).toEqual(fields('repeat'));
    expect(keys(r.attempts[0])).toEqual(fields('summaryJson'));
    expect(keys(r.report)).toEqual(fields('repeatReport'));

    // A fork with --strict exits 1, whatever the agent did.
    const fork = await shadowlap(['replay', recording, '--strict', '--inject', '3=Answer in one line.']);
    expect(fork.code, fork.out).toBe(1);
  }, 120_000);

  it('check: recordings judged by checks, each check with its status, and its exit status', async () => {
    // A rule that holds, one that doesn't apply, and a judge with no verdict: inconclusive, so exit 1.
    const expect_ = { calls: [{ tool: 'escalate', after: 'lookup_order' }], when: [{ if: { tool: 'issue_refund' }, then: { tools: { escalate: 0 } } }], judge: [{ name: 'polite', question: 'Is the reply polite?', model: 'claude-haiku-4-5' }] };
    const r = await shadowlap(['check', recording, '--expect', JSON.stringify(expect_), '--json']);
    expect(r.code, r.out).toBe(1);
    const report = json<{ recordings: Array<{ checks: object[] }>; counts: object }>(r);
    expect(keys(report)).toEqual(fields('check'));
    expect(keys(report.recordings[0])).toEqual(fields('checkRecording'));
    expect(keys(report.counts)).toEqual(fields('checkCounts'));
    // A judge check's has its outcome as well (checkJudge), and a reason and source once it has a verdict.
    for (const c of report.recordings[0]!.checks) expect(keys(c).filter((k) => k !== 'reason' && k !== 'source' && k !== 'judge')).toEqual(fields('checkResult'));
    const judged = report.recordings[0]!.checks.at(-1) as { judge: object };
    expect(keys(judged.judge).filter((k) => k !== 'callNo')).toEqual(fields('checkJudge').filter((k) => k !== 'callNo'));
    expect(report.recordings[0]!.checks.map((c) => (c as { status: string }).status)).toEqual(['passed', 'not-applicable', 'inconclusive']);
    // Without the judge, every recording judged passes: exit 0.
    const { judge: _judge, ...plain } = expect_;
    expect((await shadowlap(['check', recording, '--expect', JSON.stringify(plain)])).code).toBe(0);
  }, 60_000);

  it('show, ls, label, search and diff', async () => {
    const show = json<{ run: object; summary: object; calls: object[] }>(await shadowlap(['show', recording, '--json']));
    expect(keys(show)).toEqual(fields('show'));
    expect(keys(show.run)).toEqual(fields('showRun'));
    expect(keys(show.summary)).toEqual(fields('summary'));
    expect(keys(show.calls[0])).toEqual(fields('showCall'));

    const ls = json<object[]>(await shadowlap(['ls', '--json']));
    for (const run of ls) expect(keys(run)).toEqual(fields('ls'));

    expect(json(await shadowlap(['label', recording, 'good', '--json']))).toEqual({ runId: recording, labels: ['good'] });
    // No run with the labels asked for is not the same as no run at all.
    expect((await shadowlap(['ls', '--label', 'good', '--label', 'nosuch'])).out).toBe('no runs labelled good and nosuch\n');
    expect(json(await shadowlap(['ls', '--label', 'nosuch', '--json']))).toEqual([]);

    const found = await shadowlap(['search', 'escalating', '--json']);
    expect(found.code, found.out).toBe(0);
    const hits = json<object[]>(found);
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) expect(keys(h)).toEqual(fields('search'));
    // Nothing found: exit status 1, as grep, with --json too.
    const none = await shadowlap(['search', 'zebracrossing', '--json']);
    expect(none.code).toBe(1);
    expect(json(none)).toEqual([]);
    expect((await shadowlap(['search', 'zebracrossing'])).code).toBe(1);

    // The recording and its clean replay don't differ (exit 0); the fork does (exit 1).
    const runs = ls as Array<{ runId: string; parentRunId: string | null; forkedAt: object | null; repeat: object | null }>;
    const replay = runs.find((x) => x.parentRunId === recording && !x.forkedAt && !x.repeat)!;
    const fork = runs.find((x) => x.parentRunId === recording && x.forkedAt && !x.repeat)!;
    const same = await shadowlap(['diff', recording, replay.runId, '--json']);
    expect(same.code, same.out).toBe(0);
    expect(keys(json(same))).toEqual(fields('diff'));
    const differ = await shadowlap(['diff', recording, fork.runId, '--json']);
    expect(differ.code).toBe(1);
    const d = json<{ changes: object }>(differ);
    expect(keys(d)).toEqual(fields('diff'));
    expect(keys(d.changes)).toEqual(fields('diffChanges'));
  }, 60_000);

  it('normalize and redact, gc, calibrate, import and doctor', async () => {
    expect((await shadowlap(['redact', 'add', '--pattern', 'email', '--replace', '<EMAIL>'])).code).toBe(0);
    // Every number matches: the amount the order lookup returns and max_tokens stay as they are, with a rule for each.
    expect((await shadowlap(['redact', 'add', '--pattern', 'number', '--replace', '<N>'])).code).toBe(0);
    for (const list of ['normalize', 'redact']) expect(keys(json(await shadowlap([list, 'ls', '--json'])))).toEqual(fields('rules'));
    type Unmasked = { samples: object[]; remedies: object[] };
    const preview = json<{ rules: Array<{ returned: object; unmasked: Unmasked }> }>(await shadowlap(['redact', 'preview', recording, '--json']));
    expect(keys(preview)).toEqual(fields('preview'));
    expect(keys(preview.rules[0])).toEqual(fields('previewRule'));
    expect(keys(preview.rules[0]!.returned)).toEqual(fields('previewReturned'));
    const unmasked = preview.rules[1]!.unmasked;
    expect(keys(unmasked)).toEqual(fields('previewUnmasked'));
    expect(keys(unmasked.samples[0])).toEqual(fields('previewUnmaskedSample'));
    expect(keys(unmasked.remedies[0])).toEqual(fields('previewRemedy'));

    const gc = json<{ store: object; count: number }>(await shadowlap(['gc', '--older-than', '30', '--dry-run', '--json']));
    expect(keys(gc)).toEqual(fields('gc'));
    expect(keys(gc.store)).toEqual(fields('gcStore'));
    // A dry run with nothing to delete prints no command that deletes.
    const told = await shadowlap(['gc', '--older-than', '30', '--dry-run']);
    expect(told.out).toContain('dry run: nothing to delete');
    expect(told.out).not.toContain('--expect');
    // A deletion the dry run didn't list is refused, deleting nothing: exit 1.
    expect((await shadowlap(['gc', '--before', String(Date.now()), '--expect', '0-e3b0c44298fc1c14'])).code).toBe(1);

    const calibrated = await shadowlap(['calibrate', recording, '--json']);
    expect(calibrated.code, calibrated.out).toBe(0);
    expect(keys(json(calibrated))).toEqual(fields('calibrate'));

    expect((await shadowlap(['export', 'har', recording, 'run.har', '--no-redact'])).code).toBe(0);
    const imported = await shadowlap(['import', 'har', 'run.har', '--json']);
    expect(imported.code, imported.out).toBe(0);
    const im = json<{ runs: object[] }>(imported);
    expect(keys(im)).toEqual(fields('importJson'));
    expect(keys(im.runs[0])).toEqual(fields('importRun'));
    // Nothing that could be imported: exit 1, and the runs list is empty.
    writeFileSync(join(work, 'empty.har'), JSON.stringify({ log: { version: '1.2', entries: [] } }));
    const nothing = await shadowlap(['import', 'har', 'empty.har', '--json']);
    expect(nothing.code).toBe(1);
    expect(json(nothing)).toMatchObject({ runs: [] });

    expect(keys(json(await shadowlap(['init', '--json'])))).toEqual(fields('init'));

    const doctor = await shadowlap(['doctor', '--json']);
    const checks = json<Array<{ verdict: string }>>(doctor);
    for (const c of checks) expect(keys(c).filter((k) => k !== 'fix')).toEqual(fields('doctor'));
    expect(checks.every((c) => ['ok', 'warn', 'fail'].includes(c.verdict))).toBe(true);
    expect(doctor.code).toBe(checks.some((c) => c.verdict === 'fail') ? 1 : 0);
  }, 120_000);
});

describe('the docs', () => {
  it('name every field of every shape, in the section that lists its command\'s JSON', () => {
    const missing = (Object.keys(SHAPES) as ShapeName[]).flatMap((shape) => {
      const docs = docsOf(shape);
      return SHAPES[shape].fields.filter((f) => !names(docs, f)).map((f) => `${shape}.${f} (docs/${'page' in SHAPES[shape] ? (SHAPES[shape] as { page: string }).page : 'cli.md'}, ${SHAPES[shape].section})`);
    });
    expect(missing).toEqual([]);
  });
});
