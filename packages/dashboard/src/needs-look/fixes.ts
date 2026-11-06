import { type FixRecords, fixRecords, lostWords, shownBlame, unrescuedWords, unsettledFirst } from '@shadowlap/engine';
import { fixLead } from '../fix-lead.js';
import { changeWords } from '../fix-list.js';
import { fixHref, noAnswerLost, short } from '../fix-shared.js';
import { type NeedsLookItem, repairLeft } from '../fix-summary.js';
import { links } from '../links.js';
import { listedStep } from '../next-step.js';
import { aboutsOf, aboutsWithin } from '../run-about.js';
import { type HeldGolden, type LookSource, type LookStep, type LookWork, type NeedsLookRow, plural } from './row.js';

/*
 * Needs a look's rows about fixes: an applied fix that doesn't hold, the failing runs nobody has
 * blamed this week (one row), each open fix, and each verified fix not applied yet. Fixes' own list
 * (`needsLookFixes`) says which; these word them as the Overview shows them.
 */

const of = (w: LookWork, kind: NeedsLookItem['kind']) => w.fixes.filter((f) => f.kind === kind);

const recordsOf = (w: LookWork, fixId: string): FixRecords | null => {
  const fix = w.store.getFix(fixId);
  return fix ? fixRecords(w.store, fix) : null;
};

/** Main's row, kept first under Failing: the fix's page says why it doesn't hold. */
export const broken: LookSource = {
  id: 'broken',
  group: 'failing',
  order: 10,
  rows: (w) => of(w, 'broken').map((f) => ({ key: `attn:broken:${fixHref(f.fixId!)}`, group: 'failing', kind: 'broken', icon: 'fail', title: f.title, detail: f.detail, step: null, href: f.href, runId: null, fixId: f.fixId, at: f.at })),
  rest: (n) => ({ icon: 'fail', title: `${plural(n, 'more applied fix', 'more applied fixes')} ${n === 1 ? "doesn't" : "don't"} hold`, detail: 'each on Fixes', href: links.fixes() }),
};

/**
 * This week's failed runs that no blame and no fix holds, as one row: how many, the newest by its id
 * with what failed (its check, else that it failed), and Run blame on the newest where its page leads
 * with it. It opens Runs on Failed for this week's days. Older ones stay on Runs and on Fixes.
 */
export const unblamed: LookSource = {
  id: 'unblamed',
  group: 'failing',
  order: 40,
  rows: (w) => {
    const week = of(w, 'unblamed').filter((f) => f.at >= w.week.from && f.at < w.week.to);
    const newest = week[0];
    if (!newest?.runId) return [];
    const runId = newest.runId;
    const run = w.index.byId.get(runId);
    const what = run?.outcome.kind === 'check-failed' && run.outcome.check ? run.outcome.check : 'failed';
    const about = run ? (w.budget === undefined ? aboutsOf(w.store, w.index, [run]) : aboutsWithin(w.store, w.index, [run], { budget: w.budget })).get(runId) : undefined;
    // Run blame only where its page leads with it: blame can't take a run that made no model call, and a failed injection test's proof comes first.
    const next = listedStep(w.store, runId, w.next, { reads: w.reads });
    const n = week.length;
    // Its card names the run it blames: the newest, where the row stands for several.
    const blames = `Blames ${n > 1 ? 'the newest, ' : ''}${short(runId)}: finds the model call that lost it, then joins the fix its failure belongs to`;
    const step: LookStep | null = next?.key !== 'blame' ? null : next.capture ? { of: 'link', label: next.label, href: links.run(runId) } : { of: 'run', runId, step: { ...next, sub: blames } };
    const row: NeedsLookRow = {
      key: `attn:unblamed:${runId}`,
      group: 'failing',
      kind: 'unblamed',
      icon: 'fail',
      title: `${plural(n, 'failing run')} nobody has blamed`,
      detail: `${n > 1 ? 'newest ' : ''}${short(runId)} · ${what}`,
      step,
      href: links.runs({ types: 'failed', from: w.week.first, to: w.week.last }),
      runId,
      fixId: null,
      at: newest.at,
      ...(about?.text ? { about } : {}),
    };
    return [row];
  },
};

/**
 * Where an open fix's blame left it, then what changed and what verify made of it, from the same
 * steps as its stepper and its row on Fixes: `lost at model call #9 · prompt change, not verified
 * yet`, `lost at model call #9 · changed by hand, verify inconclusive` (`changeWords`), `blame
 * stopped part way · rescued up to #5 so far · no change yet`, `not rescued from any model call`. Where no answer of the model's lost it, it says where to look instead.
 */
export function openFixWords(rec: FixRecords): string {
  const b = shownBlame(rec);
  const where = !b
    ? 'not blamed yet'
    : b.outcome === 'blamed' && b.report.blamed
      ? lostWords(b.report.blamed.callNo, b.report.range, 'calls')
      : b.outcome === 'unrescuable'
        ? unrescuedWords(unsettledFirst(b.report))
        : `blame stopped part way${b.report.blamed ? ` · rescued up to #${b.report.blamed.callNo} so far` : ''}`;
  if (noAnswerLost(b)) return `${where} · look at the tools, the harness or the command`;
  const change = changeWords(rec);
  if (change) return `${where} · ${change}`;
  // A blame that found no call rescues the run, with no change tried, says nothing more.
  const last = rec.repairs.at(-1);
  const then = last ? repairLeft(last) : b?.outcome === 'unrescuable' && !unsettledFirst(b.report) ? '' : 'no change yet';
  return then ? `${where} · ${then}` : where;
}

/**
 * Each open fix: its title, its words, and each golden it holds (` · refund-in-limit fails on
 * Tests`), as one cause is one row. A held crash's Find breaking commit leads, else the fix's lead
 * (fix-lead.ts); where no answer of the model's lost it, a repair of the prompt is no fix, and the
 * row opens it. It opens the fix, at Blame unless blame found the call.
 */
export const openFixes: LookSource = {
  id: 'openFixes',
  group: 'failing',
  order: 50,
  rows: (w) =>
    of(w, 'open').flatMap((f) => {
      const rec = recordsOf(w, f.fixId!);
      if (!rec) return [];
      const b = shownBlame(rec);
      const held: HeldGolden[] = w.held.get(f.fixId!) ?? [];
      const bisect = held.find((h) => h.step.key === 'bisect');
      const lead = noAnswerLost(b) ? null : fixLead(w.store, rec, { patchInTree: w.patchInTree, rewriteHere: w.rewriteHere, repairer: w.repairer ?? null });
      const step: LookStep | null = bisect ? { of: 'run', runId: bisect.runId, step: bisect.step } : lead ? { of: 'fix', fixId: f.fixId!, lead } : null;
      const found = b?.outcome === 'blamed' && !!b.report.blamed;
      const row: NeedsLookRow = { key: `attn:fix:${fixHref(f.fixId!)}`, group: 'failing', kind: 'open', icon: 'blame', title: f.title, detail: openFixWords(rec) + held.map((h) => ` · ${h.name} fails on Tests`).join(''), step, href: found ? fixHref(f.fixId!) : fixHref(f.fixId!, 'blame'), runId: null, fixId: f.fixId, at: f.at };
      return [row];
    }),
  rest: (n) => ({ icon: 'blame', title: `${plural(n, 'more failure')} with no fix yet`, detail: 'each on Fixes', href: links.fixes() }),
};

/** A verified fix not applied yet, in main's words, its step the fix's lead: Apply fix, or Mark applied. */
export const ready: LookSource = {
  id: 'ready',
  group: 'ship',
  order: 10,
  rows: (w) =>
    of(w, 'ready').map((f) => {
      const rec = recordsOf(w, f.fixId!);
      const lead = rec ? fixLead(w.store, rec, { patchInTree: w.patchInTree, rewriteHere: w.rewriteHere, repairer: w.repairer ?? null }) : null;
      return { key: `attn:verified:${fixHref(f.fixId!)}`, group: 'ship', kind: 'ready', icon: 'fixok', title: f.title, detail: f.detail, step: lead ? { of: 'fix', fixId: f.fixId!, lead } : null, href: f.href, runId: null, fixId: f.fixId, at: f.at };
    }),
  rest: (n) => ({ icon: 'fixok', title: `${plural(n, 'more verified fix', 'more verified fixes')} ${n === 1 ? 'is' : 'are'} ready`, detail: 'each on Fixes', href: links.fixes() }),
};
