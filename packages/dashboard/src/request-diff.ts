import {
  canonicalize,
  changedPathLabel,
  comparedRequest,
  isHeaderEntry,
  isObject,
  maskedChange,
  normalizeAddArgs,
  normalizeAddCommand,
  parsePath,
  pathSetByCode,
  requestReadRule,
  runInterventions,
  unmaskedHints,
  valueHintMessage,
  volatileValues,
  type CallKind,
  type CallRecord,
  type DiffEntry,
  type DivergenceReport,
  type DivergenceType,
  type Normalizer,
  type RunRecord,
  type Store,
  type VolatileValues,
} from '@shadowlap/engine';
import { lookupRun, noSuchRun } from './api.js';
import { answer, failed, type ReadTable } from './read-registry.js';
import { testOf, testRunBanner } from './tests.js';

/**
 * Show diff's read (`GET /api/runs/:id/diff[?call=<n>]`): the request a fork or a diverged replay
 * changed, as the recording sent it and as this run sent it, both whole and read as Compare reads
 * them (comparedRequest). With it, the path the finding names, each path that made it diverge with
 * what fixes it, and what no line of the bodies shows: changes matching masks, the headers and the
 * query, the clock. The fixes are decided here, never in the browser.
 *
 * A forced fork on a tool call (`--live-tool`, a tool's `--fail-at`, `--diverge-at` on a tool)
 * changed the tool's result, which the next model call is the first request to carry: by default that
 * call is shown, against the recording's call of its number, the two lining up while nothing ran
 * between them. Where a side's body isn't here (its run deleted, left out of an exported copy, or
 * kept without its request), both are built from the divergence's own changes (`whole: false`), as
 * far as the diff needs them: a model call's model, each path that changed, its conversation left out.
 *
 * It reads the run's calls, so it is worked out beside the server (read-pool.ts); an exported copy
 * calls `requestDiff` for each run it holds (static.ts).
 */

export type RequestDiffJob = { kind: 'request-diff'; runId: string; callNo: number | null; normalizers: Normalizer[] };

/**
 * What fixes a path that changed: a normalizer for a value made anew on every run, with what the CLI
 * says of it (`message`, the engine's words), or Update golden for what code or config sets.
 */
export type PathFix = { kind: 'normalizer'; looks: string; op: 'changed' | 'added'; certain: boolean; message: string; args: string[]; command: string } | { kind: 'update' };

/** A change that made the call diverge, at its path. */
export interface ChangedPath {
  path: string;
  /** What the path points at, as Compare labels it: `tool_result lookup_policy`, `issue_refund · amount`; null where nothing names it. */
  what: string | null;
  fix: PathFix | null;
}

export interface RequestDiff {
  /** This run's call shown, and whether its request or, for a tool whose request didn't change, its result. */
  at: number;
  what: 'request' | 'result';
  call: { kind: CallKind; name: string };
  /** The call it is compared with; null when there is none. */
  against: { runId: string; callNo: number } | null;
  /** The recording's side and this run's. */
  was: unknown;
  now: unknown;
  /** False when both sides are built from the divergence's changes alone, the rest of each body left out. */
  whole: boolean;
  /** Where `whole` is false, the keys the request holds that neither side does, drawn `[ … ]`: a model call's conversation (`messages`). */
  leftOut: string[];
  /** Both sides whole and the same: no diff to draw, only words. */
  same: boolean;
  /**
   * The run asked its call again as the recording did: the same call with the same body, and the call
   * a flag forced sent upstream (not failed in its place, nor answered with an intervention's refusal).
   * False where a model switched in the URL path left the body as recorded.
   */
  askedAgain: boolean;
  /** How the run left its recording (DivergenceReport `type`); null for a run that never did. */
  type: DivergenceType | null;
  /** The path the finding names, by its own rule; null where it names none (a forced fork). */
  path: string | null;
  /** Each change that made the shown call diverge, with what fixes it: none masked, none in the headers or the query. */
  paths: ChangedPath[];
  /** A test replay's: adding its normalizers still leaves the golden to update, as the steps the finding offers end. */
  updates: boolean;
  /** Changes matching masks, which made nothing diverge. */
  masked: string[];
  /** Changes outside the body: `headers.<name>`, `query.<name>`. */
  outside: string[];
  /** The engine's hints no path's fix says (the headers', the query's, the clock's), each with the rule it proposes. */
  hints: Array<{ message: string; command: string | null }>;
  /** The flag that made the fork, as the run keeps it: `--diverge-at 3`, `--override 16=@policy.json`; null for none. */
  flag: string | null;
  /** The tool whose result changed what the shown request carries: the call forced, overridden or planted. */
  tool: { callNo: number; name: string } | null;
  /** The first model call after the call shown, when the shown call is a tool's: the first request its result reaches. */
  next: number | null;
  /** The run is a test replay of a golden. */
  test: boolean;
}

/** Of a run's calls, the one numbered `n`. */
const callOf = (store: Store, runId: string, n: number): CallRecord | undefined => store.getCalls(runId, { only: [n] })[0];

/** The first model call after call `n` of a run, among the few after it. */
function nextModelCall(store: Store, runId: string, n: number): CallRecord | undefined {
  return store.getCalls(runId, { after: n, limit: 200 }).find((c) => c.kind === 'api');
}

/** Whether a call went upstream: not answered in its place with a failure a flag injected, offline, or an intervention's refusal. */
const sentUpstream = (c: CallRecord | undefined): boolean => !!c?.end && !c.end.meta.injected && !c.end.meta.offline && !c.end.meta.refused;

/** The call a replay served this one from: its recorded call, or the one whose result a flag changed. */
function servedFrom(c: CallRecord): number | null {
  const m = c.end?.meta;
  return typeof m?.replayedFrom === 'number' ? m.replayedFrom : typeof m?.overriddenFrom === 'number' ? m.overriddenFrom : null;
}

/** The call shown and the call it is compared with, or undefined where the run has no such call. */
function pickCalls(store: Store, run: RunRecord, d: DivergenceReport | null, callNo: number | null): { at: CallRecord; against: { runId: string; callNo: number } | null } | undefined {
  const parentId = d?.counterpart?.runId ?? run.parentRunId ?? null;
  if (callNo === null && d) {
    if (d.type === 'forced' && d.kind === 'tool' && parentId) {
      // Against the recording's first model call after the tool: the call of the same number while
      // the two line up, and still the right one where the agent retried the tool, or a live tool made
      // calls of its own, before its next model call.
      const next = nextModelCall(store, run.runId, d.callNo);
      const theirs = next && nextModelCall(store, parentId, d.counterpart?.callNo ?? d.callNo);
      if (next && theirs) return { at: next, against: { runId: parentId, callNo: theirs.callNo } };
    }
    const at = callOf(store, run.runId, d.callNo);
    return at && { at, against: d.counterpart ?? null };
  }
  if (callNo === null) return undefined;
  const at = callOf(store, run.runId, callNo);
  if (!at) return undefined;
  if (d && callNo === d.callNo) return { at, against: d.counterpart ?? null };
  return { at, against: parentId ? { runId: parentId, callNo: servedFrom(at) ?? callNo } : null };
}

/** A call's result as it is stored: `{ result }` or `{ error }`; null with none. */
function storedResult(store: Store, c: CallRecord): unknown {
  return c.end?.responseRef ? store.getJson(c.end.responseRef) : null;
}

/**
 * A divergence's changes as two bodies, each holding only the paths that changed, an array's item
 * keyed by its index under the array's key (`messages[16]`), as the diff keys it: what Show diff has
 * when a side's body isn't here. A path that can't be read is left out.
 */
export function entriesBodies(entries: readonly DiffEntry[]): { was: unknown; now: unknown } {
  const was: Record<string, unknown> = {};
  const now: Record<string, unknown> = {};
  for (const e of entries) {
    if (isHeaderEntry(e)) continue;
    const keys = entryKeys(e.path);
    if (!keys) continue;
    if (!keys.length) return { was: e.before ?? null, now: e.after ?? null };
    if (e.op !== 'added') setAt(was, keys, e.before);
    if (e.op !== 'removed') setAt(now, keys, e.after);
  }
  return { was, now };
}

/** A path's keys as the diff keys them, an index joined to the key before it; null for a path that can't be read. */
function entryKeys(path: string): string[] | null {
  let segs: ReturnType<typeof parsePath>;
  try {
    segs = parsePath(path);
  } catch {
    return null;
  }
  const keys: string[] = [];
  for (const s of segs) {
    if (s.type === 'wild') return null;
    if (s.type === 'key') keys.push(s.key);
    else keys.push(`${keys.pop() ?? ''}[${s.index}]`);
  }
  return keys;
}

function setAt(o: Record<string, unknown>, keys: readonly string[], v: unknown): void {
  let cur = o;
  keys.slice(0, -1).forEach((k) => {
    const next = cur[k];
    cur = (Object.hasOwn(cur, k) && typeof next === 'object' && next !== null && !Array.isArray(next) ? next : (cur[k] = {})) as Record<string, unknown>;
  });
  cur[keys.at(-1)!] = v;
}

/** The keys a model call's request holds its conversation under: Anthropic's and OpenAI's chat, Gemini's, OpenAI's Responses. */
const CONVERSATION = ['messages', 'contents', 'input'];

/**
 * The divergence's changes (`own`) as the two requests, as far as the diff needs them, as the design
 * builds them: a model call's model, read from a side's body that is here (`held`), then each path
 * that changed, and the conversation left out (`leftOut`) where no path sets it. Nothing where the
 * call shown isn't the one the run diverged at.
 */
function changesAlone(own: DivergenceReport | null, at: CallRecord, held: unknown): Pick<RequestDiff, 'was' | 'now' | 'leftOut'> {
  if (!own) return { was: {}, now: {}, leftOut: [] };
  const { was, now } = entriesBodies(own.diff ?? []);
  if (at.kind !== 'api' || !isObject(held) || !isObject(was) || !isObject(now)) return { was, now, leftOut: [] };
  const sets = (k: string) => Object.hasOwn(was, k) || Object.hasOwn(now, k);
  const model = typeof held.model === 'string' && !sets('model') ? { model: held.model } : {};
  const talk = CONVERSATION.find((k) => Object.hasOwn(held, k));
  return { was: { ...model, ...was }, now: { ...model, ...now }, leftOut: talk && !sets(talk) ? [talk] : [] };
}

/**
 * The two sides shown: both requests, as Compare reads them; a tool's results where its request is as
 * recorded; the divergence's changes alone (`own`, when the call shown is the one it diverged at) where
 * a side's body isn't here.
 */
function bodiesOf(store: Store, run: RunRecord, at: CallRecord, against: RequestDiff['against'], own: DivergenceReport | null, inFile: ReadonlySet<string> | undefined): Pick<RequestDiff, 'what' | 'was' | 'now' | 'whole' | 'leftOut'> & { theirs: CallRecord | undefined } {
  const parent = against && (!inFile || inFile.has(against.runId)) ? store.getRun(against.runId) : null;
  const theirs = parent && against ? callOf(store, parent.runId, against.callNo) : undefined;
  const rule = requestReadRule(parent ?? run, run);
  const read = (c: CallRecord) => comparedRequest(store, c, rule.rounded, rule.secretNames);
  // This run's body, read only for what a request built from its changes holds besides them: none where it can't be read.
  const held = (): unknown => {
    try {
      return own && at.kind === 'api' ? read(at) : null;
    } catch {
      return null;
    }
  };
  if (!theirs) return { what: 'request', ...changesAlone(own, at, held()), whole: false, theirs };
  const was = read(theirs);
  const now = read(at);
  if (at.kind !== 'api' && canonicalize(was) === canonicalize(now)) return { what: 'result', was: storedResult(store, theirs), now: storedResult(store, at), whole: true, leftOut: [], theirs };
  if (!theirs.requestRef || !at.requestRef) return { what: 'request', ...changesAlone(own, at, now ?? was), whole: false, theirs };
  return { what: 'request', was, now, whole: true, leftOut: [], theirs };
}

/** The path the finding names, by the finding's own rule (ui/run/banner.ts `findingPath`): a test's value made anew, else what it found diverged, else the first change. */
function findingPath(store: Store, run: RunRecord, d: DivergenceReport | null): string | null {
  const first = d?.diff?.[0]?.path ?? null;
  if (!first) return null;
  const t = testOf(run) ? testRunBanner(store, run.runId) : null;
  return t?.volatile?.path ?? t?.cause ?? first;
}

/** What fixes one value made anew on every run: its normalizer, with the command that adds it. */
function normalizerFix(v: VolatileValues['values'][number]): PathFix {
  return { kind: 'normalizer', looks: v.looks, op: v.op, certain: v.certain, message: valueHintMessage(v), args: normalizeAddArgs(v.normalizer), command: normalizeAddCommand(v.normalizer) };
}

/**
 * The changes that made the call diverge, each with what fixes it: the normalizer of a value made
 * anew on every run (a value inside an added object at its own path); on a test replay, Update golden
 * for what code or config sets in every request; nothing for the rest, a fork's change being the point
 * of the fork. The rest of the divergence's entries: what matching masks, and what sits outside the body.
 */
function changesOf(d: DivergenceReport, sides: { was: unknown; now: unknown }, values: VolatileValues, test: boolean, normalizers: readonly Normalizer[]): Pick<RequestDiff, 'paths' | 'masked' | 'outside' | 'hints'> {
  const paths: ChangedPath[] = [];
  const masked: string[] = [];
  const outside: string[] = [];
  for (const e of d.diff ?? []) {
    if (isHeaderEntry(e)) outside.push(e.path);
    else if (maskedChange(e, normalizers, d)) masked.push(e.path);
    else {
      const what = changedPathLabel(e, d, sides.was, sides.now);
      const under = values.values.filter((v) => v.path !== e.path && v.path.startsWith(e.path) && /^[.[]/.test(v.path.slice(e.path.length)));
      const own = values.values.find((v) => v.path === e.path);
      if (under.length && !own) for (const v of under) paths.push({ path: v.path, what, fix: normalizerFix(v) });
      else paths.push({ path: e.path, what, fix: own ? normalizerFix(own) : test && pathSetByCode(e.path, d.name) ? { kind: 'update' } : null });
    }
  }
  const fixed = new Set(paths.filter((p) => p.fix?.kind === 'normalizer').map((p) => p.path));
  const hints = unmaskedHints(d, normalizers)
    .filter((h) => !(h.normalizer?.path !== undefined && fixed.has(h.normalizer.path)))
    .map((h) => ({ message: h.message, command: h.normalizer ? normalizeAddCommand(h.normalizer) : null }));
  return { paths, masked, outside, hints };
}

/**
 * A fork's own flag and the tool whose result it changed, from the run's interventions (and its calls,
 * for a replay that kept none). `first`, what the first change that made the shown call diverge
 * points at, as the bodies label it (`tool_result lookup_policy`).
 */
function forkFacts(store: Store, run: RunRecord, d: DivergenceReport | null, at: number, first: string | null): Pick<RequestDiff, 'flag' | 'tool'> {
  if (run.mode !== 'replay' || testOf(run)) return { flag: null, tool: null };
  const calls = store.getCalls(run.runId);
  const own = runInterventions(store, run, calls).find((x) => x.flag !== '--writes' && x.flag !== '--reads');
  const reason = d?.type === 'forced' && d.reason ? d.reason.replace(/^forced live by /, '').split(/[:,] /)[0]! : null;
  const flag = own ? (own.value ? `${own.flag} ${own.value}` : own.flag) : reason;
  if (d?.type === 'forced' && d.kind === 'tool') return { flag, tool: { callNo: d.callNo, name: d.name } };
  const changed = own && (own.flag === '--override' || own.flag === '--inject-result') && own.callNo !== null ? calls.find((c) => c.callNo === own.callNo && c.kind === 'tool') : undefined;
  if (changed) return { flag, tool: { callNo: changed.callNo, name: changed.name } };
  // Else the tool whose result the first change sits in: the last call of that tool before the one shown.
  const label = first ? /^tool_result (\S+)/.exec(first) : null;
  const named = label ? calls.filter((c) => c.kind === 'tool' && c.name === label[1] && c.callNo < at).at(-1) : undefined;
  return { flag, tool: named ? { callNo: named.callNo, name: named.name } : null };
}

/**
 * The diff Show diff draws for a run: call `callNo` of it, or by default the call it diverged at (a
 * forced tool's, the next model call); null for a run that never diverged and no call asked, or a
 * call the run doesn't have. `normalizers`, the rules in force, say which changes matching masks.
 * `inFile`, an exported copy's runs: a counterpart outside them is said by the divergence's changes
 * alone, as if its run were gone.
 */
export function requestDiff(store: Store, run: RunRecord, callNo: number | null, normalizers: readonly Normalizer[], inFile?: ReadonlySet<string>): RequestDiff | null {
  const d = run.divergence ?? null;
  const picked = pickCalls(store, run, d, callNo);
  if (!picked) return null;
  const { at, against } = picked;
  // The divergence's changes are the shown call's only where it is the call the run diverged at.
  const own = d && at.callNo === d.callNo && at.kind === d.kind ? d : null;
  const { what, whole, leftOut, theirs, ...sides } = bodiesOf(store, run, at, against, own, inFile);
  const same = whole && canonicalize(sides.was) === canonicalize(sides.now);
  const test = testOf(run) !== null;
  const banner = test ? testRunBanner(store, run.runId) : null;
  const values = banner?.values ?? (d ? volatileValues(d, normalizers) : { values: [], explainsAll: false, coversAll: false });
  const changes = own ? changesOf(own, sides, values, test, normalizers) : { paths: [], masked: [], outside: [], hints: [] };
  const facts = forkFacts(store, run, d, at.callNo, changes.paths[0]?.what ?? null);
  return {
    at: at.callNo,
    what,
    call: { kind: at.kind, name: at.name },
    against,
    ...sides,
    whole,
    leftOut,
    same,
    // The forced call is the one the run diverged at: the shown one, or a tool's before it.
    askedAgain: same && theirs?.name === at.name && (d?.type !== 'forced' || sentUpstream(d.callNo === at.callNo ? at : callOf(store, run.runId, d.callNo))),
    type: d?.type ?? null,
    path: findingPath(store, run, d),
    ...changes,
    updates: !!banner?.normalizeAndTest?.at(-1)?.includes('--update'),
    ...facts,
    next: at.kind === 'api' ? null : (nextModelCall(store, run.runId, at.callNo)?.callNo ?? null),
    test,
  };
}

export const REQUEST_DIFF_READS: ReadTable<RequestDiffJob> = {
  'request-diff': (store, job) => {
    const run = lookupRun(store, job.runId);
    if (!run) {
      const no = noSuchRun(store, job.runId);
      return failed(no.status, no.message);
    }
    if (job.callNo !== null && !callOf(store, run.runId, job.callNo)) return failed(404, `no call #${job.callNo} in run ${run.runId}`);
    return answer({ diff: requestDiff(store, run, job.callNo, job.normalizers) }, { tagged: true });
  },
};
