import { isObject } from '@shadowlap/engine';
import type { StoreOf } from '@shadowlap/engine';
import { chaosMatrices, presetsSummary } from './chaos.js';
import { coverageNewest } from './coverage.js';
import { links } from './links.js';
import type { LookSource, LookWork, NeedsLookRow } from './needs-look/row.js';
import type { GoldenList, GoldenSource } from './tests.js';

/**
 * What the upgrades found, as lines of Needs a look: error-path presets that failed or couldn't say,
 * a preview of a change that flags runs, and behaviours seen in production that no golden covers (an
 * injection test's lines are needs-look/security.ts'). The CLI keeps each in the store; this reads
 * what it kept, and each line opens the run that shows it (a preset's failing attempt, a run whose
 * decision changed, a capture of the behaviour), as no page of their own exists yet. Red lines are failures; amber lines need a look or couldn't decide.
 */
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const goldenName = (path: string) => path.replace(/^\.\//, '').replace(/^goldens\//, '');
const pathOf = (g: string | GoldenSource) => (typeof g === 'string' ? g : g.path);

/** The run a line opens, when the store still has it. */
const kept = (store: StoreOf<'recording'>, runId: string | null | undefined): string | null => (runId && store.getRun(runId) ? runId : null);

/**
 * Each golden's presets that failed (in red) or that couldn't say (in amber), as their last session
 * left them: `2 of 4 presets failed: tool timeout #2, provider 429 #3`. A golden no longer on disk,
 * or a run no longer in the store, has none. Each opens the first such preset's attempt.
 */
function presetLooks(store: StoreOf<'recording' | 'chaos'>, goldens: GoldenList): { failed: NeedsLookRow[]; warn: NeedsLookRow[] } {
  const onDisk = new Set(goldens.map(pathOf));
  const failed: NeedsLookRow[] = [];
  const warn: NeedsLookRow[] = [];
  for (const m of chaosMatrices(store)) {
    if (m.golden ? !onDisk.has(m.golden) : !kept(store, m.runId)) continue;
    const p = presetsSummary(m, (id) => kept(store, id) !== null);
    if (!p || p.verdict === 'passed') continue;
    const name = m.golden ? goldenName(m.golden) : m.runId.slice(0, 10);
    const runId = p.runId ?? kept(store, m.runId);
    const row: NeedsLookRow = { key: `attn:presets:${m.golden ?? m.runId}`, group: p.verdict === 'failed' ? 'failing' : 'tests', kind: 'presets', icon: p.verdict === 'failed' ? 'fail' : 'warn', title: `Error-path presets ${p.verdict}: ${name}`, detail: p.line, step: null, href: runId ? links.run(runId) : links.tests(), runId, fixId: null, at: m.at };
    (p.verdict === 'failed' ? failed : warn).push(row);
  }
  return { failed, warn };
}

/** How a verify of a session's flagged runs came out, or null when none ran: decisions keep it as `verify`, migrate as `passes`. */
function verifiedAs(data: Record<string, unknown>): string | null {
  const v = isObject(data.verify) ? data.verify : isObject(data.passes) ? data.passes : null;
  return v && typeof v.verdict === 'string' && v.verdict !== 'not-run' ? v.verdict : null;
}

/** The runs a session's report flags, as most samples show them (the store's count goes by the same). */
function flaggedOf(data: Record<string, unknown>): string[] {
  const report = isObject(data.decisions) ? data.decisions : data;
  const listed = Array.isArray(data.flagged) ? data.flagged : Array.isArray(report.flagged) ? report.flagged : [];
  return listed.filter((id): id is string => typeof id === 'string');
}

/**
 * Previews of a change (`decisions`, `migrate`) whose flagged runs no session of that change has
 * settled since, in amber, newest first. A run stands as the newest session of the change, of either
 * kind, that asked it again says: one that didn't flag it, or whose verify accepted what it flagged,
 * settled it (a migration of a model a preview flagged runs under, whose verify accepted them,
 * settles the preview); one that flagged it again is that session's line. A session with flagged runs
 * left is a line, opening the first still in the store at the first call whose decision most of its
 * samples changed.
 */
function decisionLooks(store: StoreOf<'recording' | 'readModels' | 'decisions'>): NeedsLookRow[] {
  const sessions = store.listDecisionSessions({ limit: 50 });
  if (!sessions.length) return [];
  // The runs each session asked again, without reading their reports.
  const asked = new Map<string, Set<string>>();
  const rows = store.query(`SELECT session_id, run_id FROM decision_runs WHERE session_id IN (${sessions.map(() => '?').join(', ')})`, ...sessions.map((s) => s.sessionId));
  for (const r of rows) {
    const id = String(r.session_id);
    asked.set(id, (asked.get(id) ?? new Set()).add(String(r.run_id)));
  }
  const out: NeedsLookRow[] = [];
  // Per change, the runs a newer session already stands for.
  const said = new Map<string, Set<string>>();
  for (const s of sessions) {
    const newer = said.get(s.change);
    const standing = newer ?? new Set<string>();
    said.set(s.change, standing);
    const mine = asked.get(s.sessionId) ?? new Set<string>();
    const full = s.flagged > 0 ? store.getDecisionSession(s.sessionId) : null;
    const flagged = full ? flaggedOf(full.data) : [];
    // What a newer session settled or says itself; a report that lists no runs goes by its count, while it is its change's newest.
    const open = flagged.filter((id) => !standing.has(id));
    for (const id of [...mine, ...flagged]) standing.add(id);
    if (!full || (flagged.length ? !open.length : newer)) continue;
    const verdict = verifiedAs(full.data);
    if (verdict === 'accepted') continue;
    const n = open.length || s.flagged;
    // The first flagged run still here, at the first call whose decision most of its samples changed.
    const first = open.find((id) => kept(store, id)) ?? null;
    const row = first ? full.runRows.find((r) => r.runId === first) : undefined;
    const steps = row && Array.isArray(row.data.decisions) ? (row.data.decisions as unknown[]).filter(isObject) : [];
    const callNo = steps
      .filter((d) => typeof d.callNo === 'number' && typeof d.majority === 'number' && d.majority >= 1 && d.majority <= 2)
      .map((d) => d.callNo as number)
      .sort((a, b) => a - b)[0];
    const state = verdict === 'rejected' ? 'verify rejected it' : verdict === 'incomplete' ? 'verify didn’t settle it' : 'not verified yet';
    out.push({
      key: `attn:decisions:${s.sessionId}`,
      group: 'tests',
      kind: 'decisions',
      icon: 'warn',
      title: `${plural(n, 'run decides', 'runs decide')} differently under ${s.change}`,
      detail: `${s.kind === 'migrate' ? 'a migration' : 'a preview'}: a write, stop or judged change · ${state}`,
      step: null,
      href: first ? links.run(first, callNo) : links.runs(),
      runId: first,
      fixId: null,
      at: s.at,
    });
  }
  return out;
}

/** A look's presets, read once for both of their sources. */
const presetsRead = new WeakMap<LookWork, ReturnType<typeof presetLooks>>();
const presetsOf = (w: LookWork) => presetsRead.get(w) ?? (presetsRead.set(w, presetLooks(w.store, w.goldens)), presetsRead.get(w)!);

/*
 * The upgrades' rows, each a source of Needs a look (needs-look/index.ts) in main's words until its
 * own slice takes it: error-path presets that failed under Failing and those left inconclusive under
 * Tests, behaviours no golden covers and previews that flag runs under Tests, injection tests under
 * Security.
 */
export const presetsFailed: LookSource = {
  id: 'presetsFailed',
  group: 'failing',
  order: 30,
  rows: (w) => presetsOf(w).failed,
  rest: (n) => ({ icon: 'fail', title: `${plural(n, 'more error-path test')} failed`, detail: 'each on its run, under Runs', href: links.runs() }),
};

export const presetsUnsure: LookSource = {
  id: 'presetsUnsure',
  group: 'tests',
  order: 20,
  rows: (w) => presetsOf(w).warn,
  rest: (n) => ({ icon: 'warn', title: `${plural(n, 'more error-path test')} inconclusive`, detail: 'each on its run, under Runs', href: links.runs() }),
};

/** `/api/coverage` serves the look in its own shape, `action` included: the row takes the rest of it, keyed by the newest behaviour no golden covers. */
export const coverage: LookSource = {
  id: 'coverage',
  group: 'tests',
  order: 30,
  rows: (w) => {
    const newest = coverageNewest(w.store);
    if (!newest) return [];
    const { kind, icon, title, detail, href, runId, fixId, at } = newest.look;
    return [{ key: `attn:coverage:${newest.key}`, group: 'tests', kind, icon, title, detail, step: null, href, runId, fixId, at }];
  },
};

export const decisions: LookSource = {
  id: 'decisions',
  group: 'tests',
  order: 40,
  rows: (w) => decisionLooks(w.store),
  rest: (n) => ({ icon: 'warn', title: `${plural(n, 'more preview')} of a change to look at`, detail: 'each on its run, under Runs', href: links.runs() }),
};

