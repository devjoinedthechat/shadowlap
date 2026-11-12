import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { startMockAnthropic, type MockServer } from '@shadowlap-testing/mock-anthropic';
import { referenceScript } from '@shadowlap-testing/reference-agent';
import { modelMentions, type ConfigChange } from '../src/migrate-mentions.js';
import { departures } from './json-shapes.js';

/**
 * `shadowlap migrate apply` through the CLI: a project whose agent reads its model from
 * agent.config.json (config-agent.mjs), two goldens recorded on the model that retires, one of them
 * marked fork, and migrations kept in the store as `migrate` keeps them, its config change written
 * where `migrate` writes it. Nothing here asks a model: the goldens replay offline.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const AGENT = fileURLToPath(new URL('../../../testing/reference-agent/dist/main.js', import.meta.url));
const CONFIG_AGENT = fileURLToPath(new URL('./config-agent.mjs', import.meta.url));
const FROM = 'claude-sonnet-4-5-20250929';
const TO = 'claude-haiku-4-5';

let mock: MockServer;
let cwd: string;
let db: string;
let runId: string;

function shadowlap(args: string[]): Promise<{ code: number | null; out: string; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, '--db', db, ...args], {
      cwd,
      env: { ...process.env, SHADOWLAP_UPSTREAM_ANTHROPIC: mock.url, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', SHADOWLAP_GUARD: 'off', SHADOWLAP_HOME: join(cwd, 'home') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => ((out += d.toString()), (stdout += d.toString())));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('exit', (code) => resolve({ code, out, stdout }));
  });
}

const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });
const json = <T,>(r: { stdout: string; out: string }): T => {
  try {
    return JSON.parse(r.stdout) as T;
  } catch {
    throw new Error(`not JSON:\n${r.out}`);
  }
};

let n = 0;
/** A migration's id: each one new, its first ten characters after mg- its own, all of them sharing the eight before. */
const nextId = () => `mg-01K5CQ2E${String(++n).padStart(2, '0')}0000000000000000`;

/**
 * A migration kept as `migrate` keeps it: its report without its runs, all clear unless `o` says
 * otherwise, and its config change written to .shadowlap/migrations/<id>/config.patch.
 */
function keepMigration(o: { passes?: unknown; configChange?: ConfigChange | null; byHand?: string[]; fields?: unknown[]; files?: null; patchText?: string } = {}): string {
  const id = nextId();
  const change = o.configChange === undefined ? (modelMentions(cwd, [FROM], TO) as ConfigChange) : o.configChange;
  const dir = `.shadowlap/migrations/${id}`;
  mkdirSync(join(cwd, dir), { recursive: true });
  if (change) writeFileSync(join(cwd, dir, 'config.patch'), o.patchText ?? change.patch);
  const data = {
    migrateId: id,
    kind: 'migrate',
    at: 1_000,
    from: [FROM],
    to: TO,
    command: `shadowlap migrate --to ${TO}`,
    passes: o.passes ?? { verdict: 'accepted', runs: [{ runId, golden: 'goldens/research', verdict: 'passed', outcome: 'kept', verified: true, tally: null, diverges: null }] },
    set: { flags: [], fields: o.fields ?? [], given: {}, byHand: o.byHand ?? [] },
    configChange: change,
    files: o.files === null ? null : { dir, pullRequest: `${dir}/pull-request.md`, patch: change ? `${dir}/config.patch` : null },
    retirements: [],
    notes: [],
    warnings: [],
    stopReason: null,
    decisions: { runs: [] },
  };
  const store = Store.open(db);
  try {
    store.putDecisionSession({ sessionId: id, kind: 'migrate', at: 1_000, change: `the model ${TO}`, actor: null, revision: null, data, runs: [] });
  } finally {
    store.close();
  }
  return id;
}

/** The recording's first model call: where a golden that replays exactly diverges once the model is switched. */
function firstModelCall(): number {
  const store = Store.open(db);
  try {
    return store.getCalls(runId).find((c) => c.kind === 'api')!.callNo;
  } finally {
    store.close();
  }
}

beforeAll(async () => {
  mock = await startMockAnthropic({ script: referenceScript, eventDelayMs: () => 0 });
  cwd = mkdtempSync(join(tmpdir(), 'sl-migrate-apply-'));
  db = join(cwd, '.shadowlap', 'shadowlap.db');
  git('init', '-q');
  git('config', 'user.email', 'dev@example.com');
  git('config', 'user.name', 'Dev');
  writeFileSync(join(cwd, 'agent.config.json'), `{\n  "name": "research",\n  "model": "${FROM}",\n  "max_tokens": 1024\n}\n`);
  writeFileSync(join(cwd, '.gitignore'), '.shadowlap/\nhome/\n');
  // The second golden may fork: it passes on its checks wherever it forks, so a switch never leaves it behind.
  writeFileSync(join(cwd, 'shadowlap.config.json'), JSON.stringify({ tests: { 'goldens/forks': { fork: true, expect: { tools: { send_email: 1 } } } } }, null, 2));
  git('add', '.');
  git('commit', '-q', '-m', 'agent');
  const rec = await shadowlap(['run', '--', process.execPath, CONFIG_AGENT, process.execPath, AGENT]);
  expect(rec.code, rec.out).toBe(0);
  runId = /recording run (\w{26})/.exec(rec.out)![1]!;
  mkdirSync(join(cwd, 'goldens'), { recursive: true });
  for (const name of ['research', 'forks']) {
    const packed = await shadowlap(['pack', runId, `goldens/${name}`]);
    expect(packed.code, packed.out).toBe(0);
  }
  // The goldens are the repository's own, so their commands replay without asking.
  git('add', 'goldens');
  git('commit', '-q', '-m', 'goldens');
}, 120_000);
afterAll(async () => {
  await mock.close();
  rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('shadowlap migrate apply', () => {
  it('refuses what it can not apply, saying why, with exit 2, and changes nothing', async () => {
    const before = readFileSync(join(cwd, 'agent.config.json'), 'utf8');
    const refused = async (id: string, words: string | RegExp) => {
      const r = await shadowlap(['migrate', 'apply', id, '--json']);
      expect(r.code, r.out).toBe(2);
      const out = json<{ migrateId: string; status: string; error: { message: string } }>(r);
      expect(departures('migrateApplyError', out)).toEqual({ missing: [], extra: [] });
      expect(out).toMatchObject({ migrateId: id, status: 'error' });
      if (typeof words === 'string') expect(out.error.message).toContain(words);
      else expect(out.error.message).toMatch(words);
    };
    await refused('mg-ZZZZZZZZ', 'no migration mg-ZZZZZZZZ');
    const broken = keepMigration({ passes: { verdict: 'rejected', runs: [{ verdict: 'failed', verified: true }] } });
    await refused(broken, `${broken.slice(0, 13)} is not all clear: ${TO} breaks runs. Nothing was changed`);
    const open = keepMigration({ passes: { verdict: 'accepted', runs: [{ verdict: 'passed', verified: true }, { verdict: 'inconclusive', verified: false }] } });
    await refused(open, `${open.slice(0, 13)} is not all clear: 1 run is inconclusive. Nothing was changed`);
    await refused(keepMigration({ configChange: null }), `has no config change: no string in the project's code or config names ${FROM}, so set ${TO} where your agent reads its model`);
    await refused(keepMigration({ files: null }), 'migrate could not write');
    const hand = keepMigration({ byHand: ['top_p'], fields: [{ field: 'top_p', value: null, leftOut: true, renamedTo: null, why: 'refused', source: null, steps: 1 }] });
    await refused(hand, `What to set says to leave top_p out, which the config change can't reach: applied alone it would break runs. Change it by hand, then git apply .shadowlap/migrations/${hand}/config.patch`);
    // Its ids share their first eight characters: a prefix that names more than one is refused.
    await refused('mg-01K5CQ2E', /^mg-01K5CQ2E names \d+ sessions: give more of its id$/);
    expect(readFileSync(join(cwd, 'agent.config.json'), 'utf8')).toBe(before);
  }, 120_000);

  it('refuses a patch that changed since migrate wrote it, with exit 1', async () => {
    const change = modelMentions(cwd, [FROM], TO) as ConfigChange;
    const id = keepMigration({ patchText: change.patch.replace(TO, 'claude-other') });
    const r = await shadowlap(['migrate', 'apply', id]);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain(`.shadowlap/migrations/${id}/config.patch is not the config change ${id.slice(0, 13)} checked: it changed since. Nothing was changed`);
  }, 60_000);

  it('leaves a tree whose changes conflict with the patch alone, saying what to do', async () => {
    const id = keepMigration();
    const file = join(cwd, 'agent.config.json');
    const before = readFileSync(file, 'utf8');
    writeFileSync(file, before.replace(FROM, 'claude-by-hand'));
    try {
      const r = await shadowlap(['migrate', 'apply', id]);
      expect(r.code, r.out).toBe(1);
      expect(r.out).toContain(`agent.config.json has uncommitted changes the patch conflicts with`);
      expect(r.out).toContain(`Nothing was changed: commit or stash them, then run shadowlap migrate apply ${id.slice(0, 13)} again`);
      expect(readFileSync(file, 'utf8')).toContain('claude-by-hand');
    } finally {
      writeFileSync(file, before);
    }
  }, 60_000);

  it('applies the config change, replays the goldens offline and names the one that diverges on $.model, then keeps it applied', async () => {
    const at = firstModelCall();
    const pass = { runId, verdict: 'passed', outcome: 'kept', verified: true, tally: null };
    const id = keepMigration({ passes: { verdict: 'accepted', runs: [{ ...pass, golden: 'goldens/research', diverges: { callNo: at, path: '$.model' } }, { ...pass, golden: 'goldens/forks', diverges: null, stays: 'fork' }] } });
    const short = id.slice(0, 13);
    const text = await shadowlap(['migrate', 'apply', short]);
    expect(text.code, text.out).toBe(0);
    expect(readFileSync(join(cwd, 'agent.config.json'), 'utf8')).toContain(`"model": "${TO}",`);
    expect(text.out).toContain(`⑂ Applying ${short} · ${FROM} → ${TO}\n`);
    expect(text.out).toContain(`\n  applied .shadowlap/migrations/${id}/config.patch: agent.config.json · 1 place\n`);
    expect(text.out).toContain('\n▸ replaying the goldens offline, in a store of their own that nothing keeps: 2 goldens\n');
    expect(text.out).toMatch(new RegExp(`\\n {4}✗ goldens/research: diverged at call ${at} \\(api POST /v1/messages\\) · ~ \\$\\.model\\n`));
    // The golden marked fork passes on its checks wherever it forks: never named.
    expect(text.out).not.toContain('✗ goldens/forks');
    expect(text.out).toContain('\n    the others don’t diverge on it: 1 golden marked fork passes on its checks wherever it forks\n');
    expect(text.out).toContain(`\n  ! 1 golden diverges on the model the config change switched (${FROM} → ${TO}): goldens/research\n    re-record it under ${TO} once the switch is what you meant: shadowlap test goldens/research --update\n`);
    expect(text.stdout).toBe(`✓ ${short} applied · 1 golden to update\n`);

    const store = Store.open(db);
    try {
      const kept = store.getDecisionSession(id)!;
      expect(kept.applied).toMatchObject({ at: expect.any(Number), outdated: [{ golden: 'goldens/research', callNo: at, path: '$.model' }] });
      const [event] = store.listEvents({ kinds: ['migrate.applied'] });
      expect(event).toMatchObject({ kind: 'migrate.applied', ref: id, data: { from: [FROM], to: TO, files: ['agent.config.json'], outdated: ['goldens/research'], patch: 'applied' } });
    } finally {
      store.close();
    }

    // Applied, its patch in the tree: nothing is left to do, and nothing is replayed again.
    const again = await shadowlap(['migrate', 'apply', id, '--json']);
    expect(again.code, again.out).toBe(0);
    const result = json<Record<string, unknown>>(again);
    expect(departures('migrateApply', result)).toEqual({ missing: [], extra: [] });
    expect(result).toEqual({ migrateId: id, status: 'already-applied', patch: 'already', files: ['agent.config.json'], leftOut: [], outdated: [], update: null });
    expect(again.out).not.toContain('replaying the goldens');
    git('checkout', '--', 'agent.config.json');
  }, 240_000);

  it("marks a patch already in the tree applied, and says what it left behind as JSON", async () => {
    const id = keepMigration();
    writeFileSync(join(cwd, 'agent.config.json'), readFileSync(join(cwd, 'agent.config.json'), 'utf8').replace(FROM, TO));
    try {
      const r = await shadowlap(['migrate', 'apply', id, '--json']);
      expect(r.code, r.out).toBe(0);
      const result = json<Record<string, unknown>>(r);
      expect(departures('migrateApply', result)).toEqual({ missing: [], extra: [] });
      expect(result).toEqual({ migrateId: id, status: 'applied', patch: 'already', files: ['agent.config.json'], leftOut: [], outdated: [{ golden: 'goldens/research', callNo: firstModelCall(), kind: 'api', name: expect.stringContaining('/v1/messages'), path: '$.model' }], update: 'shadowlap test goldens/research --update' });
      expect(r.out).toContain('the config change is already in the working tree');
    } finally {
      git('checkout', '--', 'agent.config.json');
    }
  }, 240_000);
});
