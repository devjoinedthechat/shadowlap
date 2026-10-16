import { basename } from 'node:path';
import { hintsFor, summarizeRun, type DivergenceReport, type RunRecord, type RunSummary, type Store, type StoredEvent } from '@shadowlap/engine';
import { projectEventText } from './projects.js';
import { cachedRuns } from './run-cache.js';
import { shortReason } from './tests.js';
import type { ActivityIcon, ActivityItem, ActivityPage } from './views.js';

/**
 * The activity feed: what happened in this project, newest first. Most of it is read from the runs
 * themselves (a recording started and finished, a clean replay, a fork and its flag, `--repeat`
 * attempts, a capture imported, a test's checks, a blame); the rest from the events table, where a
 * command records what leaves nothing else behind (a normalizer added, a golden packed). The words
 * are the mock's.
 */

export const ACTIVITY_LIMIT = 50;
export const ACTIVITY_MAX = 200;

/** How a stored event reads in the feed. */
export interface EventText {
  kind: ActivityIcon;
  text: string;
  /** Where it opens; defaults to its run, if it has one. */
  href?: string;
}

type Describe = (event: StoredEvent, data: Record<string, unknown>) => EventText;

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
/** A time from run meta, which a pack someone else made can carry as anything. */
const time = (v: unknown, fallback: number): number => num(v) ?? fallback;
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const short = (runId: string) => runId.slice(0, 10);
const FIX_ID = /^fx-[\w-]+$/;
const fixHref = (ref: string | null, step?: string) => (ref && FIX_ID.test(ref) ? `#/fixes/${ref}${step ? `/${step}` : ''}` : '#/fixes');
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter((s): s is string => s !== null) : []);
/** Words joined by the feed's separator, the empty ones left out. */
const parts = (...words: Array<string | null | false | undefined>) => words.filter(Boolean).join(' · ');

/** What a capture import is called in the feed: the source's name (`trace.json`, `langfuse:7f3a9c2e`), never its folder. */
function importName(e: StoredEvent, d: Record<string, unknown>): string {
  const from = str(d.source) ?? str(d.file) ?? e.ref ?? str(d.from);
  if (!from) return 'a capture';
  return /^(langfuse|langsmith):/.test(from) ? from : basename(from.replace(/[\\/]+$/, '')) || from;
}

/** Why a verify rejected a fix: the mock's words when it broke a good run, else its first reason. */
function rejection(d: Record<string, unknown>): string | null {
  const reasons = strings(d.reasons);
  if (reasons.some((r) => /^good run \S+ broken/.test(r))) return 'breaks a good run';
  return reasons[0] ?? str(d.why);
}

/**
 * The wording of every stored event kind, read from the fields each command records (documented in
 * packages/engine/src/events.ts). A feature that records a new kind adds its wording with
 * `describeEvent`; an unknown kind reads as its name and its ref.
 */
const EVENT_TEXT = new Map<string, Describe>([
  ['normalizer.added', (e, d) => ({ kind: 'setting', text: `Normalizer added · ${str(d.path) ?? e.ref ?? 'every string'}`, href: '#/settings/matching' })],
  ['normalizer.removed', (e, d) => ({ kind: 'setting', text: `Normalizer removed · ${str(d.path) ?? e.ref ?? 'every string'}`, href: '#/settings/matching' })],
  // A redaction rule reads by what it puts in place and where, never by its pattern: a pattern can
  // hold the very text the rule is there to hide, and the feed is shown to the whole team.
  ['redaction.added', (_e, d) => ({ kind: 'setting', text: `Redaction rule added · ${str(d.replace) ?? 'a rule'}${str(d.path) ? ` at ${str(d.path)}` : ''}`, href: '#/settings/redaction' })],
  ['redaction.removed', (_e, d) => ({ kind: 'setting', text: `Redaction rule removed · ${str(d.replace) ?? 'a rule'}${str(d.path) ? ` at ${str(d.path)}` : ''}`, href: '#/settings/redaction' })],
  ['clock.set', (e, d) => ({ kind: 'setting', text: `Clock set to ${str(d.clock) ?? e.ref ?? 'auto'}`, href: '#/settings/matching' })],
  ['runs.cleaned', (_e, d) => ({ kind: 'setting', text: `Cleaned up ${plural(num(d.runs) ?? 0, 'old run')}`, href: '#/settings/project' })],
  ['golden.packed', (e) => ({ kind: 'test', text: `Golden packed · ${e.ref ?? 'a golden'}`, href: '#/tests' })],
  ['run.packed', (e, d) => ({ kind: 'project', text: `Packed · ${e.ref ?? plural(num(d.runs) ?? 1, 'run')}${num(d.calls) !== null ? ` · ${plural(num(d.calls)!, 'call')}` : ''}` })],
  ['golden.updated', (e, d) => ({ kind: 'test', text: parts(`Golden updated · ${e.ref ?? str(d.golden) ?? 'a golden'} re-recorded`, num(d.calls) !== null && plural(num(d.calls)!, 'call')), href: '#/tests' })],
  // One import can make several runs (a LiteLLM log, one per conversation), each with its event:
  // the feed groups them (importStubs below), and this is the wording of one.
  ['capture.imported', (e, d) => ({ kind: 'cap', text: importText(importName(e, d), new Set([...(e.runId ? [e.runId] : []), ...strings(d.runIds)]).size, num(d.modelCalls) ?? num(d.calls)) })],
  [
    'test.session',
    (_e, d) => {
      const failed = num(d.failed) ?? 0;
      const notRun = num(d.notRun);
      if (d.interrupted === true) return { kind: 'fail', text: `Tests stopped · ${num(d.passed) ?? 0} passed, ${failed} failed${notRun ? `, ${notRun} not run` : ''}`, href: '#/tests' };
      return { kind: failed ? 'fail' : 'test', text: `Tests ran · ${num(d.passed) ?? 0} passed, ${failed} failed`, href: '#/tests' };
    },
  ],
  // A golden's answer opens Tests, where it shows above the golden's buttons; a run's, the run.
  ['bisect.found', (e, d) => ({ kind: 'test', text: `First bad commit · ${str(d.commit) ?? e.ref ?? ''}${str(d.subject) ? ` ${str(d.subject)}` : ''}`, href: e.runId ? `#/run/${e.runId}` : '#/tests' })],
  [
    'blame.done',
    (e, d) => {
      const href = fixHref(e.ref, 'blame');
      const title = str(d.title);
      const callNo = num(d.callNo);
      if (d.outcome === 'stopped') return { kind: 'blame', text: parts('Blame stopped', title), href };
      if (callNo === null || d.outcome === 'unrescuable') return { kind: 'blame', text: `Blamed · ${title ? `${title}, ` : ''}no single call rescued the run`, href };
      // The mock's two lines: with the failure's title when the fix has one, else with the confidence.
      if (title) return { kind: 'blame', text: `Blamed · ${title}, lost at model call #${callNo}`, href };
      return { kind: 'blame', text: parts(`Blamed model call #${callNo}`, str(d.confidence) && `confidence ${str(d.confidence)}`), href };
    },
  ],
  ['repair.accepted', (e, d) => ({ kind: 'fixok', text: `Repair accepted · ${str(d.title) ?? e.ref ?? ''}`, href: fixHref(e.ref, 'repair') })],
  ['repair.empty', (e, d) => ({ kind: 'fixbad', text: `Repair found no fix · ${str(d.why) ?? str(d.title) ?? e.ref ?? ''}`, href: fixHref(e.ref, 'repair') })],
  ['verify.accepted', (e, d) => ({ kind: 'fixok', text: `Verify accepted · ${str(d.title) ?? e.ref ?? ''}`, href: verifyHref(e.ref, d) })],
  ['verify.rejected', (e, d) => ({ kind: 'fixbad', text: `Verify rejected · ${rejection(d) ?? str(d.title) ?? e.ref ?? ''}`, href: verifyHref(e.ref, d) })],
  ['fix.applied', (e, d) => ({ kind: 'fixok', text: `Patch applied · ${str(d.title) ?? e.ref ?? ''}`, href: fixHref(e.ref) })],
  ['pairs.exported', (_e, d) => ({ kind: 'train', text: `Exported ${plural(num(d.pairs) ?? num(d.count) ?? 0, 'preference pair')}`, href: '#/training' })],
  ['model.scored', (e, d) => ({ kind: 'train', text: parts(`Scored ${str(d.model) ?? e.ref ?? 'a model'} on ${plural(num(d.tasks) ?? 0, 'task')}`, num(d.mean) !== null && `mean ${num(d.mean)!.toFixed(2)}`), href: '#/training/tasks' })],
  // In the projects pages' own words, so the feed and the project list say the same.
  ...(['project.added', 'project.setup', 'project.removed'] as const).map((kind): [string, Describe] => [kind, (e) => ({ kind: 'project', text: projectEventText(e) ?? kind, href: '#/' })]),
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
  [
    'store.pushed',
    (_e, d) => {
      // `queued` is a count of runs left for later, or `true` for a push that was queued while they recorded.
      const queued = num(d.queued);
      const refused = num(d.refused);
      return { kind: 'project', text: parts(`Pushed ${plural((num(d.pushed) ?? num(d.runs) ?? 0) + (num(d.updated) ?? 0), 'run')} to the store`, queued ? `${queued} waiting` : null, refused ? `${refused} refused` : null) };
    },
  ],
  ['store.pulled', (_e, d) => ({ kind: 'project', text: parts(`Pulled ${plural(num(d.pulled) ?? num(d.runs) ?? 0, 'run')} from the store`, num(d.failed) ? `${num(d.failed)} failed` : null) })],
  ['run.shared', (e, d) => ({ kind: 'project', text: parts(`Shared ${e.runId ? short(e.runId) : 'a run'} as a link`, (num(d.runs) ?? 1) > 1 && `with ${plural(num(d.runs)! - 1, 'more run')}`, d.redacted === true || (num(d.redacted) ?? 0) > 0 ? 'redacted' : null) })],
]);

/** A verify's page: under its fix, at the verdict when the event names it. */
function verifyHref(ref: string | null, d: Record<string, unknown>): string {
  const verifyId = str(d.verifyId);
  return ref && FIX_ID.test(ref) && verifyId && /^[\w-]+$/.test(verifyId) ? `${fixHref(ref, 'verify')}/${verifyId}` : fixHref(ref, 'verify');
}

/** "Imported trace.json · 12 model calls", or for several runs "Imported litellm.jsonl · 3 runs · 40 model calls". */
function importText(name: string, runs: number, modelCalls: number | null): string {
  return parts(`Imported ${name}`, runs > 1 && plural(runs, 'run'), modelCalls !== null && plural(modelCalls, 'model call'));
}

/** Sets how a stored event kind reads in the feed: a feature that records a new kind calls this from its route module. */
export function describeEvent(kind: string, describe: Describe): void {
  EVENT_TEXT.set(kind, describe);
}

function storedItem(e: StoredEvent): ActivityItem {
  const describe = EVENT_TEXT.get(e.kind);
  let t: EventText;
  try {
    t = describe ? describe(e, e.data ?? {}) : fallback(e);
  } catch {
    t = fallback(e);
  }
  const href = t.href ?? (e.runId ? `#/run/${e.runId}` : undefined);
  const ref = e.ref ?? (e.runId ? short(e.runId) : undefined);
  return { id: `e:${e.eventId}`, at: e.at, kind: t.kind, text: t.text, ...(e.runId ? { runId: e.runId } : {}), ...(href ? { href } : {}), ...(e.actor ? { actor: e.actor } : {}), ...(ref ? { ref } : {}) };
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

const factsCache = new WeakMap<Store, Map<string, Facts>>();

/** What a run's calls add up to; read once for a finished run. */
function facts(store: Store, run: RunRecord): Facts {
  let cache = factsCache.get(store);
  if (!cache) factsCache.set(store, (cache = new Map()));
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
  if (overridden.length) return `--override ${overridden[0]}`;
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

function checksOutcome(run: RunRecord): { failed: string | null; passed: number; total: number } | null {
  const checks = run.meta?.checks;
  if (!checks?.length) return null;
  const failed = checks.find((c) => !c.ok);
  return { failed: failed ? failed.label : null, passed: checks.filter((c) => c.ok).length, total: checks.length };
}

function base(run: RunRecord, id: string, at: number): Omit<ActivityItem, 'kind' | 'text'> {
  return { id, at, runId: run.runId, href: `#/run/${run.runId}`, ref: short(run.runId), ...(run.meta?.author ? { actor: run.meta.author } : {}) };
}

function recordingEnd(store: Store, run: RunRecord): ActivityItem {
  const f = facts(store, run);
  const calls = plural(f.summary.total, 'call');
  const checks = checksOutcome(run);
  const item = base(run, `r:${run.runId}:end`, run.endedAt ?? run.startedAt);
  if (run.status === 'failed') return { ...item, kind: 'fail', text: `Recording failed · ${calls} · ${command(run)}` };
  if (checks?.failed) return { ...item, kind: 'fail', text: `Recorded ${calls} · check failed: ${checks.failed}` };
  if (run.status === 'crashed') return { ...item, kind: 'rec', text: `Recording stopped · ${calls} · ${command(run)}` };
  return { ...item, kind: 'rec', text: `Recorded ${calls} · ${command(run)}` };
}

/**
 * A golden's replays in one test session, as one entry: a golden that may fork runs several
 * attempts, and its result, not each attempt, says how it did. The entry opens the replay the
 * result names (the one that failed, or the newest), and is told as of the newest attempt's end.
 */
function testEntry(store: Store, attempts: RunRecord[]): ActivityItem {
  const newest = attempts.reduce((a, b) => ((b.endedAt ?? b.startedAt) > (a.endedAt ?? a.startedAt) ? b : a));
  const test = newest.meta!.test!;
  const result = store.listTestResults({ sessionId: test.session, golden: test.golden, limit: 1 })[0];
  const shown = (result?.runId ? attempts.find((r) => r.runId === result.runId) : undefined) ?? newest;
  return { ...testEnd(store, shown, test, result), id: `r:${newest.runId}:end`, at: newest.endedAt ?? newest.startedAt };
}

function testEnd(store: Store, run: RunRecord, test: { golden: string; session: string }, result = store.listTestResults({ sessionId: test.session, golden: test.golden, limit: 1 })[0]): ActivityItem {
  const f = facts(store, run);
  const golden = basename(test.golden.replace(/[\\/]+$/, '')) || test.golden;
  const checks = checksOutcome(run);
  const d = run.divergence;
  const item = { ...base(run, `r:${run.runId}:end`, run.endedAt ?? run.startedAt) };
  const drifted = d ? drift(d) : null;
  // Tests: the golden's result in its session says how it did, once it has one: its attempts, or
  // its checks. A golden that may fork diverges by design, and passes on its checks; without the
  // result, the run says it.
  const attempts = result?.data?.attempts;
  const judged = result?.data?.checks ?? null;
  if (result?.ok) {
    const how = attempts ? `${attempts.passed} of ${attempts.total} attempts passed` : judged?.length ? `${judged.filter((c) => c.ok).length} of ${judged.length} checks passed` : checks ? `${checks.passed} of ${checks.total} checks passed` : d ? `forked at call ${d.callNo}` : `${f.summary.byOrigin.replayed}/${f.summary.total} replayed`;
    return { ...item, kind: 'test', text: `Test passed · ${golden} · ${how}` };
  }
  if (attempts && result) return { ...item, kind: 'fail', text: `Test failed · ${golden} · ${attempts.passed} of ${attempts.total} attempts passed, ${attempts.required} needed` };
  const diverged = d && d.type !== 'forced' ? `diverged at call ${d.callNo}${drifted ? `, ${drifted}` : ''}` : null;
  if (result) return { ...item, kind: 'fail', text: `Test failed · ${golden} ${result.failure === 'diverged' && diverged ? diverged : shortReason(result)}` };
  const reason = diverged ?? (checks?.failed ? `check failed: ${checks.failed}` : run.status !== 'completed' ? 'the agent failed' : null);
  if (reason) return { ...item, kind: 'fail', text: `Test failed · ${golden} ${reason}` };
  const detail = checks ? `${checks.passed} of ${checks.total} checks passed` : `${f.summary.byOrigin.replayed}/${f.summary.total} replayed`;
  return { ...item, kind: 'test', text: `Test passed · ${golden} · ${detail}` };
}

function replayEnd(store: Store, run: RunRecord): ActivityItem {
  if (run.meta?.test) return testEntry(store, [run]);
  const f = facts(store, run);
  const s = f.summary;
  const checks = checksOutcome(run);
  const item = base(run, `r:${run.runId}:end`, run.endedAt ?? run.startedAt);
  const outcome = checks ? (checks.failed ? `check failed: ${checks.failed}` : `${checks.passed} of ${checks.total} checks passed`) : null;
  const d = run.divergence;
  const drifted = d ? drift(d) : null;
  if (d && drifted) {
    // Nobody forked it: a value that differs on every run parted it from the recording ("diverged · exit 1").
    const parts = [`Replay diverged at #${d.callNo} · ${drifted}`];
    if (outcome) parts.push(outcome);
    else if (run.status === 'failed') parts.push('the agent failed');
    return { ...item, kind: 'fail', text: parts.join(' · ') };
  }
  if (d) {
    const flag = forkFlag(run, f.overridden);
    const parts = [`Forked at #${d.callNo}${flag ? ` with ${flag}` : ''}`, `${s.byOrigin.live} live`];
    if (s.byOrigin.blocked) parts.push(`${s.byOrigin.blocked} blocked`);
    if (s.byOrigin.stubbed) parts.push(`${s.byOrigin.stubbed} stubbed`);
    if (outcome) parts.push(outcome);
    else if (run.status === 'failed') parts.push('the agent failed');
    return { ...item, kind: checks?.failed ? 'fail' : 'fork', text: parts.join(' · ') };
  }
  if (run.status === 'completed' && s.total > 0) {
    const parts = ['Replay clean', `${s.byOrigin.replayed}/${s.total}`, `${s.upstreamRequests} upstream`];
    if (outcome) parts.push(outcome);
    return { ...item, kind: checks?.failed ? 'fail' : 'clean', text: parts.join(' · ') };
  }
  // A replay that made no calls at all (nothing went through Shadowlap) is not clean, and not a failure either.
  // "Clean replay" is what its icon says: a replay that made no calls, or was stopped, gets the plain one.
  if (run.status === 'completed') return { ...item, kind: checks?.failed ? 'fail' : 'rec', text: `Replay finished · no calls${outcome ? ` · ${outcome}` : ''}` };
  const what = run.status === 'crashed' ? 'Replay stopped' : 'Replay failed';
  return { ...item, kind: run.status === 'crashed' ? 'rec' : 'fail', text: `${what} · ${s.byOrigin.replayed}/${s.total} replayed${outcome ? ` · ${outcome}` : ''}` };
}

function imported(store: Store, runs: RunRecord[], at: number): ActivityItem {
  const first = runs[0]!;
  const from = typeof first.meta?.imported?.from === 'string' ? first.meta.imported.from : '';
  const name = /^(langfuse|langsmith):/.test(from) ? from : basename(from.replace(/[\\/]+$/, '')) || 'a capture';
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
function importStubs(events: StoredEvent[]): Stub[] {
  const key = (e: StoredEvent) => (Array.isArray(e.data?.runIds) ? `event:${e.eventId}` : `${e.actor ?? ''}\n${str(e.data?.from) ?? e.ref ?? ''}\n${str(e.data?.format) ?? ''}`);
  return inBursts(events, key, (e) => e.at, (e) => e.eventId).map((group) => {
    // The entry takes the newest event's place in the feed: when the import ended.
    const newest = group[group.length - 1]!;
    return { id: `e:${newest.eventId}`, at: newest.at, render: () => (group.length === 1 ? storedItem(newest) : importedEvents(group)) };
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
    ...(runId ? { runId, href: `#/run/${runId}`, ref: short(runId) } : first.ref ? { ref: first.ref } : {}),
    ...(first.actor ? { actor: first.actor } : {}),
  };
}

function blamed(run: RunRecord): ActivityItem {
  const b = run.meta!.blame!;
  const item = { ...base(run, `r:${run.runId}:blame`, time(b.at, run.endedAt ?? run.startedAt)), href: '#/fixes' };
  if (b.outcome === 'blamed' && b.callNo !== null) return { ...item, kind: 'blame', text: `Blamed model call #${b.callNo} · confidence ${b.confidence}` };
  if (b.outcome === 'stopped') return { ...item, kind: 'blame', text: `Blame stopped · ${plural(Array.isArray(b.probes) ? b.probes.length : 0, 'call')} probed` };
  return { ...item, kind: 'blame', text: 'Blamed · no single call rescued the run' };
}

function repeated(store: Store, attempts: RunRecord[], parent: RunRecord | undefined): ActivityItem {
  const first = attempts[0]!;
  const of = first.meta?.repeat?.of ?? attempts.length;
  const at = Math.max(...attempts.map((a) => a.endedAt ?? a.startedAt));
  // The call most attempts forked at.
  const forks = new Map<number, number>();
  for (const a of attempts) if (a.divergence) forks.set(a.divergence.callNo, (forks.get(a.divergence.callNo) ?? 0) + 1);
  const forkAt = [...forks.entries()].sort((x, y) => y[1] - x[1] || x[0] - y[0])[0]?.[0] ?? null;
  let outcome: string;
  const done = attempts.filter((a) => a.status !== 'running');
  if (done.length && done.every((a) => a.meta?.checks?.length)) {
    const passed = done.filter((a) => a.meta!.checks!.every((c) => c.ok)).length;
    outcome = `${passed} of ${done.length} passed their checks`;
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
  const parentId = parent?.runId ?? first.parentRunId ?? first.runId;
  return {
    id: `g:${first.meta?.repeat?.group ?? first.runId}`,
    at,
    kind: 'fork',
    text: `replay --repeat ${of}${forkAt !== null ? ` at #${forkAt}` : ''} · ${outcome}`,
    runId: parentId,
    href: `#/run/${parentId}/${forkAt ?? 1}/forks`,
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

/** Every item the runs tell, as stubs: cheap to sort, rendered only for the page asked for. */
function derived(store: Store, runs: RunRecord[], covered: Set<string>): Stub[] {
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
    if (m?.probe || m?.verify) continue; // bundled under the blame or verify that made them
    if (m?.task) continue; // a scoring attempt (tasks score): told by its model.scored event, not as a --repeat
    if (m?.repeat) {
      const group = String(m.repeat.group);
      const list = groups.get(group) ?? [];
      list.push(run);
      groups.set(group, list);
      continue;
    }
    if (m?.imported) {
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
      stubs.push({ id: `r:${run.runId}:end`, at: run.endedAt ?? run.startedAt, render: () => replayEnd(store, run) });
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

const stubCache = new WeakMap<Store, { key: string; stubs: Stub[] }>();

/**
 * The derived entries, newest first, worked out again only when the runs or the events changed:
 * a page that polls the feed during a recording reads them once. (A recording's calls do not change
 * them: its entries name no counts until it ends, and an entry renders its counts when asked.)
 */
function derivedStubs(store: Store): Stub[] {
  const counts = store.changeCounts();
  const key = `${counts.runs ?? 0}:${counts.events ?? 0}`;
  const hit = stubCache.get(store);
  if (hit && hit.key === key) return hit.stubs;
  // The newest 10,000 of the events that stand in for what runs tell; older ones are left out of the feed.
  const telling = store.listEvents({ kinds: ['capture.imported', 'blame.done'], limit: 10_000 });
  const imports = telling.filter((e) => GROUPED_KINDS.includes(e.kind));
  const stubs = [...derived(store, cachedRuns(store).runs, coveredBy(telling)), ...importStubs(imports)].sort(order);
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
export function activity(store: Store, options: { limit?: number; before?: string | number | null } = {}): ActivityPage {
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
  const all: Stub[] = [...stubs, ...stored.map((e) => ({ id: `e:${e.eventId}`, at: e.at, render: () => storedItem(e) }))].sort(order);
  const page = all.slice(0, limit);
  return { items: page.map(render), next: all.length > limit ? encodeCursor(page[page.length - 1]!) : null };
}
