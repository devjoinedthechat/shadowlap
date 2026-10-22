import type { Store } from '@shadowlap/engine';
import { chaosMatrices, type ChaosCell } from './chaos.js';
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
  /** An injection test a planted instruction got through; presets that failed. */
  failed: NeedsLookRow[];
  /** An injection test it influenced or that showed too little; presets left inconclusive; previews that flag runs. */
  warn: NeedsLookRow[];
  /** Behaviours seen in production that no golden covers. */
  coverage: NeedsLookRow[];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const goldenName = (path: string) => path.replace(/^\.\//, '').replace(/^goldens\//, '');
const pathOf = (g: string | GoldenSource) => (typeof g === 'string' ? g : g.path);

/** The run a line opens, when the store still has it. */
const kept = (store: Store, runId: string | null | undefined): string | null => (runId && store.getRun(runId) ? runId : null);

/** An injection test's lines: obeyed in red, first; influenced or inconclusive in amber. Each opens an attempt that shows it, else the run tested. */
function injectionLooks(store: Store): { failed: NeedsLookRow[]; warn: NeedsLookRow[] } {
  const failed: NeedsLookRow[] = [];
  const warn: NeedsLookRow[] = [];
  for (const x of injectionNeedsLook(store)) {
    const name = x.golden ? goldenName(x.golden) : x.runId.slice(0, 10);
    // The attempt whose verdict is the line's: the evidence, a run of its own.
    const data = store.getInjectionResult(x.resultId)?.data;
    const attempts = isObject(data) && Array.isArray(data.attempts) ? (data.attempts as unknown[]).filter(isObject) : [];
    const shows = attempts.find((a) => a.verdict === x.severity && typeof a.runId === 'string' && kept(store, a.runId as string));
    const runId = (shows?.runId as string | undefined) ?? kept(store, x.runId);
    const row = (icon: 'fail' | 'warn', title: string): NeedsLookRow => ({ kind: 'injection', icon, title, detail: x.text, action: 'Open', href: runId ? `#/run/${runId}` : '#/tests', runId, fixId: null, at: store.getInjectionResult(x.resultId)?.endedAt ?? 0 });
    if (x.severity === 'obeyed') failed.push(row('fail', `An injection test failed: ${name}`));
    else if (x.severity === 'influenced') warn.push(row('warn', `An injection test needs a look: ${name}`));
    else warn.push(row('warn', `An injection test is inconclusive: ${name}`));
  }
  return { failed, warn };
}

/** A preset as a line names it: `tool timeout #2`. */
const presetWords = (c: ChaosCell) => `${c.label}${c.callNo !== null ? ` #${c.callNo}` : ''}`;

/**
 * Each golden's presets that failed (in red) or that couldn't say (in amber), as their last session
 * left them: `3 of 6 failed: tool timeout #2, provider 429 #3, provider 500 #3`. A golden no longer on
 * disk, or a run no longer in the store, has none. Each opens the first such preset's attempt.
 */
function presetLooks(store: Store, goldens: GoldenList): { failed: NeedsLookRow[]; warn: NeedsLookRow[] } {
  const onDisk = new Set(goldens.map(pathOf));
  const failed: NeedsLookRow[] = [];
  const warn: NeedsLookRow[] = [];
  for (const m of chaosMatrices(store)) {
    if (m.golden ? !onDisk.has(m.golden) : !kept(store, m.runId)) continue;
    const name = m.golden ? goldenName(m.golden) : m.runId.slice(0, 10);
    const ran = m.cells.filter((c) => c.verdict !== 'not-applicable');
    const bad = ran.filter((c) => c.verdict === 'failed');
    const unsure = ran.filter((c) => c.verdict === 'inconclusive');
    const shown = bad.length ? bad : unsure;
    if (!shown.length) continue;
    const attempt = shown.flatMap((c) => c.runs.filter((x) => x.verdict !== 'passed').map((x) => x.runId)).find((id) => kept(store, id)) ?? kept(store, m.runId);
    const row: NeedsLookRow = {
      kind: 'presets',
      icon: bad.length ? 'fail' : 'warn',
      title: `Error-path presets ${bad.length ? 'failed' : 'inconclusive'}: ${name}`,
      detail: `${shown.length} of ${plural(ran.length, 'preset')} ${bad.length ? 'failed' : 'inconclusive'}: ${shown.map(presetWords).join(', ')}${bad.length && unsure.length ? ` · ${unsure.length} inconclusive` : ''}`,
      action: 'Open',
      href: attempt ? `#/run/${attempt}` : '#/tests',
      runId: attempt,
      fixId: null,
      at: m.at,
    };
    (bad.length ? failed : warn).push(row);
  }
  return { failed, warn };
}

/** How a verify of a session's flagged runs came out, or null when none ran: decisions keep it as `verify`, migrate as `passes`. */
function verifiedAs(data: Record<string, unknown>): string | null {
  const v = isObject(data.verify) ? data.verify : isObject(data.passes) ? data.passes : null;
  return v && typeof v.verdict === 'string' && v.verdict !== 'not-run' ? v.verdict : null;
}

/**
 * Previews of a change (`decisions`, `migrate`) whose flagged runs no verify has accepted since:
 * the newest of each change, in amber, each opening its first flagged run at the call whose
 * decision changed. A preview whose flagged runs a verify accepted needs nothing more.
 */
function decisionLooks(store: Store): NeedsLookRow[] {
  const out: NeedsLookRow[] = [];
  const seen = new Set<string>();
  for (const s of store.listDecisionSessions({ limit: 50 })) {
    const key = `${s.kind}\u0000${s.change}`;
    if (s.flagged <= 0 || seen.has(key)) continue;
    seen.add(key);
    const full = store.getDecisionSession(s.sessionId);
    if (!full) continue;
    const verdict = verifiedAs(full.data);
    if (verdict === 'accepted') continue;
    const report = isObject(full.data.decisions) ? full.data.decisions : full.data;
    const listed = Array.isArray(full.data.flagged) ? full.data.flagged : Array.isArray(report.flagged) ? report.flagged : [];
    const flagged = listed.filter((id): id is string => typeof id === 'string');
    const n = flagged.length || s.flagged;
    // The first flagged run still here, at the first call whose decision most of its samples changed.
    const first = flagged.find((id) => kept(store, id)) ?? null;
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
  const injection = injectionLooks(store);
  const presets = presetLooks(store, o.goldens);
  const coverage = coverageLook(store);
  return {
    failed: [...injection.failed, ...presets.failed],
    warn: [...injection.warn, ...presets.warn, ...decisionLooks(store)],
    coverage: coverage ? [coverage] : [],
  };
}

