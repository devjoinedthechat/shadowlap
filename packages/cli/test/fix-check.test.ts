import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkKey, fixRecords, recordBlame, recordVerdict, Store } from '@shadowlap/engine';
import { blameReport, verifyReport } from '../../engine/test/fix-fixtures.js';
import { removeTempProject, tempProject } from '../../../testing/temp-project.mjs';
import { departures } from './json-shapes.js';

/**
 * `shadowlap fix check`: an open fix given another check, its runs judged again from what they
 * recorded, nothing replayed. Nothing here reaches a model: every upstream is a closed port.
 */

const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (p: string) => { exec(sql: string): void; close(): void } };

const REFUND = { tools: { issue_refund: 0 } };
const NO_EMAIL = { tools: { send_email: 0 } };
const CLOSED = 'http://127.0.0.1:9';
const NOT_CI = Object.fromEntries(['CI', 'GITHUB_ACTIONS', 'GITLAB_CI', 'BUILDKITE', 'CIRCLECI', 'JENKINS_URL', 'TF_BUILD', 'BITBUCKET_BUILD_NUMBER'].map((k) => [k, '']));

let project: string;
let db: string;
beforeEach(() => {
  project = tempProject('sl-fix-check-');
  mkdirSync(join(project, '.shadowlap'));
  db = join(project, '.shadowlap', 'shadowlap.db');
});
afterEach(() => removeTempProject(project));

let seq = 0;
/** A recording that exited 0 after calling these tools, one after another. */
function recording(store: Store, tools: string[]): string {
  const runId = `01K8RG${String(++seq).padStart(4, '0')}${'0'.repeat(16)}`;
  store.createRun({ runId, mode: 'record', parentRunId: null, command: { argv: ['node', 'agent.mjs'], cwd: '.' }, startedAt: 1_000, meta: {} });
  tools.forEach((name, i) => {
    const identity = { kind: 'tool' as const, name, fingerprint: `f${i}`, occurrence: 0 };
    store.appendCallStart({ runId, callNo: i + 1, ...identity, origin: 'live', effect: 'write', requestRef: null, meta: {}, at: 1_000 + i });
    store.appendCallEnd(identity, { runId, callNo: i + 1, attempt: 0, responseRef: null, outcome: 'ok', meta: {}, at: 1_000 + i });
  });
  store.endRun(runId, 'completed');
  return runId;
}

/** A fix opened by blaming two runs that issued a refund, one of which also sent an email, and a good run that only sent one. */
function opened(store: Store): { fixId: string; emailed: string; quiet: string; good: string } {
  const emailed = recording(store, ['issue_refund', 'send_email']);
  const quiet = recording(store, ['issue_refund']);
  const good = recording(store, ['send_email']);
  let fixId = '';
  for (const [i, runId] of [emailed, quiet].entries()) {
    fixId = recordBlame(store, { runId, report: blameReport(runId), expect: REFUND, scope: null, command: `shadowlap blame ${runId}`, title: 'A refund issued without approval', checkText: 'issue_refund never called', at: 2_000 + i, actor: 'dana', ci: null }).fix.fixId;
  }
  store.addFixLink(fixId, 'good', good, 2_500);
  return { fixId, emailed, quiet, good };
}

interface Result {
  code: number | null;
  stdout: string;
  stderr: string;
  events: Array<Record<string, unknown>>;
}

function shadowlap(args: string[]): Promise<Result> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: project,
      env: { ...process.env, ...NOT_CI, SHADOWLAP_UPSTREAM_ANTHROPIC: CLOSED, ANTHROPIC_BASE_URL: CLOSED, OPENAI_BASE_URL: CLOSED, ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', SHADOWLAP_GUARD: 'off', SHADOWLAP_AUTHOR: 'maya@northwind.example', SHADOWLAP_EVENTS_FD: '3' },
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let events = '';
    child.stdout!.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr!.on('data', (d: Buffer) => (stderr += d.toString()));
    (child.stdio[3] as NodeJS.ReadableStream).on('data', (d: Buffer) => (events += d.toString()));
    child.on('close', (code) => resolve({ code, stdout, stderr, events: events.trim() ? events.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>) : [] }));
  });
}

/** Opens the project's store, hands it to `f`, and closes it. */
function withStore<T>(f: (store: Store) => T): T {
  const store = Store.open(db);
  try {
    return f(store);
  } finally {
    store.close();
  }
}

describe('shadowlap fix check', () => {
  it('judges the runs again, leaves out those it judges otherwise, and keeps what was made under the check before', async () => {
    const { fixId, emailed, quiet, good } = withStore(opened);
    // A verdict under the first check, rejected: it counts, and the fix stays open.
    const verifyId = withStore((s) => recordVerdict(s, { report: verifyReport([{ runId: emailed, role: 'target', pass: false }, { runId: quiet, role: 'target', pass: false }], { oracle: ['the agent exits 0', 'issue_refund never called'] }), expect: REFUND, command: 'shadowlap verify', at: 3_000 }).verdict.verifyId);

    const r = await shadowlap(['fix', 'check', fixId.slice(0, 13), '--expect', JSON.stringify(NO_EMAIL)]);
    expect(r.code).toBe(0);
    expect(r.stdout.split('\n').slice(0, 7)).toEqual([
      `✓ Changed the check of ${fixId.slice(0, 13)} · A refund issued without approval`,
      '  must: send_email never called',
      '  was:  issue_refund never called',
      expect.stringMatching(new RegExp(`^ {2}failing ✗ ${emailed.slice(0, 10)} {2}failed: send_email`)),
      `  failing ✓ ${quiet.slice(0, 10)}  passed · leaves the fix`,
      expect.stringMatching(new RegExp(`^ {2}good {4}✗ ${good.slice(0, 10)} {2}failed: .* · leaves the fix$`)),
      `! 1 verdict no longer counts for it: ${verifyId.slice(0, 13)} checked the old one`,
    ]);
    expect(r.stdout).toMatch(/\nnext: shadowlap /);
    // The drawer's way on is the fix, and its result is what --json prints.
    expect(r.events).toEqual([
      { type: 'link', label: 'Open fix', href: `#/fixes/${fixId}` },
      { type: 'result', data: expect.objectContaining({ fixId, status: 'changed', uncounted: [verifyId], left: { failing: [quiet], good: [good] } }) },
    ]);

    withStore((s) => {
      const fix = s.getFix(fixId)!;
      expect(fix.check).toEqual({ expect: NO_EMAIL, key: checkKey(NO_EMAIL), oracle: ['the agent exits 0', 'send_email called 0 times'], text: 'send_email never called' });
      const rec = fixRecords(s, fix);
      // Each check is kept, by whom and how it judged the runs; the runs it judged otherwise leave, their links kept.
      expect(rec.checks.map((c) => [c.check.key, c.actor])).toEqual([[checkKey(REFUND), 'dana'], [checkKey(NO_EMAIL), 'maya@northwind.example']]);
      expect(rec.checks[1].judged).toEqual({ failing: { [emailed]: 'failed', [quiet]: 'passed' }, good: { [good]: 'failed' } });
      expect([rec.failing, rec.good, rec.left]).toEqual([[emailed], [], { failing: [quiet], good: [good] }]);
      // The blames and the verdict stay, the verdict no longer counting: it checked the old one.
      expect(rec.blames).toHaveLength(2);
      expect(rec.standing.get(verifyId)).toMatchObject({ counts: false, why: 'old-check' });
      expect(s.listEvents({ kinds: ['fix.check'] }).map((e) => [e.ref, e.actor, e.data])).toEqual([[fixId, 'maya@northwind.example', { title: 'A refund issued without approval', check: 'send_email never called', previous: 'issue_refund never called' }]]);
    });

    // The same check again changes nothing.
    const again = await shadowlap(['fix', 'check', fixId, '--expect', JSON.stringify(NO_EMAIL), '--json']);
    expect([again.code, JSON.parse(again.stdout)]).toEqual([0, expect.objectContaining({ fixId, status: 'unchanged', runs: [], uncounted: [] })]);
    expect(withStore((s) => s.fixChecks(fixId))).toHaveLength(2);
  });

  it('prints what changed as JSON', async () => {
    const { fixId, emailed, quiet, good } = withStore(opened);
    const r = await shadowlap(['fix', 'check', fixId, '--expect', JSON.stringify(NO_EMAIL), '--json']);
    const out = JSON.parse(r.stdout) as Record<string, unknown>;
    // Held to its docs both ways, as every shape in json-shapes.ts is: the answer and each of its runs.
    for (const [shape, value] of [['fixCheck', out], ['fixCheckRun', (out.runs as unknown[])[0]]] as const) expect(departures(shape, value), shape).toEqual({ missing: [], extra: [] });
    expect(out).toMatchObject({ fixId, status: 'changed', check: { key: checkKey(NO_EMAIL) }, previous: { key: checkKey(REFUND) }, left: { failing: [quiet], good: [good] }, uncounted: [] });
    expect((out.runs as Array<Record<string, unknown>>).map((x) => [x.runId, x.role, x.outcome, x.na])).toEqual([
      [emailed, 'failing', 'failed', false],
      [quiet, 'failing', 'passed', false],
      [good, 'good', 'failed', false],
    ]);
  });

  it('refuses, with exit 2 and nothing changed, a check that would no longer be this failure, one that does not read, and one with a hidden character', async () => {
    const { fixId } = withStore(opened);
    const short = fixId.slice(0, 13);
    const passes = await shadowlap(['fix', 'check', fixId, '--expect', JSON.stringify({ tools: { escalate: 0 } })]);
    expect(passes.code).toBe(2);
    expect(passes.stderr.split('\n')[0]).toBe(`✗ None of ${short}'s failing runs fails this check as recorded, so it would no longer be this failure. Nothing changed.`);
    expect(passes.stderr).toMatch(/\n {2}failing ✓ \w+ {2}passed · leaves the fix\n/);

    const unread = await shadowlap(['fix', 'check', fixId, '--expect', '{"tool":{"send_email":0}}', '--json']);
    expect(unread.code).toBe(2);
    expect(JSON.parse(unread.stdout)).toEqual({ fixId, status: 'error', error: { message: expect.stringMatching(/^--expect/) } });

    const hidden = await shadowlap(['fix', 'check', fixId, '--expect', JSON.stringify({ tools: { send_email: { count: 1, args: { to: 'a​@example.com' } } } })]);
    expect([hidden.code, hidden.stderr]).toEqual([2, '✗ The check holds a hidden character, U+200B, at position 2 of tools.send_email.args.to: remove it. Nothing changed.\n']);
    expect(withStore((s) => [s.getFix(fixId)!.check.key, s.fixChecks(fixId).length])).toEqual([checkKey(REFUND), 1]);
  });

  it('refuses a fix that is not open, and one whose failing runs are gone from the store', async () => {
    const { fixId, emailed, quiet } = withStore(opened);
    withStore((s) => s.updateFix(fixId, { status: 'verified', verifiedAt: 3_000 }));
    const verified = await shadowlap(['fix', 'check', fixId, '--expect', JSON.stringify(NO_EMAIL)]);
    expect([verified.code, verified.stderr]).toEqual([2, `✗ ${fixId.slice(0, 13)} is verified: it keeps the check its accepted verdict counted under. Add a check to the golden that guards it instead, under "tests" in shadowlap.config.json.\n`]);

    withStore((s) => {
      s.updateFix(fixId, { status: 'open', verifiedAt: null });
      s.deleteRun(emailed);
      s.deleteRun(quiet);
    });
    const gone = await shadowlap(['fix', 'check', fixId, '--expect', JSON.stringify(NO_EMAIL)]);
    expect(gone.code).toBe(2);
    expect(gone.stderr.split('\n')[0]).toBe(`✗ None of ${fixId.slice(0, 13)}'s failing runs is left in the store to judge the check on. Nothing changed.`);
    expect(withStore((s) => s.fixChecks(fixId))).toHaveLength(1);
  });

  it('gives a fix in a store made before checks kept how they judged runs another check, and leaves out the runs it passes', async () => {
    const { fixId, emailed, quiet } = withStore(opened);
    const raw = new DatabaseSync(db);
    raw.exec(`ALTER TABLE fix_checks DROP COLUMN judged`);
    raw.close();
    expect((await shadowlap(['fix', 'check', fixId, '--expect', JSON.stringify(NO_EMAIL)])).code).toBe(0);
    withStore((s) => {
      const rec = fixRecords(s, s.getFix(fixId)!);
      expect([rec.failing, rec.left.failing]).toEqual([[emailed], [quiet]]);
    });
  });

  it('refuses a blame --expect with a hidden character before it runs anything', async () => {
    const run = withStore((s) => recording(s, ['issue_refund']));
    const r = await shadowlap(['blame', run, '--expect', JSON.stringify({ tools: { ['issue‮refund']: 0 } })]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--expect holds a hidden character, U+202E, at position 6 of a key under tools: remove it. Nothing changed.');
    expect(withStore((s) => s.listFixes())).toEqual([]);
  });
});
