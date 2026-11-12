import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectHost, ProjectRegistry, Store, projectDbPath } from '@shadowlap/engine';
import { startDashboard, type Dashboard, type ProjectConfig } from '../src/index.js';
import type { HoldingView } from '../src/cross-project.js';
import { readingStores } from '../src/reading-stores.js';
import { heldAsk } from '../ui/held.js';
import { parseRoute } from '../ui/route.js';
import { addRun, DAY, HOUR } from './read-model-store.js';

/**
 * A link into another project (`GET /api/projects/holding`): which other project's store holds a
 * run, a fix, a preview or a migration this one doesn't. Three projects, support-agent current:
 * triage-bot and research-agent hold what support-agent's links name once the dashboard has
 * switched, and what support-agent itself doesn't. Their stores are opened read-only and closed
 * again: an older store stays as old as it was, and removing a project waits for a read of its
 * store. Invented ids and no credentials.
 */

const NOW = Date.UTC(2026, 10, 1, 12);
// support-agent's: two runs whose ids start alike, a fork, a fix, a preview and a migration.
const A1 = '01AAAA10000000000000000000';
const A2 = '01AAAA20000000000000000000';
const A_FORK = '01AAAA60000000000000000000';
const A_FIX = 'fx-01AAAA30000000000000000000';
const A_PREVIEW = 'dc-01AAAA40000000000000000000';
const A_MIGRATION = 'mg-01AAAA50000000000000000000';
// triage-bot's: a recording, its fork and an attempt, sharing a prefix; one that starts as support-agent's do.
const B_REC = '01BBBB10000000000000000000';
const B_FORK = '01BBBB20000000000000000000';
const B_ATTEMPT = '01BBBB30000000000000000000';
const B_LIKE_A = '01AAAA90000000000000000000';
const B_FIX = 'fx-01BBBB40000000000000000000';
const B_PREVIEW = 'dc-01BBBB50000000000000000000';
const B_MIGRATION = 'mg-01BBBB60000000000000000000';
// Both triage-bot and research-agent hold this one.
const SHARED = '01CCCC10000000000000000000';

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
}
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })));

function folder(home: string, name: string): string {
  const path = join(home, name);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'package.json'), '{}');
  return path;
}

/** A fix of `runId`, and a preview and a migration of it, as the CLI keeps them. */
function changesOf(store: Store, runId: string, ids: { fix: string; preview: string; migration: string }): void {
  const check = { expect: { tools: { issue_refund: { count: 0 } } }, key: 'check:x', oracle: ['issue_refund never called'], text: 'issue_refund never called' };
  store.insertFix({ fixId: ids.fix, title: 'Refunds issued without approval', labels: [], check, status: 'open', openedAt: NOW - HOUR, verifiedAt: null, appliedAt: null, data: {} });
  store.addFixLink(ids.fix, 'failing', runId, NOW - HOUR);
  const decided = { runId, golden: null, steps: 2, asked: 2, rank: 1, majority: 1, counts: {}, cost: { before: 0.004, after: 0.002, spent: 0.001 }, tokens: {}, thinkingStripped: 0, refused: null, decisions: [], warnings: [] };
  const change = { model: 'claude-haiku-4-5', fields: {}, from: null, fromCode: null, text: 'the model claude-haiku-4-5' };
  store.putDecisionSession({ sessionId: ids.preview, kind: 'decisions', at: NOW - HOUR, change: change.text, actor: null, revision: null, data: { change, flagged: [], toVerify: [], verify: null }, runs: [{ runId, golden: null, rank: 1, changed: 1, data: decided }] });
  store.putDecisionSession({ sessionId: ids.migration, kind: 'migrate', at: NOW - HOUR, change: change.text, actor: null, revision: null, data: { change, decisions: {} }, runs: [{ runId, golden: null, rank: 1, changed: 1, data: decided }] });
}

/**
 * Holds the store at `dbPath` as a writer that takes the whole file does, until what this returns is
 * called: a read-only open waits on its busy timeout meanwhile. The store keeps a rollback journal
 * for it, since a reader never waits on a writer in WAL mode.
 */
function lockStore(dbPath: string): () => void {
  const raw = new DatabaseSync(dbPath);
  raw.exec('PRAGMA journal_mode = DELETE');
  raw.exec('BEGIN EXCLUSIVE');
  return () => {
    raw.exec('ROLLBACK');
    raw.close();
  };
}

/** Whether `p` still waits once what is ready now has run. */
async function pending(p: Promise<unknown>): Promise<boolean> {
  let settled = false;
  void p.then(
    () => (settled = true),
    () => (settled = true),
  );
  await new Promise((r) => setTimeout(r, 0));
  return !settled;
}

function fill(path: string, fn: (store: Store) => void): void {
  const store = Store.open(path);
  try {
    fn(store);
  } finally {
    store.close();
  }
}

let open: Array<{ dash: Dashboard; host?: ProjectHost<ProjectConfig> }> = [];
afterEach(async () => {
  for (const o of open) {
    await o.dash.close();
    o.host?.close();
  }
  open = [];
});

type Answer<T> = { status: number; body: T };

async function world() {
  const home = tempDir('sl-cross-home-');
  const support = folder(home, 'support-agent');
  const triage = folder(home, 'triage-bot');
  const research = folder(home, 'research-agent');
  fill(projectDbPath(support), (s) => {
    addRun(s, { runId: A1, startedAt: NOW - DAY, argv: ['node', 'agent.mjs'], calls: 'll' });
    addRun(s, { runId: A2, startedAt: NOW - DAY + HOUR, argv: ['node', 'agent.mjs'], calls: 'll' });
    addRun(s, { runId: A_FORK, parent: A1, mode: 'replay', startedAt: NOW - HOUR, divergence: 2, calls: 'rl' });
    changesOf(s, A1, { fix: A_FIX, preview: A_PREVIEW, migration: A_MIGRATION });
  });
  fill(projectDbPath(triage), (s) => {
    addRun(s, { runId: B_REC, startedAt: NOW - DAY, argv: ['node', 'triage.mjs'], calls: 'll' });
    addRun(s, { runId: B_FORK, parent: B_REC, mode: 'replay', startedAt: NOW - HOUR, divergence: 2, calls: 'rl' });
    addRun(s, { runId: B_ATTEMPT, parent: B_REC, mode: 'replay', startedAt: NOW - HOUR + 1, calls: 'rr', meta: { repeat: { group: 'g1', attempt: 2, of: 3 } } });
    addRun(s, { runId: B_LIKE_A, startedAt: NOW - HOUR + 2, argv: ['node', 'triage.mjs'], calls: 'l' });
    addRun(s, { runId: SHARED, startedAt: NOW - HOUR + 3, argv: ['node', 'triage.mjs'], calls: 'l' });
    changesOf(s, B_REC, { fix: B_FIX, preview: B_PREVIEW, migration: B_MIGRATION });
  });
  fill(projectDbPath(research), (s) => addRun(s, { runId: SHARED, startedAt: NOW - HOUR, argv: ['node', 'research.mjs'], calls: 'l' }));
  const registry = new ProjectRegistry({ home, env: { SHADOWLAP_HOME: join(home, '.sl') }, actor: () => null });
  const host = ProjectHost.open<ProjectConfig>(support, { registry, loadConfig: () => ({ normalize: [], redact: [] }) });
  registry.add(triage);
  registry.add(research);
  const dash = await startDashboard({ projects: host, version: '0.1.0' });
  open.push({ dash, host });
  const api = async <T>(path: string): Promise<Answer<T>> => {
    const res = await fetch(`${dash.url}/api/${path}`, { headers: { 'x-shadowlap-token': dash.token } });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
  };
  const holding = (what: string, ...ids: string[]) => api<HoldingView & { error?: string }>(`projects/holding?what=${what}${ids.map((id) => `&id=${encodeURIComponent(id)}`).join('')}`);
  /** The project that holds what was asked, or null. */
  const holder = async (what: string, ...ids: string[]) => {
    const a = await holding(what, ...ids);
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    return a.body.held ? `${a.body.held.project.id} ${a.body.held.id}` : null;
  };
  return { home, support, triage, research, registry, host, dash, api, holding, holder };
}

describe('a link into another project', () => {
  it('finds a run, a fix, a preview and a migration another project holds, by its id or a unique prefix', async () => {
    const w = await world();
    // A recording, its fork, an attempt, and a run asked by a unique prefix, in any case.
    expect(await w.holder('run', B_REC)).toBe(`triage-bot ${B_REC}`);
    expect(await w.holder('run', B_FORK)).toBe(`triage-bot ${B_FORK}`);
    expect(await w.holder('run', B_ATTEMPT)).toBe(`triage-bot ${B_ATTEMPT}`);
    expect(await w.holder('run', '01bbbb2')).toBe('triage-bot 01bbbb2');
    // A fix by its id and by a prefix of it.
    expect(await w.holder('fix', B_FIX)).toBe(`triage-bot ${B_FIX}`);
    expect(await w.holder('fix', 'fx-01BBBB4')).toBe('triage-bot fx-01BBBB4');
    // A preview and a migration, each of its own kind.
    expect(await w.holder('preview', B_PREVIEW)).toBe(`triage-bot ${B_PREVIEW}`);
    expect(await w.holder('migration', B_MIGRATION)).toBe(`triage-bot ${B_MIGRATION}`);
    // A pair: this project's run first, the other's second, names the other's.
    expect(await w.holder('run', A1, B_FORK)).toBe(`triage-bot ${B_FORK}`);
    // Two other projects hold it: the first in the list's order.
    expect(await w.holder('run', SHARED)).toBe(`triage-bot ${SHARED}`);
    const answer = await w.holding('run', B_REC);
    expect(answer.body.current).toEqual({ id: 'support-agent', name: 'support-agent' });
    expect(answer.body.held?.project).toEqual({ id: 'triage-bot', name: 'triage-bot' });
  });

  it('finds nothing this project answers for itself, nor what no listed project holds', async () => {
    const w = await world();
    // In no store, or in this one.
    expect(await w.holder('run', '01ZZZZ00000000000000000000')).toBeNull();
    expect(await w.holder('run', A1)).toBeNull();
    expect(await w.holder('fix', A_FIX)).toBeNull();
    expect(await w.holder('preview', A_PREVIEW)).toBeNull();
    // A prefix several of the other's runs start with is no run of its.
    expect(await w.holder('run', '01BBBB')).toBeNull();
    // A prefix several of this project's runs start with is this project's to say, though another holds a run it starts.
    expect(await w.holder('run', '01AAAA')).toBeNull();
    // A preview's id asked as a migration, and a migration's as a preview.
    expect(await w.holder('migration', B_PREVIEW)).toBeNull();
    expect(await w.holder('preview', B_MIGRATION)).toBeNull();
    // What isn't an id of its kind.
    expect(await w.holder('run', 'fx-01BBBB40000000000000000000')).toBeNull();
    expect(await w.holder('fix', B_REC.toLowerCase().replace('01', 'zz'))).toBeNull();
  });

  it('never looks in a project removed from the list, one whose folder is gone, one with no store, or a newer Shadowlap’s', async () => {
    const w = await world();
    const empty = folder(w.home, 'empty-bot');
    w.registry.add(empty);
    // A project added before it has a store.
    rmSync(join(empty, '.shadowlap'), { recursive: true, force: true });
    expect(await w.holder('run', SHARED)).toBe(`triage-bot ${SHARED}`);
    // research-agent's folder goes: its store isn't looked in.
    renameSync(w.research, `${w.research}-moved`);
    await w.host.remove('triage-bot');
    expect(await w.holder('run', SHARED)).toBeNull();
    expect(await w.holder('run', B_REC)).toBeNull();
    renameSync(`${w.research}-moved`, w.research);
    expect(await w.holder('run', SHARED)).toBe(`research-agent ${SHARED}`);
    // A store a newer Shadowlap wrote holds nothing it can say.
    const newer = new DatabaseSync(projectDbPath(w.research));
    newer.exec(`UPDATE meta SET value = '99' WHERE key = 'schema_version'`);
    newer.close();
    expect(await w.holder('run', SHARED)).toBeNull();
    // None is made for one that had none.
    expect(existsSync(join(empty, '.shadowlap'))).toBe(false);
  });

  it('reads another store as it is: an older one is found in, and left as old as it was', async () => {
    const w = await world();
    const db = projectDbPath(w.triage);
    const raw = new DatabaseSync(db);
    raw.exec(`DROP TABLE events; UPDATE meta SET value = '3' WHERE key = 'schema_version'`);
    const before = { runs: raw.prepare('SELECT * FROM runs ORDER BY run_id').all(), stats: raw.prepare('SELECT * FROM run_stats ORDER BY run_id').all() };
    raw.close();
    rmSync(join(w.triage, '.shadowlap', '.gitignore'));

    expect(await w.holder('run', B_FORK)).toBe(`triage-bot ${B_FORK}`);
    expect(await w.holder('fix', B_FIX)).toBe(`triage-bot ${B_FIX}`);
    const check = new DatabaseSync(db);
    expect(check.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get()?.value).toBe('3');
    expect(check.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'events'`).get()).toBeUndefined();
    expect({ runs: check.prepare('SELECT * FROM runs ORDER BY run_id').all(), stats: check.prepare('SELECT * FROM run_stats ORDER BY run_id').all() }).toEqual(before);
    check.close();
    expect(existsSync(join(w.triage, '.shadowlap', '.gitignore'))).toBe(false);
  });

  it('has a removal wait until a read of the store beside the server ends', async () => {
    const w = await world();
    const db = projectDbPath(w.triage);
    let release = () => {};
    const read = readingStores(w.host, [null, db], () => new Promise<void>((resolve) => (release = resolve)));
    let removed = false;
    const removal = w.host.remove('triage-bot', { deleteRecordings: true, typedName: 'triage-bot' }).then(() => (removed = true));
    await new Promise((r) => setTimeout(r, 50));
    expect(removed).toBe(false);
    expect(existsSync(db)).toBe(true);
    release();
    await read;
    await removal;
    expect(existsSync(db)).toBe(false);
    // Once a read of the stores has ended, here the switcher's, a removal has nothing to wait for.
    const research = projectDbPath(w.research);
    expect((await w.api('projects')).status).toBe(200);
    await w.host.remove('research-agent', { deleteRecordings: true, typedName: 'research-agent' });
    expect(existsSync(research)).toBe(false);
  });

  it('has a removal wait for a lookup under way that may open its store, and for the switcher’s read of the stores', async () => {
    for (const read of ['lookup', 'switcher'] as const) {
      const w = await world();
      // What a removal waits for, as the dashboard's reads beside the server tell the host from the first one on.
      const holds = vi.spyOn(w.host, 'holdStores');
      // The read waits at triage-bot's store, with research-agent's still to read: its removal must wait for it.
      const release = lockStore(projectDbPath(w.triage));
      const asked = read === 'lookup' ? w.holding('run', B_REC) : w.api('projects');
      await vi.waitFor(() => expect(holds, `${read}: no read beside the server holds the stores`).toHaveBeenCalledOnce(), { timeout: 10_000 });
      const research = projectDbPath(w.research);
      expect(await pending(holds.mock.calls[0][0](research)), read).toBe(true);
      let removed = false;
      const removal = w.host.remove('research-agent', { deleteRecordings: true, typedName: 'research-agent' }).then(() => (removed = true));
      await new Promise((r) => setTimeout(r, 100));
      expect(removed, read).toBe(false);
      expect(existsSync(research), read).toBe(true);
      release();
      expect((await asked).status, read).toBe(200);
      await removal;
      expect(existsSync(research), read).toBe(false);
    }
  }, 30_000);

  it('asks for a kind and one id, or two, of the characters an address holds', async () => {
    const w = await world();
    for (const path of ['projects/holding?what=release&id=x', 'projects/holding?what=run', `projects/holding?what=run&id=${A1}&id=${A2}&id=${B_REC}`, 'projects/holding?what=run&id=..%2Fstore', `projects/holding?what=run&id=${'A'.repeat(81)}`]) {
      const a = await w.api<{ error: string }>(path);
      expect(a.status, path).toBe(400);
    }
  });

  it('answers a dashboard that serves one store as the projects routes do', async () => {
    const store = Store.open(':memory:');
    const dash = await startDashboard({ store, version: '0.1.0' });
    open.push({ dash });
    const res = await fetch(`${dash.url}/api/projects/holding?what=run&id=${A1}`, { headers: { 'x-shadowlap-token': dash.token } });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe('this dashboard serves one store: start shadowlap dashboard to add and switch projects');
    await dash.close();
    open = [];
    store.close();
  });

  it('finds every link support-agent’s answers write in support-agent once the dashboard serves another project', async () => {
    const w = await world();
    const answers = await Promise.all(['summary?tz=UTC', 'runs', 'fixes', `fixes/${A_FIX}`, `fixes/${A_FIX}/groups`, 'decisions', `runs/${A1}/decisions`, `runs/${A_FORK}/next`].map((p) => w.api<unknown>(p)));
    const links = new Set<string>();
    const walk = (v: unknown): void => {
      if (typeof v === 'string' && v.startsWith('#/')) links.add(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    answers.filter((a) => a.status === 200).forEach((a) => walk(a.body));
    const asked = [...links].map((link) => ({ link, ask: heldAsk(parseRoute(link)) })).filter((l) => l.ask !== null);
    expect(new Set(asked.map((l) => l.ask!.what))).toEqual(new Set(['run', 'fix', 'preview']));
    w.host.switchTo('triage-bot');
    for (const { link, ask } of asked) {
      const a = await w.holding(ask!.what, ...ask!.ids);
      expect(a.status, link).toBe(200);
      expect(a.body.current.id, link).toBe('triage-bot');
      expect(a.body.held?.project.id, link).toBe('support-agent');
    }
  });
});
