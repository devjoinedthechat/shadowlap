import type { Store } from '@shadowlap/engine';
import { needsLookFixes } from '../fix-summary.js';
import type { PatchCheck, RewriteCheck } from '../fix-shared.js';
import { withGateLines } from '../injection-gates.js';
import { decisions, presetsFailed, presetsUnsure } from '../looks.js';
import { goldenStep, listedStep, type NextStep, type NextStepWork, type StepReads, stepReads } from '../next-step.js';
import type { StoreNote } from '../overview.js';
import type { RunIndex } from '../run-index.js';
import { failingTests, type GoldenList } from '../tests.js';
import { coverage } from './coverage.js';
import { broken, openFixes, ready, unblamed } from './fixes.js';
import { failedGoldens, inconclusiveGoldens } from './goldens.js';
import { LOOK_GROUPS } from './groups.js';
import { retire } from './retire.js';
import { security } from './security.js';
import { goldenName, type HeldGolden, type LookSource, type LookWork, type NeedsLook, type NeedsLookRow, plural } from './row.js';
import { local, setup } from './store.js';

export type { HeldGolden, LookAdvice, LookSource, LookStep, LookWork, NeedsLook, NeedsLookRow } from './row.js';

/**
 * Needs a look, as a registry of the places its rows come from, each with its group, its order in
 * it, and its rows' keys. A source is a line here, never a side effect of a route module: the list
 * is worked out on a read thread, which loads no route. A later slice adds its file and its line.
 */
export const SOURCES: readonly LookSource[] = [setup, broken, failedGoldens, presetsFailed, unblamed, openFixes, ready, inconclusiveGoldens, presetsUnsure, coverage, decisions, security, local, retire];

/** Rows one source lists one by one; past them (and one more), a line stands for the rest. */
export const LOOK_CAP = 50;

const groupAt = new Map<string, number>(LOOK_GROUPS.map(([g], i) => [g, i]));

/** Sources in the list's order, by group, then by their order in it; two sources with one id throw, at load. */
export function ordered(sources: readonly LookSource[]): LookSource[] {
  const ids = new Set<string>();
  for (const s of sources) {
    if (ids.has(s.id)) throw new Error(`Needs a look has two sources named ${s.id}`);
    ids.add(s.id);
  }
  return [...sources].sort((a, b) => groupAt.get(a.group)! - groupAt.get(b.group)! || a.order - b.order);
}

const ORDERED = ordered(SOURCES);

/**
 * Every row, by group, then by its source's order, each source's rows in its own order: past the cap,
 * one line for the rest, which is no advice. Nothing here is put away yet: withDismissals
 * (dismissals.ts) reads what was, and gives the list its stamp.
 */
export function needsLook(w: LookWork, sources: readonly LookSource[] = ORDERED): Omit<NeedsLook, 'dismissals'> {
  const items: NeedsLookRow[] = [];
  for (const s of sources) {
    const rows = s.rows(w);
    if (rows.length <= LOOK_CAP + 1) {
      items.push(...rows);
      continue;
    }
    const n = rows.length - LOOK_CAP;
    const first = rows[0]!;
    const rest = s.rest ? s.rest(n, rows.slice(LOOK_CAP)) : { icon: first.icon, title: `${plural(n, 'more row')} like these`, detail: '', href: first.href };
    items.push(...rows.slice(0, LOOK_CAP), { key: `attn:rest:${s.id}`, group: s.group, kind: first.kind, step: null, runId: null, fixId: null, at: rows[LOOK_CAP]!.at, more: n, ...rest });
  }
  return { items, total: items.reduce((t, x) => t + (x.more ?? 1), 0) };
}

/**
 * What every source reads, read once: Fixes' list, the goldens failing now, each failing golden's
 * step, and the goldens each open fix holds, a golden being held when its failing run is the fix's
 * and its step is that fix's, or a crash's Find breaking commit or Revert.
 */
export function lookWork(store: Store, o: { goldens: GoldenList; teamStore: StoreNote | null; patchInTree?: PatchCheck | undefined; rewriteHere?: RewriteCheck | undefined; repairer?: string | null; budget?: number | undefined; next: NextStepWork | null; now: number; week: LookWork['week']; index: RunIndex }): LookWork {
  let reads: StepReads | null = null;
  const readsOnce = () => (reads ??= stepReads(store, o.index));
  const fixes = needsLookFixes(store, o.patchInTree ? { patchInTree: o.patchInTree } : {});
  const failing = o.goldens.length ? withGateLines(store, failingTests(store, { goldens: o.goldens })) : [];
  const steps = new Map<string, NextStep | null | undefined>();
  // Each failing golden's, and an inconclusive one's whose checks changed since: its run leads with Run tests.
  // A golden its injection gate failed leads with the gate's proof, as Tests does; the rest with their replay's step.
  for (const t of failing) if ((t.verdict === 'failed' || t.next === 'run-tests') && t.runId) steps.set(t.golden, t.failure === 'injection' ? goldenStep(store, t.golden, o.next, readsOnce()) : listedStep(store, t.runId, o.next, { reads: readsOnce() }));
  const open = new Set(fixes.filter((f) => f.kind === 'open').map((f) => f.fixId));
  const held = new Map<string, HeldGolden[]>();
  for (const t of failing) {
    const step = steps.get(t.golden);
    if (!t.fixId || !t.runId || !open.has(t.fixId) || !step || (step.key !== 'fix' && step.key !== 'bisect' && step.key !== 'revert')) continue;
    held.set(t.fixId, [...(held.get(t.fixId) ?? []), { golden: t.golden, name: goldenName(t.golden), runId: t.runId, step }]);
  }
  return {
    store,
    goldens: o.goldens,
    teamStore: o.teamStore,
    patchInTree: o.patchInTree,
    rewriteHere: o.rewriteHere,
    repairer: o.repairer ?? null,
    budget: o.budget,
    next: o.next,
    now: o.now,
    week: o.week,
    index: o.index,
    get reads() {
      return readsOnce();
    },
    fixes,
    failing,
    steps,
    held,
  };
}
