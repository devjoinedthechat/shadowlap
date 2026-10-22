import type { Store } from '@shadowlap/engine';
import { chaosMatrices, presetsSummary } from './chaos.js';
import { coverageLook } from './coverage.js';
import { injectionNeedsLook } from './injection.js';
import type { NeedsLookRow } from './overview.js';
import type { GoldenList, GoldenSource } from './tests.js';

/**
 * What the upgrades found, as lines of Needs a look: an injection test a planted instruction got
 * through, error-path presets that failed or couldn't say, a preview of a change that flags runs,
 * and behaviours seen in production that no golden covers. The CLI keeps each in the store; this
 * reads what it kept, and each line opens the run that shows it (an attempt that obeyed, a preset's
 * failing attempt, a run whose decision changed, a capture of the behaviour), as no page of their
 * own exists yet. Red lines are failures; amber lines need a look or couldn't decide.
 */
export interface UpgradeLooks {
  /** Injection tests a planted instruction got through (red), first, then those it influenced or that showed too little to say (amber). */
  injection: NeedsLookRow[];
  /** Goldens whose error-path presets failed (red). */
  presetsFailed: NeedsLookRow[];
  /** Goldens whose error-path presets couldn't say (amber). */
  presetsUnsure: NeedsLookRow[];
  /** Previews of a change that flag runs no session of that change has settled since (amber). */
  decisions: NeedsLookRow[];
  /** Behaviours seen in production that no golden covers. */
  coverage: NeedsLookRow[];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const goldenName = (path: string) => path.replace(/^\.\//, '').replace(/^goldens\//, '');
const pathOf = (g: string | GoldenSource) => (typeof g === 'string' ? g : g.path);

/** The run a line opens, when the store still has it. */
const kept = (store: Store, runId: string | null | undefined): string | null => (runId && store.getRun(runId) ? runId : null);

/**
 * An injection test's lines: obeyed in red, first; influenced or inconclusive in amber. Each opens an
 * attempt that shows it, else the run tested. A golden's injection gate is Tests' to list: a result
 * its newest test result carries (it ran in that test's session) is already a failing or an
 * inconclusive test, so it adds no line of its own; a golden tested on its own (`shadowlap
 * injection goldens/x`) does. A golden no longer on disk, or a run no longer in the store, has none.
 */
function injectionLooks(store: Store, goldens: GoldenList): NeedsLookRow[] {
  const onDisk = new Set(goldens.map(pathOf));
  const tested = new Map(store.latestTestResults().map((t) => [t.golden, t]));
  const failed: NeedsLookRow[] = [];
  const warn: NeedsLookRow[] = [];
  for (const x of injectionNeedsLook(store)) {
    if (x.golden ? !onDisk.has(x.golden) : !kept(store, x.runId)) continue;
    const result = store.getInjectionResult(x.resultId);
    const test = x.golden ? tested.get(x.golden) : undefined;
    if (test && (test.data?.injection?.resultId === x.resultId || (!!result?.sessionId && test.sessionId === result.sessionId))) continue;
    const name = x.golden ? goldenName(x.golden) : x.runId.slice(0, 10);
    // The attempt whose verdict is the line's: the evidence, a run of its own.
    const attempts = isObject(result?.data) && Array.isArray(result.data.attempts) ? (result.data.attempts as unknown[]).filter(isObject) : [];
    const shows = attempts.find((a) => a.verdict === x.severity && typeof a.runId === 'string' && kept(store, a.runId as string));
    const runId = (shows?.runId as string | undefined) ?? kept(store, x.runId);
    const row = (icon: 'fail' | 'warn', title: string): NeedsLookRow => ({ kind: 'injection', icon, title, detail: x.text, action: 'Open', href: runId ? `#/run/${runId}` : '#/tests', runId, fixId: null, at: result?.endedAt ?? 0 });
    if (x.severity === 'obeyed') failed.push(row('fail', `An injection test failed: ${name}`));
    else if (x.severity === 'influenced') warn.push(row('warn', `An injection test needs a look: ${name}`));
    else warn.push(row('warn', `An injection test is inconclusive: ${name}`));
  }
  return [...failed, ...warn];
}

/**
 * Each golden's presets that failed (in red) or that couldn't say (in amber), as their last session
 * left them: `2 of 4 presets failed: tool timeout #2, provider 429 #3`. A golden no longer on disk,
 * or a run no longer in the store, has none. Each opens the first such preset's attempt.
 */
function presetLooks(store: Store, goldens: GoldenList): { failed: NeedsLookRow[]; warn: NeedsLookRow[] } {
  const onDisk = new Set(goldens.map(pathOf));
  const failed: NeedsLookRow[] = [];
  const warn: NeedsLookRow[] = [];
  for (const m of chaosMatrices(store)) {
    if (m.golden ? !onDisk.has(m.golden) : !kept(store, m.runId)) continue;
    const p = presetsSummary(m, (id) => kept(store, id) !== null);
    if (!p || p.verdict === 'passed') continue;
    const name = m.golden ? goldenName(m.golden) : m.runId.slice(0, 10);
    const runId = p.runId ?? kept(store, m.runId);
    const row: NeedsLookRow = { kind: 'presets', icon: p.verdict === 'failed' ? 'fail' : 'warn', title: `Error-path presets ${p.verdict}: ${name}`, detail: p.line, action: 'Open', href: runId ? `#/run/${runId}` : '#/tests', runId, fixId: null, at: m.at };
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
function decisionLooks(store: Store): NeedsLookRow[] {
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
      kind: 'decisions',
      icon: 'warn',
      title: `${plural(n, 'run decides', 'runs decide')} differently under ${s.change}`,
      detail: `${s.kind === 'migrate' ? 'a migration' : 'a preview'}: a write, stop or judged change · ${state}`,
      action: 'Open',
      href: first ? `#/run/${first}${callNo ? `/${callNo}` : ''}` : '#/runs',
      runId: first,
      fixId: null,
      at: s.at,
    });
  }
  return out;
}

/** Every line the upgrades' results add to Needs a look. */
export function upgradeLooks(store: Store, o: { goldens: GoldenList }): UpgradeLooks {
  const presets = presetLooks(store, o.goldens);
  const coverage = coverageLook(store);
  return {
    injection: injectionLooks(store, o.goldens),
    presetsFailed: presets.failed,
    presetsUnsure: presets.warn,
    decisions: decisionLooks(store),
    coverage: coverage ? [coverage] : [],
  };
}
