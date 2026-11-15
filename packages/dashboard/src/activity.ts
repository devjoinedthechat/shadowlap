import { basename } from 'node:path';
import { asTheyStand, checkStatus, hintsFor, INCONCLUSIVE_FIRST, lostRange, lostWords, NO_REPAIRER, outcomeCounts, pulledRun, summarizeRun, unrescuedKept, type DivergenceReport, type GateResult, type RunRecord, type RunSummary, type StoredCheck, type StoreOf, type StoredEvent } from '@shadowlap/engine';
import { num } from './fields.js';
import { links } from './links.js';
import { projectEventText } from './projects.js';
import { cachedRuns } from './run-cache.js';
import { shortReason, verdictOfResult } from './tests.js';
import { undecidedWhy } from './tests-why.js';
import { gateLine, gateRuleOf as ruleOf } from './verdict.js';
import { FEATURE_EVENT_TEXT, type Describe, type EventText } from './activity-events.js';
import type { ActivityItem, ActivityPage } from './views.js';

/**
 * The activity feed: what happened in this project, newest first. Most of it is read from the runs
 * themselves (a recording started and finished, a clean replay, a fork and its flag, `--repeat`
 * attempts, a capture imported, a test's checks, a blame); the rest from the events table, where a
 * command records what leaves nothing else behind (a normalizer added, a golden packed). The words
 * are the mock's.
 */

export const ACTIVITY_LIMIT = 50;
export const ACTIVITY_MAX = 200;

export type { EventText } from './activity-events.js';

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null);
/** A time from run meta, which a pack someone else made can carry as anything. */
const time = (v: unknown, fallback: number): number => num(v) ?? fallback;
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const short = (runId: string) => runId.slice(0, 10);
const FIX_ID = /^fx-[\w-]+$/;
const fixHref = (ref: string | null, step?: string) => (ref && FIX_ID.test(ref) ? links.fixes(ref, step ?? null) : links.fixes());
/** Where the team store's entries open: Settings → Store, which shows the bucket, its last sync and what is only here. */
const STORE_TAB = links.settings('store');
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter((s): s is string => s !== null) : []);
/** Words joined by the feed's separator, the empty ones left out. */
const parts = (...words: Array<string | null | false | undefined>) => words.filter(Boolean).join(' · ');
/**
 * What a push or a pull moved, by run as the screens count: "2 runs", "1 run and 5 attempts", "5
 * attempts", then the fixes that went with them; with no run, the fixes alone ("3 fixes").
 */
function moved(runs: number, attempts: number, fixes: number | null): { what: string; fixes: string | null } {
  const many = fixes ? plural(fixes, 'fix', 'fixes') : null;
  if (!runs && !attempts && many) return { what: many, fixes: null };
  return { what: !runs && attempts ? plural(attempts, 'attempt') : `${plural(runs, 'run')}${attempts ? ` and ${plural(attempts, 'attempt')}` : ''}`, fixes: many };
}

/** A trace import's source as the CLI names it: the trace store, and the trace id's first characters. */
const TRACE_SOURCE = /^(langfuse|langsmith|phoenix|logfire):/;

/** What a capture import is called in the feed: the source's name (`trace.json`, `langfuse:7f3a9c2e`), never its folder. */
function importName(e: StoredEvent, d: Record<string, unknown>): string {
  const from = str(d.source) ?? str(d.file) ?? e.ref ?? str(d.from);
  if (!from) return 'a capture';
  return TRACE_SOURCE.test(from) ? from : basename(from.replace(/[\\/]+$/, '')) || from;
}

/** Why a verify rejected a fix: the mock's words when it broke a good run, else its first reason. */
function rejection(d: Record<string, unknown>): string | null {
  const reasons = strings(d.reasons);
  if (reasons.some((r) => /^good run \S+ broken/.test(r))) return 'breaks a good run';
  return reasons[0] ?? str(d.why);
}

/**
 * The wording of every stored event kind, read from the fields each command records (documented in
 * packages/engine/src/events.ts), the features' own kinds among them (activity-events.ts), so every
 * thread that reads the feed has them all; an unknown kind reads as its name and its ref.
 */
const EVENT_TEXT = new Map<string, Describe>([
  ...FEATURE_EVENT_TEXT,
  ['normalizer.added', (e, d) => ({ kind: 'setting', text: `Normalizer added · ${str(d.path) ?? e.ref ?? 'every string'}`, href: links.settings('matching') })],
  ['normalizer.removed', (e, d) => ({ kind: 'setting', text: `Normalizer removed · ${str(d.path) ?? e.ref ?? 'every string'}`, href: links.settings('matching') })],
  // A redaction rule reads by what it puts in place and where, never by its pattern: a pattern can
  // hold the very text the rule is there to hide, and the feed is shown to the whole team.
  ['redaction.added', (_e, d) => ({ kind: 'setting', text: `Redaction rule added · ${str(d.replace) ?? 'a rule'}${str(d.path) ? ` at ${str(d.path)!}` : ''}`, href: links.settings('redaction') })],
  ['redaction.removed', (_e, d) => ({ kind: 'setting', text: `Redaction rule removed · ${str(d.replace) ?? 'a rule'}${str(d.path) ? ` at ${str(d.path)!}` : ''}`, href: links.settings('redaction') })],
  ['clock.set', (e, d) => ({ kind: 'setting', text: `Clock set to ${str(d.clock) ?? e.ref ?? 'auto'}`, href: links.settings('matching') })],
  // Settings → Tools' marks, and the Undo that takes one out, by the tool's name.
  ['tool.trust', (e, d) => ({ kind: 'setting', text: `${str(d.trust) ? `Tool marked ${str(d.trust)!}` : 'Tool mark removed'} · ${e.ref ?? 'a tool'}`, href: links.settings('tools') })],
  ['runs.cleaned', (_e, d) => ({ kind: 'setting', text: `Cleaned up ${plural(num(d.runs) ?? 0, 'old run')}`, href: links.settings('project') })],
  ['golden.packed', (e) => ({ kind: 'test', text: `Golden packed · ${e.ref ?? 'a golden'}`, href: links.tests() })],
  ['run.packed', (e, d) => ({ kind: 'project', text: `Packed · ${e.ref ?? plural(num(d.runs) ?? 1, 'run')}${num(d.calls) !== null ? ` · ${plural(num(d.calls)!, 'call')}` : ''}` })],
  ['golden.updated', (e, d) => ({ kind: 'test', text: parts(`Golden updated · ${e.ref ?? str(d.golden) ?? 'a golden'} re-recorded`, num(d.calls) !== null && plural(num(d.calls)!, 'call')), href: links.tests() })],
  // One import can make several runs (a LiteLLM log, one per conversation), each with its event:
  // the feed groups them (importStubs below), and this is the wording of one.
  ['capture.imported', (e, d) => ({ kind: 'cap', text: importText(importName(e, d), new Set([...(e.runId ? [e.runId] : []), ...strings(d.runIds)]).size, num(d.modelCalls) ?? num(d.calls)) })],
  [
    'test.session',
    (_e, d) => {
      const failed = num(d.failed) ?? 0;
      const notRun = num(d.notRun);
      // Inconclusive goldens are counted apart: neither passed nor failed.
      const inconclusive = num(d.inconclusive) ?? 0;
      const counts = `${num(d.passed) ?? 0} passed, ${failed} failed${inconclusive ? `, ${inconclusive} inconclusive` : ''}`;
      // The tests' shape, coloured by how they came out: red with a failure, amber inconclusive or stopped.
      const outcome = failed ? ('err' as const) : inconclusive || d.interrupted === true ? ('warn' as const) : null;
      const head = d.interrupted === true ? `Tests stopped · ${counts}${notRun ? `, ${notRun} not run` : ''}` : `Tests ran · ${counts}`;
      return { kind: 'test', ...(outcome ? { outcome } : {}), text: head, href: links.tests() };
    },
  ],
  // A golden's answer opens Tests, where it shows above the golden's buttons; a run's, the run.
  ['bisect.found', (e, d) => ({ kind: 'test', text: `First bad commit · ${str(d.commit) ?? e.ref ?? ''}${str(d.subject) ? ` ${str(d.subject)!}` : ''}`, href: e.runId ? links.run(e.runId) : links.tests() })],
  [
    'blame.done',
    (e, d) => {
      const href = fixHref(e.ref, 'blame');
      const title = str(d.title);
      const callNo = num(d.callNo);
      if (d.outcome === 'stopped') return { kind: 'blame', outcome: 'warn', text: parts('Blame stopped', title), href };
      // Its first probe couldn't tell: inconclusive, which is no finding that no call rescues it.
      if (d.outcome === 'unrescuable' && d.unsettled === true) return { kind: 'blame', outcome: 'warn', text: `Blamed · ${title ? `${title}, ` : ''}${INCONCLUSIVE_FIRST}`, href };
      // From any model call only where its bound bears that out, else from the first, as its report heads it.
      if (callNo === null || d.outcome === 'unrescuable') return { kind: 'blame', text: `Blamed · ${title ? `${title}, ` : ''}${unrescuedKept(d)}`, href };
      // Lost around or between two calls, when no one call is pinned (lostRange).
      // The mock's two lines: with the failure's title when the fix has one, else with the confidence.
      if (title) return { kind: 'blame', text: `Blamed · ${title}, ${lostWords(callNo, d.range, 'calls')}`, href };
      return { kind: 'blame', text: parts(lostRange(d.range) ? `Blamed · ${lostWords(callNo, d.range, 'calls')}` : `Blamed model call #${callNo}`, str(d.confidence) && `confidence ${str(d.confidence)!}`), href };
    },
  ],
  ['repair.accepted', (e, d) => ({ kind: 'fixok', text: `Repair accepted · ${str(d.title) ?? e.ref ?? ''}`, href: fixHref(e.ref, 'repair') })],
  ['repair.empty', (e, d) => repairEmpty(e, d)],
  // A kept preview's verify (`decisions --verify`) is worded by its session's name and opens the preview.
  ['verify.accepted', (e, d) => previewVerify(d, 'fixok', 'Verified', counted(d)) ?? fixVerdict(d, { kind: 'fixok', text: `Verify accepted · ${str(d.title) ?? e.ref ?? ''}`, href: verifyHref(e.ref, d) })],
  ['verify.rejected', (e, d) => previewVerify(d, 'fixbad', 'Verify rejected the change', counted(d) ?? rejection(d)) ?? fixVerdict(d, { kind: 'fixbad', text: `Verify rejected · ${rejection(d) ?? str(d.title) ?? e.ref ?? ''}`, href: verifyHref(e.ref, d) })],
  // A verify that settled nothing: why, by its first reason (a run left inconclusive, the provider gone).
  ['verify.incomplete', (e, d) => previewVerify(d, 'fixinc', 'Verify inconclusive', strings(d.reasons)[0] ?? null) ?? fixVerdict(d, { kind: 'fixinc', outcome: 'warn', text: `Verify inconclusive · ${strings(d.reasons)[0] ?? str(d.title) ?? e.ref ?? ''}`, href: verifyHref(e.ref, d) })],
  // A fix with no patch (verified on the working tree, or with a change of request fields) was only marked applied, as its page says.
  // One whose goldens then failed their test stays applied, and doesn't hold: red, in the drawer's words.
  ['fix.applied', (e, d) => ({ kind: 'fixok', ...(d.tests === 'failed' ? { outcome: 'err' as const } : {}), text: parts(`${d.patch === 'none' ? 'Marked applied' : 'Patch applied'} · ${str(d.title) ?? e.ref ?? ''}`, d.tests === 'failed' && 'tests failed'), href: fixHref(e.ref) })],
  // An open fix given another check (`shadowlap fix check`, the builder's Save check): what its runs must do now.
  ['fix.check', (e, d) => ({ kind: 'setting', text: `Check changed · ${str(d.title) ?? e.ref ?? ''}${str(d.check) ? `: ${str(d.check)!}` : ''}`, href: fixHref(e.ref) })],
  ['pairs.exported', (_e, d) => ({ kind: 'train', text: `Exported ${plural(num(d.pairs) ?? num(d.count) ?? 0, 'preference pair')}`, href: links.training() })],
  ['model.scored', (e, d) => ({ kind: 'train', text: parts(`Scored ${str(d.model) ?? e.ref ?? 'a model'} on ${plural(num(d.tasks) ?? 0, 'task')}`, num(d.mean) !== null && `mean ${num(d.mean)!.toFixed(2)}`), href: links.training('tasks') })],
  // In the projects pages' own words, so the feed and the project list say the same.
  ...(['project.added', 'project.setup', 'project.removed'] as const).map((kind): [string, Describe] => [kind, (e) => ({ kind: 'project', text: projectEventText(e) ?? kind, href: links.overview() })]),
  // The team store's set-up, as the store commands record it; the bucket is the entry's ref.
  ['store.set', (_e, d) => ({ kind: 'setting', text: str(d.previous) ? 'Store changed' : 'Store set' })],
  [
    'store.checked',
    (_e, d) => {
      if (d.ok === false) return { kind: 'fail', text: 'Store check failed' };
      return { kind: 'setting', text: parts('Store checked', (d.versioning === 'off' || d.versioning === 'suspended') && 'versioning off', d.objectLock === 'off' && 'no object lock') };
    },
  ],
  ['store.ci', (_e, d) => ({ kind: 'setting', text: `Push from CI ${d.push === false ? 'off' : 'on'}` })],
  // Settings → CI's Write file, and its Undo: the repository's workflow, written, put back or removed.
  [
    'ci.workflow',
    (e, d) => {
      const path = e.ref ?? 'the workflow';
      if (d.undo === true) return { kind: 'setting', text: d.removed === true ? `Removed ${path}` : `Put back ${path}`, href: links.settings('ci') };
      const lines = (count: unknown, word: string) => (typeof count === 'number' && count > 0 ? `${count} ${count === 1 ? 'line' : 'lines'} ${word}` : null);
      const counts = [lines(d.added, 'added'), lines(d.removed, 'taken out')].filter(Boolean).join(', ');
      return { kind: 'setting', text: parts(`Wrote ${path}`, counts), href: links.settings('ci') };
    },
  ],
  // The coding agents' skills, put into the project by `shadowlap skill install`: the Claude Code
  // plugin, or the skills alone in .agents/skills or .kiro/skills.
  [
    'skill.installed',
    (e, d) => {
      const updated = d.outcome === 'updated';
      const what = e.ref === 'claude-code' ? `Claude Code skills ${updated ? 'updated' : 'installed'}` : `Skills ${updated ? 'updated in' : 'added to'} ${str(d.path) ?? 'the project'}`;
      return { kind: 'setting', text: parts(what, str(d.version)), href: links.settings('agents') };
    },
  ],
  [
    'store.pushed',
    (_e, d) => {
      // `queued` is a count of runs left for later, or `true` for a push that was queued while they recorded.
      const queued = num(d.queued);
      const refused = num(d.refused);
      const m = moved((num(d.pushed) ?? num(d.runs) ?? 0) + (num(d.updated) ?? 0), num(d.attempts) ?? 0, num(d.fixes));
      return { kind: 'project', text: parts(`Pushed ${m.what} to the store`, m.fixes, queued ? `${queued} waiting` : null, refused ? `${refused} refused` : null) };
    },
  ],
  [
    'store.pulled',
    (_e, d) => {
      const m = moved(num(d.pulled) ?? num(d.runs) ?? 0, num(d.attempts) ?? 0, num(d.fixes));
      return { kind: 'project', text: parts(`Pulled ${m.what} from the store`, m.fixes, num(d.failed) ? `${num(d.failed)!} failed` : null) };
    },
  ],
  ['run.shared', (e, d) => ({ kind: 'project', text: parts(`Shared ${e.runId ? short(e.runId) : 'a run'} as a link`, (num(d.runs) ?? 1) > 1 && `with ${plural(num(d.runs)! - 1, 'more run')}`, d.redacted === true || (num(d.redacted) ?? 0) > 0 ? 'redacted' : null) })],
]);

/**
 * A kept preview's verify, as the feed tells it: `Verified · Model switch to claude-haiku-4-5: 1 fixed, 1 kept`,
 * its runs counted by how each came out, linked to the preview. Null for any other verify, a migration's too, which keeps a fix's words.
 */
function previewVerify(d: Record<string, unknown>, kind: 'fixok' | 'fixbad' | 'fixinc', lead: string, why: string | null): EventText | null {
  const id = str(d.session);
  const name = str(d.name);
  if (!id || !name || !/^dc-[\w-]+$/.test(id)) return null;
  return { kind, ...(kind === 'fixinc' ? { outcome: 'warn' as const } : {}), text: `${lead} · ${name}${why ? `: ${why}` : ''}`, href: links.changeSession('decisions', id) };
}

/** How a session verify's runs came out, counted in the engine's words (`1 fixed, 1 kept`); null where the event keeps none. */
function counted(d: Record<string, unknown>): string | null {
  return outcomeCounts(strings(d.outcomes)) || null;
}

/**
 * A verdict on a fix's runs as the feed tells it: one that counts for none of the fixes it names (a
 * check other than theirs, runs that passed already) is no verdict on them, so it is drawn plain, as
 * its Verify step draws it, and says so. A verify of runs in no fix (a migration's) keeps its colour.
 */
function fixVerdict(d: Record<string, unknown>, said: EventText): EventText {
  if (!strings(d.fixes).length || strings(d.counts).length) return said;
  return { ...said, outcome: 'plain', text: `${said.text} · doesn’t count for the fix` };
}

/**
 * A repair that accepted no candidate, by how its report ended (as `shadowlap repair` records it):
 * red only where it tried candidates and accepted none; amber where it stopped, had no fix to try, or
 * asked no repairer and tried nothing, in the words the job's drawer ends on.
 */
function repairEmpty(e: StoredEvent, d: Record<string, unknown>): EventText {
  const href = fixHref(e.ref, 'repair');
  const why = str(d.why) ?? str(d.title) ?? e.ref ?? '';
  if (d.outcome === 'stopped') return { kind: 'fixinc', outcome: 'warn', text: `Repair stopped · ${why}`, href };
  if (d.outcome === 'no-diagnosis') return { kind: 'fixinc', outcome: 'warn', text: `Repair had no fix to try · ${why}`, href };
  const unasked = num(d.candidates) === 0 ? notAsked(str(d.why)) : null;
  if (unasked) return { kind: 'fixinc', outcome: 'warn', text: `Repairer not asked · ${unasked}`, href };
  return { kind: 'fixbad', text: `Repair found no fix · ${why}`, href };
}

/** Why a repair asked no repairer, as its report's why says it then (`NO_REPAIRER`), without "the repairer could not be asked"; null for any other why. */
function notAsked(why: string | null): string | null {
  if (why?.startsWith(`${NO_REPAIRER.notAsked}: `)) return why.slice(NO_REPAIRER.notAsked.length + 2);
  return why === NO_REPAIRER.unconfigured || why === NO_REPAIRER.nothingToRewrite ? why : null;
}

/** A verify's page: under its fix, at the verdict when the event names it. */
function verifyHref(ref: string | null, d: Record<string, unknown>): string {
  const verifyId = str(d.verifyId);
  return ref && FIX_ID.test(ref) && verifyId && /^[\w-]+$/.test(verifyId) ? links.fixes(ref, 'verify', verifyId) : fixHref(ref, 'verify');
}

/** "Imported trace.json · 12 model calls", or for several runs "Imported litellm.jsonl · 3 runs · 40 model calls". */
function importText(name: string, runs: number, modelCalls: number | null): string {
  return parts(`Imported ${name}`, runs > 1 && plural(runs, 'run'), modelCalls !== null && plural(modelCalls, 'model call'));
}

/**
 * Sets how a stored event kind reads in the feed, for an embedder. A feature's own kinds go in
 * activity-events.ts instead: a describer registered from a route module never reaches the read
 * threads, which load no route module, and the feed is read there.
 */
export function describeEvent(kind: string, describe: Describe): void {
  EVENT_TEXT.set(kind, describe);
}


/**
 * What an event says, as the feed reads it. A blame recorded before its event carried the calls the
 * run was lost between takes them from the blame kept on its run, when that is the same blame (the
 * same call).
 */
function eventData(store: StoreOf<'recording'>, e: StoredEvent): Record<string, unknown> {
  const d = e.data ?? {};
  if (e.kind !== 'blame.done' || 'range' in d || !e.runId || typeof d.callNo !== 'number') return d;
  const b = store.getRun(e.runId)?.meta?.blame;
  return b && b.callNo === d.callNo && b.range ? { ...d, range: b.range } : d;
}

function storedItem(store: StoreOf<'recording'>, e: StoredEvent): ActivityItem {
  const describe = EVENT_TEXT.get(e.kind);
  let t: EventText;
  try {
    t = describe ? describe(e, eventData(store, e)) : fallback(e);
  } catch {
    t = fallback(e);
  }
  // The team store's entries open Settings → Store, whichever run one names.
  const href = t.href ?? (e.kind.startsWith('store.') ? STORE_TAB : e.runId ? links.run(e.runId) : undefined);
  const ref = e.ref ?? (e.runId ? short(e.runId) : undefined);
  return { id: `e:${e.eventId}`, at: e.at, kind: t.kind, ...(t.outcome ? { outcome: t.outcome } : {}), text: t.text, ...(e.runId ? { runId: e.runId } : {}), ...(href ? { href } : {}), ...(e.actor ? { actor: e.actor } : {}), ...(ref ? { ref } : {}) };
}

function fallback(e: StoredEvent): EventText {
  const words = e.kind.replace(/[._-]+/g, ' ').trim();
  return { kind: 'setting', text: `${words.charAt(0).toUpperCase()}${words.slice(1)}${e.ref ? ` · ${e.ref}` : ''}` };
}

// ---- what runs tell by themselves ----

interface Facts {
  summary: RunSummary;
  /** Calls answered from a changed tool result (`--override`). */
  overridden: number[];
  /** Kind and name of each call, in order: the path a run took. */
  path: string[];
}

const factsCache = new WeakMap<object, Map<string, Facts>>();

/** What a run's calls add up to; read once for a finished run. */
function facts(store: StoreOf<'recording'>, run: RunRecord): Facts {
  let cache = factsCache.get(store);
  if (!cache) {
    cache = new Map();
    factsCache.set(store, cache);
  }
  const key = `${run.runId}:${run.status}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const calls = store.getCalls(run.runId);
  const f: Facts = {
    summary: summarizeRun(run, calls),
    overridden: calls.filter((c) => c.origin === 'overridden').map((c) => c.callNo),
    path: calls.map((c) => `${c.kind}:${c.name}`),
  };
  if (run.status !== 'running') {
    if (cache.size > 5000) cache.clear();
    cache.set(key, f);
  }
  return f;
}

const command = (run: RunRecord) => {
  const text = run.command.argv.join(' ');
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
};

/**
 * The flags a fork was made with. A replay keeps them on its run (`meta.interventions`, each with its
 * flag, short: `--inject 15=Prefer sources…`, `--model 15:claude-opus-5`, `--writes stub`), and an
 * empty list says no flag changed it: a fork a code change made. For a run from before replays kept
 * them, its divergence and calls tell (`--fail-at 19=529`, `--diverge-at 5`, `--live-tool x`,
 * `--override 9`). The list is read as untrusted: a pack can carry anything.
 */
export function forkFlag(run: RunRecord, overridden: number[] = []): string | null {
  const listed = (run.meta as unknown as { interventions?: unknown } | undefined)?.interventions;
  if (Array.isArray(listed)) {
    const flags: string[] = [];
    for (const i of listed as unknown[]) {
      if (typeof i !== 'object' || i === null) continue;
      const { kind, flag } = i as { kind?: unknown; flag?: unknown };
      // A command given after `--` is not a flag: the run's own record names it.
      if (kind !== 'command' && typeof flag === 'string' && flag.trim()) flags.push(flag.trim());
    }
    const text = flags.join(' ');
    return !text ? null : text.length > 120 ? `${text.slice(0, 119)}…` : text;
  }
  const d = run.divergence;
  if (d?.type === 'forced' && d.reason) {
    const m = /^forced live by (--[a-z-]+ [^:,\s]+)/.exec(d.reason);
    if (m) return m[1]!;
  }
  if (overridden.length) return `--override ${overridden[0]!}`;
  return null;
}

/** What `pattern` a value that differs on every run matched, in words. */
const VOLATILE: Record<string, string> = { 'iso-datetime': 'a timestamp', 'iso-date': 'a date', uuid: 'a UUID', ulid: 'a ULID' };

/**
 * A replay that drifted rather than forked: every value its first changed request differs in is one
 * that changes on every run (a UUID, a timestamp), which a normalizer would mask. Returns what it
 * was ("a UUID"), or null for a real change (an edit, a flag).
 */
function drift(d: DivergenceReport): string | null {
  if (d.type !== 'request_changed' || !d.diff?.length) return null;
  let what: string | null = null;
  for (const entry of d.diff) {
    const hint = hintsFor(entry, d.kind, d.name)[0];
    if (!hint) return null;
    what ??= VOLATILE[hint.normalizer?.pattern ?? ''] ?? 'a value that changes on every run';
  }
  return what;
}

/** A run's checks: the first that failed, the first that could not be decided, and how they came out in words. */
function checksOutcome(run: RunRecord): { failed: string | null; inconclusive: string | null; text: string } | null {
  const checks = run.meta?.checks;
  if (!checks?.length) return null;
  const first = (status: 'failed' | 'inconclusive') => checks.find((c) => checkStatus(c) === status)?.label ?? null;
  return { failed: first('failed'), inconclusive: first('inconclusive'), text: checksPassed(checks) };
}

/**
 * `2 of 2 checks passed`, or with checks that did not pass or did not apply, `1 of 1 checks passed,
 * 2 not applicable`: a check that did not apply is not counted among those that could pass.
 */
function checksPassed(checks: readonly StoredCheck[]): string {
  const statuses = checks.map((c) => checkStatus(c));
  const n = (s: string) => statuses.filter((x) => x === s).length;
  const na = n('not-applicable');
  const inconclusive = n('inconclusive');
  return `${n('passed')} of ${checks.length - na} checks passed${inconclusive ? `, ${inconclusive} inconclusive` : ''}${na ? `, ${na} not applicable` : ''}`;
}

function base(run: RunRecord, id: string, at: number): Omit<ActivityItem, 'kind' | 'text'> {
  return { id, at, runId: run.runId, href: links.run(run.runId), ref: short(run.runId), ...(run.meta?.author ? { actor: run.meta.author } : {}) };
}

function recordingEnd(store: StoreOf<'recording'>, run: RunRecord): ActivityItem {
  const f = facts(store, run);
  const calls = plural(f.summary.total, 'call');
  const checks = checksOutcome(run);
  const item = base(run, `r:${run.runId}:end`, run.endedAt ?? run.startedAt);
  if (run.status === 'failed') return { ...item, kind: 'fail', text: `Recording failed · ${calls} · ${command(run)}` };
  if (checks?.failed) return { ...item, kind: 'fail', text: `Recorded ${calls} · check failed: ${checks.failed}` };
  if (checks?.inconclusive) return { ...item, kind: 'rec', outcome: 'warn', text: `Recorded ${calls} · check inconclusive: ${checks.inconclusive}` };
  if (run.status === 'crashed') return { ...item, kind: 'rec', text: `Recording interrupted · ${calls} · ${command(run)}` };
  return { ...item, kind: 'rec', text: `Recorded ${calls} · ${command(run)}` };
}

/**
 * A golden's replays in one test session, as one entry: a golden that may fork runs several
 * attempts, and its result, not each attempt, says how it did. The entry opens the replay the
 * result names (the one that failed, or the newest), and is told as of the newest attempt's end.
 */
function testEntry(store: StoreOf<'recording' | 'tests'>, attempts: RunRecord[]): ActivityItem {
  const newest = attempts.reduce((a, b) => ((b.endedAt ?? b.startedAt) > (a.endedAt ?? a.startedAt) ? b : a));
  const test = newest.meta!.test!;
  const result = store.listTestResults({ sessionId: test.session, golden: test.golden, limit: 1 })[0];
  const shown = (result?.runId ? attempts.find((r) => r.runId === result.runId) : undefined) ?? newest;
  return { ...testEnd(store, shown, test, result), id: `r:${newest.runId}:end`, at: newest.endedAt ?? newest.startedAt };
}

/**
 * A gate's verdict as the feed says it after the golden (decision 9): the verdict word, the tally and
 * the Wilson bound, and against history the baseline, `failed · 4 of 8 · rate <= 0.78 (95%) · against
 * 0.94 over the last 10 sessions (47 of 50)`; the rule it was decided by goes on the entry's hover
 * (`gateRuleOf`). Its tally alone when the result kept less.
 */
function gateTally(g: GateResult): string {
  try {
    return gateLine(g);
  } catch {
    return `${g.passes} of ${g.attempts} passed`;
  }
}

/** The rule a gate decided by, for an entry's hover: none for a clean replay, which its one attempt settled. */
function gateRuleOf(g: GateResult | null | undefined): { rule: string } | Record<string, never> {
  const rule = ruleOf(g);
  return rule ? { rule } : {};
}

function testEnd(store: StoreOf<'recording' | 'tests'>, run: RunRecord, test: { golden: string; session: string }, result = store.listTestResults({ sessionId: test.session, golden: test.golden, limit: 1 })[0]): ActivityItem {
  const f = facts(store, run);
  const golden = basename(test.golden.replace(/[\\/]+$/, '')) || test.golden;
  const checks = checksOutcome(run);
  const d = run.divergence;
  const item = { ...base(run, `r:${run.runId}:end`, run.endedAt ?? run.startedAt) };
  const drifted = d ? drift(d) : null;
  // Tests: the golden's result in its session says how it did, once it has one: its gate's
  // evidence, its attempts (every result keeps them, so only more than one says anything), or its
  // checks. A golden that may fork diverges by design, and passes on its checks; without the result,
  // the run says it.
  const gate = result?.data?.gate ?? null;
  const attempts = result?.data?.attempts;
  const repeated = !gate && attempts && attempts.total > 1 ? attempts : null;
  const judged = result?.data?.checks ?? null;
  // A count settled before an attempt a check could not decide keeps that attempt apart: it neither passed nor failed.
  const tally = (a: NonNullable<typeof repeated>) => `${a.passed} of ${a.total} attempts passed${a.inconclusive ? `, ${a.inconclusive} inconclusive` : ''}`;
  // Its gate ran out of attempts, or what else left it undecided: the provider, a check that could not be judged, its injection gate.
  if (result && verdictOfResult(result) === 'inconclusive') return { ...item, kind: 'warn', text: `Test inconclusive · ${golden}${gate?.decision === 'inconclusive' ? `: ${gateTally(gate)}` : ` · ${undecidedWhy(result)}`}`, ...(gate?.decision === 'inconclusive' ? gateRuleOf(gate) : {}) };
  if (result?.ok) {
    if (gate) return { ...item, kind: 'test', text: `Test passed · ${golden}: ${gateTally(gate)}`, ...gateRuleOf(gate) };
    const how = repeated ? tally(repeated) : judged?.length ? checksPassed(judged) : checks ? checks.text : d ? `forked at call ${d.callNo}` : `${f.summary.byOrigin.replayed}/${f.summary.total} replayed`;
    return { ...item, kind: 'test', text: `Test passed · ${golden} · ${how}` };
  }
  if (result && gate) return { ...item, kind: 'fail', text: `Test failed · ${golden}: ${gateTally(gate)}`, ...gateRuleOf(gate) };
  if (result && repeated) return { ...item, kind: 'fail', text: `Test failed · ${golden} · ${tally(repeated)}${typeof repeated.required === 'number' ? `, ${repeated.required} needed` : ''}` };
  const diverged = d && d.type !== 'forced' ? `diverged at call ${d.callNo}${drifted ? `, ${drifted}` : ''}` : null;
  if (result) return { ...item, kind: 'fail', text: `Test failed · ${golden} ${result.failure === 'diverged' && diverged ? diverged : shortReason(result)}` };
  const reason = diverged ?? (checks?.failed ? `check failed: ${checks.failed}` : run.status !== 'completed' ? 'the agent failed' : null);
  if (reason) return { ...item, kind: 'fail', text: `Test failed · ${golden} ${reason}` };
  // All it fell short on is a check that could not be decided: neither passed nor failed, as test says it.
  if (checks?.inconclusive) return { ...item, kind: 'warn', text: `Test inconclusive · ${golden} · check inconclusive: ${checks.inconclusive}` };
  const detail = checks ? checks.text : `${f.summary.byOrigin.replayed}/${f.summary.total} replayed`;
  return { ...item, kind: 'test', text: `Test passed · ${golden} · ${detail}` };
}

/**
 * A replay a check couldn't decide reads amber on its own shape (clean, forked or plain). One that
 * failed stays red, and a test's attempt is told by its test's result.
 */
function unsure(entry: ActivityItem, run: RunRecord): ActivityItem {
  const checks = checksOutcome(run);
  return run.meta?.test || entry.kind === 'fail' || checks?.failed || !checks?.inconclusive ? entry : { ...entry, outcome: 'warn' };
}

function replayEnd(store: StoreOf<'recording' | 'tests'>, run: RunRecord): ActivityItem {
  if (run.meta?.test) return testEntry(store, [run]);
  const f = facts(store, run);
  const s = f.summary;
  const checks = checksOutcome(run);
  const item = base(run, `r:${run.runId}:end`, run.endedAt ?? run.startedAt);
  const outcome = checks ? (checks.failed ? `check failed: ${checks.failed}` : checks.inconclusive ? `check inconclusive: ${checks.inconclusive}` : checks.text) : null;
  const d = run.divergence;
  const drifted = d ? drift(d) : null;
  if (d && drifted) {
    // Nobody forked it: a value that differs on every run parted it from the recording ("diverged · exit 1").
    const parts = [`Replay diverged at #${d.callNo} · ${drifted}`];
    if (outcome) parts.push(outcome);
    else if (run.status === 'failed') parts.push('the agent failed');
    else if (run.status === 'crashed') parts.push('interrupted');
    return { ...item, kind: 'fail', text: parts.join(' · ') };
  }
  if (d) {
    const flag = forkFlag(run, f.overridden);
    const parts = [`Forked at #${d.callNo}${flag ? ` with ${flag}` : ''}`, `${s.byOrigin.live} live`];
    if (s.byOrigin.blocked) parts.push(`${s.byOrigin.blocked} blocked`);
    if (s.byOrigin.stubbed) parts.push(`${s.byOrigin.stubbed} stubbed`);
    if (outcome) parts.push(outcome);
    else if (run.status === 'failed') parts.push('the agent failed');
    // Stopped before it ended (Ctrl-C, a kill), as every list says it.
    else if (run.status === 'crashed') parts.push('interrupted');
    return { ...item, kind: checks?.failed ? 'fail' : 'fork', text: parts.join(' · ') };
  }
  if (run.status === 'completed' && s.total > 0) {
    const parts = ['Replay clean', `${s.byOrigin.replayed}/${s.total}`, `${s.upstreamRequests} upstream`];
    if (outcome) parts.push(outcome);
    return { ...item, kind: checks?.failed ? 'fail' : 'clean', text: parts.join(' · ') };
  }
  // A replay that made no calls at all (nothing went through shadowlap) is not clean, and not a failure either.
  // "Clean replay" is what its icon says: a replay that made no calls, or was stopped, gets a plain replay's, "Replay".
  if (run.status === 'completed') return { ...item, kind: checks?.failed ? 'fail' : 'replay', text: `Replay finished · no calls${outcome ? ` · ${outcome}` : ''}` };
  const what = run.status === 'crashed' ? 'Replay interrupted' : 'Replay failed';
  return { ...item, kind: run.status === 'crashed' ? 'replay' : 'fail', text: `${what} · ${s.byOrigin.replayed}/${s.total} replayed${outcome ? ` · ${outcome}` : ''}` };
}

function imported(store: StoreOf<'recording'>, runs: RunRecord[], at: number): ActivityItem {
  const first = runs[0]!;
  const from = typeof first.meta?.imported?.from === 'string' ? first.meta.imported.from : '';
  // A capture a teammate pushed: a pull marks it with the store, not the file it came from.
  const name = pulledRun(first) ? 'a capture' : TRACE_SOURCE.test(from) ? from : basename(from.replace(/[\\/]+$/, '')) || 'a capture';
  const item = base(first, `r:${first.runId}:import`, at);
  if (first.meta?.covers?.length) {
    const models = runs.reduce((n, run) => n + facts(store, run).summary.byKind.api, 0);
    return { ...item, kind: 'cap', text: importText(name, runs.length, models) };
  }
  const detail = runs.length > 1 ? plural(runs.length, 'run') : plural(facts(store, first).summary.total, 'call');
  return { ...item, kind: 'cap', text: `Unpacked ${name} · ${detail}` };
}

/**
 * Items one command made one after another, grouped: the same key, each within a few seconds of the
 * one before it (an import of a hundred conversations makes a hundred runs in a row). Oldest first,
 * in each group and across them.
 */
function inBursts<T>(items: T[], key: (item: T) => string, at: (item: T) => number, tie: (item: T) => string): T[][] {
  const sorted = [...items].sort((a, b) => at(a) - at(b) || (tie(a) < tie(b) ? -1 : tie(a) > tie(b) ? 1 : 0));
  const open = new Map<string, { last: number; items: T[] }>();
  const groups: T[][] = [];
  for (const item of sorted) {
    const k = key(item);
    const t = at(item);
    const group = open.get(k);
    if (group && t - group.last <= BURST_MS) {
      group.items.push(item);
      group.last = t;
      continue;
    }
    const fresh = { last: t, items: [item] };
    open.set(k, fresh);
    groups.push(fresh.items);
  }
  return groups;
}

/**
 * The `capture.imported` events, one entry per import. cli-imports records one event per run it
 * keeps, so the events of one import (same person, same source, moments apart) are told together:
 * "Imported litellm.jsonl · 3 runs · 40 model calls". An event that lists its runs (`runIds`) is an
 * import of its own.
 */
function importStubs(store: StoreOf<'recording'>, events: StoredEvent[]): Stub[] {
  const key = (e: StoredEvent) => (Array.isArray(e.data?.runIds) ? `event:${e.eventId}` : `${e.actor ?? ''}\n${str(e.data?.from) ?? e.ref ?? ''}\n${str(e.data?.format) ?? ''}`);
  return inBursts(events, key, (e) => e.at, (e) => e.eventId).map((group) => {
    // The entry takes the newest event's place in the feed: when the import ended.
    const newest = group[group.length - 1]!;
    return { id: `e:${newest.eventId}`, at: newest.at, render: () => (group.length === 1 ? storedItem(store, newest) : importedEvents(group)) };
  });
}

function importedEvents(group: StoredEvent[]): ActivityItem {
  const first = group[0]!;
  const newest = group[group.length - 1]!;
  const runIds = new Set<string>();
  let calls: number | null = null;
  for (const e of group) {
    if (e.runId) runIds.add(e.runId);
    for (const id of strings(e.data?.runIds)) runIds.add(id);
    const n = num(e.data?.modelCalls) ?? num(e.data?.calls);
    if (n !== null) calls = (calls ?? 0) + n;
  }
  const runId = [...runIds][0];
  return {
    id: `e:${newest.eventId}`,
    at: newest.at,
    kind: 'cap',
    text: importText(importName(first, first.data ?? {}), Math.max(runIds.size, group.length), calls),
    ...(runId ? { runId, href: links.run(runId), ref: short(runId) } : first.ref ? { ref: first.ref } : {}),
    ...(first.actor ? { actor: first.actor } : {}),
  };
}

function blamed(run: RunRecord): ActivityItem {
  const b = run.meta!.blame!;
  const item = { ...base(run, `r:${run.runId}:blame`, time(b.at, run.endedAt ?? run.startedAt)), href: links.fixes() };
  if (b.outcome === 'blamed' && b.callNo !== null) return { ...item, kind: 'blame', text: `${lostRange(b.range) ? `Blamed · ${lostWords(b.callNo, b.range, 'calls')}` : `Blamed model call #${b.callNo}`} · confidence ${b.confidence}` };
  if (b.outcome === 'stopped') return { ...item, kind: 'blame', outcome: 'warn', text: `Blame stopped · ${plural(Array.isArray(b.probes) ? b.probes.length : 0, 'call')} probed` };
  // Its first probe couldn't tell: inconclusive, which is no finding that no call rescues it.
  if (b.unsettled === true) return { ...item, kind: 'blame', outcome: 'warn', text: `Blamed · ${INCONCLUSIVE_FIRST}` };
  // In the words every other place says it, from what the record keeps (`unrescuedKept`).
  return { ...item, kind: 'blame', text: `Blamed · ${unrescuedKept(b)}` };
}

function repeated(store: StoreOf<'recording'>, attempts: RunRecord[], parent: RunRecord | undefined): ActivityItem {
  const first = attempts[0]!;
  const of = first.meta?.repeat?.of ?? attempts.length;
  const at = Math.max(...attempts.map((a) => a.endedAt ?? a.startedAt));
  // The call most attempts forked at.
  const forks = new Map<number, number>();
  for (const a of attempts) if (a.divergence) forks.set(a.divergence.callNo, (forks.get(a.divergence.callNo) ?? 0) + 1);
  const forkAt = [...forks.entries()].sort((x, y) => y[1] - x[1] || x[0] - y[0])[0]?.[0] ?? null;
  let outcome: string;
  // An attempt stopped before it ended (Ctrl-C, its recorder killed) neither passed nor took a path of
  // its own: it is counted apart, as the Forks view's bundle counts it.
  const cut = attempts.filter((a) => a.status === 'crashed' && !a.meta?.checks?.length);
  const done = attempts.filter((a) => a.status !== 'running' && !cut.includes(a));
  if (!done.length && cut.length) {
    outcome = `${plural(cut.length, 'attempt')} interrupted`;
  } else if (done.length && done.every((a) => a.meta?.checks?.length)) {
    const passed = done.filter((a) => a.meta!.checks!.every((c) => c.ok)).length;
    // One that failed no check but had one that could not be decided is neither passed nor failed: counted apart.
    const unsure = done.filter((a) => !a.meta!.checks!.some((c) => checkStatus(c) === 'failed') && a.meta!.checks!.some((c) => checkStatus(c) === 'inconclusive')).length;
    outcome = `${passed} of ${done.length} passed their checks${unsure ? `, ${unsure} inconclusive` : ''}`;
  } else if (forkAt === null) {
    const clean = done.filter((a) => a.status === 'completed').length;
    outcome = `${clean} of ${done.length} replayed clean`;
  } else {
    // The path past the fork: the kinds and names of the calls each attempt made.
    const paths = new Map<string, number>();
    for (const a of done) {
      const key = facts(store, a).path.join('\n');
      paths.set(key, (paths.get(key) ?? 0) + 1);
    }
    const same = Math.max(0, ...paths.values());
    outcome = `${same} of ${done.length} took the same path`;
  }
  if (done.length && cut.length) outcome += ` · ${cut.length} interrupted`;
  const parentId = parent?.runId ?? first.parentRunId ?? first.runId;
  return {
    id: `g:${first.meta?.repeat?.group ?? first.runId}`,
    at,
    kind: 'fork',
    text: `replay --repeat ${of}${forkAt !== null ? ` at #${forkAt}` : ''} · ${outcome}`,
    runId: parentId,
    href: links.run(parentId, forkAt ?? 1, 'forks'),
    ref: short(parentId),
    ...(first.meta?.author ? { actor: first.meta.author } : {}),
    ...(attempts.some((a) => a.status === 'running') ? { live: true } : {}),
  };
}

interface Stub {
  id: string;
  at: number;
  render: () => ActivityItem;
}

/** How far apart the runs of one unpack can have been stamped, in stores from before unpack stamped one time for all. */
const UNPACK_SPREAD_MS = 5000;
/** How far apart, at most, two runs or events one import made one after another are. */
const BURST_MS = 5000;

/**
 * What each unpack brought in. The runs of one pack share its folder's name and the time unpack
 * stamped; and since a pack holds a run and its ancestors, a run whose parent came in moments
 * before from a folder of the same name belongs with it too.
 */
function unpackGroups(runs: RunRecord[]): Array<{ at: number; runs: RunRecord[] }> {
  const stamp = (run: RunRecord) => ({ at: time(run.meta?.imported?.at, run.startedAt), from: typeof run.meta?.imported?.from === 'string' ? run.meta.imported.from : '' });
  const sorted = [...runs].sort((a, b) => stamp(a).at - stamp(b).at || a.startedAt - b.startedAt);
  const groups: Array<{ from: string; at: number; runs: RunRecord[] }> = [];
  const byStamp = new Map<string, (typeof groups)[number]>();
  const byRun = new Map<string, (typeof groups)[number]>();
  for (const run of sorted) {
    const { at, from } = stamp(run);
    const parent = run.parentRunId ? byRun.get(run.parentRunId) : undefined;
    let group = byStamp.get(`${at}\n${from}`) ?? (parent && parent.from === from && at - parent.at <= UNPACK_SPREAD_MS ? parent : undefined);
    if (!group) {
      group = { from, at, runs: [] };
      groups.push(group);
    }
    group.runs.push(run);
    group.at = Math.max(group.at, at);
    byStamp.set(`${at}\n${from}`, group);
    byRun.set(run.runId, group);
  }
  return groups;
}

/**
 * A run another entry tells: blame's probes and verify's attempts are bundled under what made them, an
 * error-path preset's attempt is told by its session's chaos.session event, a scoring attempt (tasks
 * score) by its model.scored event, and an injection test's replay by its injection.tested event. The
 * last two are a --repeat group too, and never told as one.
 */
const toldElsewhere = (m: RunRecord['meta']): boolean => !!(m?.probe || m?.verify || m?.chaos || m?.task || m?.injection);

/** Every item the runs tell, as stubs: cheap to sort, rendered only for the page asked for. */
function derived(store: StoreOf<'recording' | 'activity' | 'tests'>, runs: RunRecord[], covered: Set<string>): Stub[] {
  const stubs: Stub[] = [];
  const byId = cachedRuns(store).byId;
  const groups = new Map<string, RunRecord[]>();
  // A golden's replays in one test session, by session and golden: one entry each (testEntry).
  const tested = new Map<string, RunRecord[]>();
  const unpacked: RunRecord[] = [];
  const captured: RunRecord[] = [];
  for (const run of runs) {
    const m = run.meta;
    if (m?.blame && !covered.has(`blame:${run.runId}`)) stubs.push({ id: `r:${run.runId}:blame`, at: time(m.blame.at, run.endedAt ?? run.startedAt), render: () => blamed(run) });
    if (toldElsewhere(m)) continue;
    if (m?.repeat) {
      const group = String(m.repeat.group);
      const list = groups.get(group) ?? [];
      list.push(run);
      groups.set(group, list);
      continue;
    }
    // A teammate's run pulled from the team store is told as what it is, by who made it, as a run made
    // here is: never as a pack. A capture they pushed is still a capture.
    if (m?.imported && (m.covers?.length || !pulledRun(run))) {
      if (m.covers?.length) {
        // A capture: told by its import's event when there is one, else grouped with the runs the same import made.
        if (!covered.has(`import:${run.runId}`)) captured.push(run);
      } else {
        // A pack can hold a run and its ancestors: one entry for everything one unpack brought in.
        unpacked.push(run);
      }
      continue;
    }
    if (run.mode === 'record') {
      stubs.push({
        id: `r:${run.runId}:start`,
        at: run.startedAt,
        render: () => ({ ...base(run, `r:${run.runId}:start`, run.startedAt), kind: 'live', text: `Recording started · ${command(run)}`, ...(run.status === 'running' ? { live: true } : {}) }),
      });
      if (run.status !== 'running') stubs.push({ id: `r:${run.runId}:end`, at: run.endedAt ?? run.startedAt, render: () => recordingEnd(store, run) });
    } else if (run.status !== 'running') {
      const test = m?.test;
      if (test && typeof test.session === 'string' && typeof test.golden === 'string') {
        const key = `${test.session}\n${test.golden}`;
        const list = tested.get(key);
        if (list) list.push(run);
        else tested.set(key, [run]);
        continue;
      }
      stubs.push({ id: `r:${run.runId}:end`, at: run.endedAt ?? run.startedAt, render: () => unsure(replayEnd(store, run), run) });
    }
  }
  for (const attempts of tested.values()) {
    const newest = attempts.reduce((a, b) => ((b.endedAt ?? b.startedAt) > (a.endedAt ?? a.startedAt) ? b : a));
    stubs.push({ id: `r:${newest.runId}:end`, at: newest.endedAt ?? newest.startedAt, render: () => testEntry(store, attempts) });
  }
  for (const attempts of groups.values()) {
    attempts.sort((a, b) => time(a.meta!.repeat!.attempt, 0) - time(b.meta!.repeat!.attempt, 0));
    const first = attempts[0]!;
    const at = Math.max(...attempts.map((a) => a.endedAt ?? a.startedAt));
    stubs.push({ id: `g:${String(first.meta!.repeat!.group)}`, at, render: () => repeated(store, attempts, first.parentRunId ? byId.get(first.parentRunId) : undefined) });
  }
  for (const { at, runs: list } of unpackGroups(unpacked)) {
    // Oldest first, so the entry names the root of what was unpacked.
    list.sort((a, b) => a.startedAt - b.startedAt);
    const first = list[0]!;
    if (covered.has(`import:${first.runId}`)) continue;
    stubs.push({ id: `r:${first.runId}:import`, at, render: () => imported(store, list, at) });
  }
  const importedAt = (run: RunRecord) => time(run.meta?.imported?.at, run.startedAt);
  const source = (run: RunRecord) => `${typeof run.meta?.author === 'string' ? run.meta.author : ''}\n${typeof run.meta?.imported?.from === 'string' ? run.meta.imported.from : ''}`;
  for (const list of inBursts(captured, source, importedAt, (run) => run.runId)) {
    const first = list[0]!;
    const at = importedAt(list[list.length - 1]!);
    stubs.push({ id: `r:${first.runId}:import`, at, render: () => imported(store, list, at) });
  }
  return stubs;
}

const stubCache = new WeakMap<object, { key: string; stubs: Stub[] }>();

/**
 * The derived entries, newest first, worked out again only when the runs or the events changed:
 * a page that polls the feed during a recording reads them once. (A recording's calls do not change
 * them: its entries name no counts until it ends, and an entry renders its counts when asked.)
 */
function derivedStubs(store: StoreOf<'recording' | 'activity' | 'tests'>): Stub[] {
  const counts = store.changeCounts();
  // A run its recorder left (killed, out of memory) reads interrupted, as every list shows it, and
  // ended at its last call: no longer recording. A recorder can stop with nothing in the store
  // changing, so the runs it left are part of what the entries are worked out for.
  const all = cachedRuns(store).runs;
  const runs = asTheyStand(store, all);
  const left = runs.filter((r, i) => r !== all[i]).map((r) => r.runId);
  const key = `${counts.runs ?? 0}:${counts.events ?? 0}:${left.join(',')}`;
  const hit = stubCache.get(store);
  if (hit && hit.key === key) return hit.stubs;
  // The newest 10,000 of the events that stand in for what runs tell; older ones are left out of the feed.
  const telling = store.listEvents({ kinds: ['capture.imported', 'blame.done'], limit: 10_000 });
  const imports = telling.filter((e) => GROUPED_KINDS.includes(e.kind));
  const stubs = [...derived(store, runs, coveredBy(telling)), ...importStubs(store, imports)].sort(order);
  stubCache.set(store, { key, stubs });
  return stubs;
}

/**
 * Stored kinds the feed tells with the runs rather than page by page from the events table: one
 * import records an event per run, and those are told together (importStubs).
 */
const GROUPED_KINDS = ['capture.imported'];

/** Runs whose derived entry a stored event already tells (an import, a blame recorded with its fix). */
function coveredBy(events: StoredEvent[]): Set<string> {
  const out = new Set<string>();
  for (const e of events) {
    const what = e.kind === 'blame.done' ? 'blame' : 'import';
    if (e.runId) out.add(`${what}:${e.runId}`);
    // An event can list the runs it tells of (an import of several conversations, recorded once).
    for (const id of strings(e.data?.runIds)) out.add(`${what}:${id}`);
  }
  return out;
}

// ---- paging ----

/**
 * Where a page ends: the time and id of its last entry. With no id it is a time alone, and every
 * entry at that time comes after it.
 */
interface Cursor {
  at: number;
  id: string | null;
}

/** Stored events (`e:` ids) come before entries derived from runs in the same millisecond. */
const lane = (id: string) => (id.startsWith('e:') ? 1 : 0);

/** The feed's one order, for sorting and for cursors alike: newest first, stored events first within a millisecond, then by id descending. */
function order(a: { at: number; id: string }, b: { at: number; id: string }): number {
  return b.at - a.at || lane(b.id) - lane(a.id) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

/** Whether an entry comes after the cursor, so on the page it starts. */
function after(cursor: Cursor | null, entry: { at: number; id: string }): boolean {
  if (!cursor) return true;
  if (cursor.id === null) return entry.at < cursor.at;
  return order({ at: cursor.at, id: cursor.id }, entry) < 0;
}

/** An entry, or a plain line in its place when its run carries something the feed cannot read (a pack can hold anything). */
function render(stub: Stub): ActivityItem {
  try {
    return stub.render();
  } catch {
    return { id: stub.id, at: stub.at, kind: 'setting', text: 'An entry the feed could not read' };
  }
}

/** `next`, opaque to the page: base64url of `[at, id]`. */
function encodeCursor(entry: { at: number; id: string }): string {
  return Buffer.from(JSON.stringify([entry.at, entry.id])).toString('base64url');
}

/**
 * Reads `before`: the `next` of the page before, or a time in milliseconds (everything older than
 * it). Null for a value that is neither.
 */
export function parseActivityCursor(text: string): { at: number; id: string | null } | null {
  if (/^\d{1,15}$/.test(text)) return { at: Number(text), id: null };
  if (text.length > 1024 || !/^[\w-]+$/.test(text)) return null;
  try {
    const v = JSON.parse(Buffer.from(text, 'base64url').toString('utf8')) as unknown;
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'number' && Number.isFinite(v[0]) && typeof v[1] === 'string' && v[1].length <= 512) return { at: v[0], id: v[1] };
  } catch {
    // not a cursor
  }
  return null;
}

/** The stored events after a cursor, as `listEvents` takes them. */
function storedAfter(cursor: Cursor | null): { before?: number; beforeId?: string } {
  if (!cursor) return {};
  // After a derived entry, the stored events of its millisecond came already (they sort first).
  if (cursor.id === null || lane(cursor.id) === 0) return { before: cursor.at };
  return { before: cursor.at, beforeId: cursor.id.slice(2) };
}

/**
 * A page of the feed, newest first: `limit` entries (50 by default, at most 200) after `before`,
 * which is the `next` of the page before (or a time in milliseconds: everything older). `next` is
 * null on the last page. Entries that share a millisecond keep one order, so paging never skips or
 * repeats one, and every page but the last has exactly `limit` entries.
 */
export function activity(store: StoreOf<'recording' | 'activity' | 'tests'>, options: { limit?: number; before?: string | number | null } = {}): ActivityPage {
  const limit = Math.min(ACTIVITY_MAX, Math.max(1, Math.floor(options.limit ?? ACTIVITY_LIMIT)));
  const given = options.before;
  const cursor: Cursor | null =
    given === undefined || given === null || given === ''
      ? null
      : typeof given === 'number'
        ? { at: given, id: null }
        : parseActivityCursor(given);
  if (given !== undefined && given !== null && given !== '' && !cursor) throw new Error(`not a page cursor: ${String(given).slice(0, 40)}`);
  const stubs = derivedStubs(store).filter((s) => after(cursor, s));
  // A page holds at most `limit` stored events; one more says whether any are left. Imports are
  // among the stubs already, one entry per import.
  const stored = store.listEvents({ ...storedAfter(cursor), limit: limit + 1, exceptKinds: GROUPED_KINDS });
  const all: Stub[] = [...stubs, ...stored.map((e) => ({ id: `e:${e.eventId}`, at: e.at, render: () => storedItem(store, e) }))].sort(order);
  const page = all.slice(0, limit);
  return { items: page.map(render), next: all.length > limit ? encodeCursor(page[page.length - 1]!) : null };
}
