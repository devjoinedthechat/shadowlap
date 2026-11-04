import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { checkStatus } from './check-status.js';
import { argsMatch, evaluateChecks, storedCalls, storedCheckInput, type CheckInput } from './checks/evaluate.js';
import { hasChecks, type CallRule, type CheckResult, type TestEntry, type TestSpec } from './checks/grammar.js';
import { callRuleLabel, CHECK_MARKS, checkWords } from './checks/labels.js';
import { judgeRecording } from './checks/recorded.js';
import { isObject } from './is-object.js';
import { JUDGE_SCOPE } from './judge-scope.js';
import type { Price } from './prices.js';
import { recordingsOfRun, testsEntryFor } from './run-checks.js';
import type { Store, StoreOf } from './store.js';
import type { CallRecord, CheckStatus, RunRecord, StoredCheck } from './types.js';

/**
 * Runs judged by checks they were not given, from what they recorded, replaying nothing (A13, E26):
 *
 * - A run that kept no verdict of its own is judged by its family's checks: those of the goldens
 *   packed from its recording, or from a replay or a fork of it, as shadowlap.config.json's `tests`
 *   gives them now. `shadowlap check` judges a recording so (checks/recorded.ts), and so does the
 *   dashboard, so the two say the same; a judge check takes the verdict the recording holds for it,
 *   and without one is inconclusive, never passed.
 * - A capture is judged by the project's rules on calls when it is imported: every `calls` check in
 *   any golden's expect, since a rule on calls reads only the calls a run made and holds for any run
 *   of the agent. Counts, `when` rules, judges and budgets belong to their golden's own scenario and
 *   are not applied. Its verdict is kept on the run with the rules it was judged by, and it is
 *   judged again once they change.
 *
 * Plus the call a failed check turned on, for the pages to link: the call its detail names, else the
 * first call past what a count allows.
 */

// ---- A run's family ------------------------------------------------------------------------------

/** A golden as a run's family reads it: its pack's folder (relative to the project) and the run its pack holds. */
export interface FamilyGolden {
  path: string;
  runId: string | null;
}

/** A run's parent as the store has it: its id, null for a recording, undefined for a run the store doesn't have. */
export type ParentOf = (runId: string) => string | null | undefined;

/** Each run's parent, read from the store a run at a time. */
export function storeParents(store: StoreOf<'recording'>): ParentOf {
  return (runId) => {
    const r = store.getRun(runId);
    return r ? r.parentRunId : undefined;
  };
}

/** How far up a family is followed: further than any replay of a replay goes. */
const FAMILY_DEPTH = 256;

/** The run at the top of a run's family: the run itself or its oldest ancestor the store has; null for a run it doesn't have. */
export function familyRoot(runId: string, parentOf: ParentOf): string | null {
  if (parentOf(runId) === undefined) return null;
  let at = runId;
  const seen = new Set([at]);
  for (let i = 0; i < FAMILY_DEPTH; i++) {
    const up = parentOf(at);
    if (!up || seen.has(up) || parentOf(up) === undefined) break;
    seen.add(up);
    at = up;
  }
  return at;
}

/** A folder as the config's entries name it, resolved against the project, with no trailing separator. */
const folderOf = (dir: string, configDir: string) => resolve(configDir, dir).replace(/[\\/]+$/, '');

/**
 * The goldens of a run's family, nearest first: those the run or its ancestors replay or were
 * unpacked from (recordingsOfRun), then every other golden whose pack holds a run of the same family,
 * packed from its recording or from a replay or a fork of it.
 */
export function familyGoldens(store: StoreOf<'recording'>, run: RunRecord, goldens: readonly FamilyGolden[], configDir: string, parentOf: ParentOf = storeParents(store)): FamilyGolden[] {
  const out: FamilyGolden[] = [];
  const add = (g: FamilyGolden) => {
    if (!out.includes(g)) out.push(g);
  };
  const byFolder = new Map(goldens.map((g) => [folderOf(g.path, configDir), g]));
  for (const dir of recordingsOfRun(store, run)) {
    const g = byFolder.get(folderOf(dir, configDir));
    if (g) add(g);
  }
  const root = familyRoot(run.runId, parentOf);
  if (root !== null) for (const g of goldens) if (g.runId && familyRoot(g.runId, parentOf) === root) add(g);
  return out;
}

/** Each of these goldens with the checks its entry under `tests` gives it; a golden with none is left out. */
export function familySpecs(entries: readonly TestEntry[], goldens: readonly FamilyGolden[], configDir: string): Array<{ golden: string; spec: TestSpec }> {
  const out: Array<{ golden: string; spec: TestSpec }> = [];
  for (const g of goldens) {
    const entry = testsEntryFor(entries, g.path, configDir);
    if (entry && hasChecks(entry.spec)) out.push({ golden: g.path, spec: entry.spec });
  }
  return out;
}

// ---- The call a check turned on ------------------------------------------------------------------

/** The most a count's label allows, as formatCount writes it (`at most 1 time`, `2 times`, `0 to 3 tool calls`); Infinity for at least. */
function countMax(words: string): number | null {
  const m = /^(?:(at most|at least) )?(\d+)(?: to (\d+))? \S.*$/.exec(words);
  if (!m) return null;
  if (m[1] === 'at least') return Infinity;
  return Number(m[3] ?? m[2]);
}

/** The checks' labels with the condition a `when` rule puts before them taken off: what a count's label reads as. */
function countPart(label: string): string[] {
  const out = [label];
  if (label.startsWith('when ')) for (let i = label.indexOf(': '); i > 0; i = label.indexOf(': ', i + 2)) out.push(label.slice(i + 2));
  return out;
}

/** The calls of `name` a count counts, those with `args` (a label's JSON) alone when it gives them; null for arguments it can't read. */
function countedCalls(calls: readonly CallRecord[], name: string, args: string | undefined, argsOf: ((c: CallRecord) => unknown) | null): CallRecord[] | null {
  const named = calls.filter((c) => c.kind === 'tool' && c.name === name);
  if (args === undefined) return named;
  if (!argsOf) return null;
  let want: unknown;
  try {
    want = JSON.parse(args);
  } catch {
    return null;
  }
  return named.filter((c) => argsMatch(argsOf(c), want));
}

/** The first call past what a count allows, from the count's label: a tool's, or the model or tool calls'. */
function pastCount(label: string, agent: readonly CallRecord[], argsOf: ((c: CallRecord) => unknown) | null): number | null {
  for (const part of countPart(label)) {
    const tool = /^(\S+?)(?: with (\{.*\}))? called (.+)$/.exec(part);
    const kinds = /^(.+? (model|tool) calls?)$/.exec(part);
    const max = countMax(tool ? tool[3]! : kinds ? kinds[1]! : '');
    if (max === null || max === Infinity) continue;
    const counted = tool ? countedCalls(agent, tool[1]!, tool[2], argsOf) : agent.filter((c) => c.kind === (kinds![2] === 'model' ? 'api' : 'tool'));
    if (counted && counted.length > max) return [...counted].sort((a, b) => a.callNo - b.callNo)[max]!.callNo;
  }
  return null;
}

/**
 * The call a failed check turned on: the first call its detail names (`issue_refund #6: amount 240 >
 * …`, a rule's, under a `when` too), else for a count the first call past what it allows (`send_email
 * called at most 1 time` with two: the second), else null. With no calls given, only what the detail
 * names; `argsOf` reads a call's arguments, for a count of calls with some.
 */
export function checkCallAt(check: { label: string; detail: string | null }, calls: readonly CallRecord[] | null, argsOf: ((c: CallRecord) => unknown) | null = null): number | null {
  const named = /(?:^|; |: )(\S+) #(\d+)/.exec(check.detail ?? '');
  if (named) {
    const n = Number(named[2]);
    if (!calls || calls.some((c) => c.callNo === n && c.name === named[1])) return n;
  }
  if (!calls) return null;
  return pastCount(check.label, calls.filter((c) => c.meta?.scope !== JUDGE_SCOPE), argsOf);
}

// ---- A run judged by its family's checks ---------------------------------------------------------

/** A check of a family's golden as it came out on a run, with the golden it is from and the call it turned on. */
export interface FamilyCheck extends CheckResult {
  golden: string;
  callNo: number | null;
}

/** How a set of checks came out: failed when one failed, else inconclusive when one could not be decided, else passed when one passed; not applicable when none applied. */
export type ChecksVerdict = CheckStatus;

/** The verdict of checks as one: as checkOutcome, but not applicable when not one of them applied. */
export function checksVerdict(checks: ReadonlyArray<Pick<StoredCheck, 'ok' | 'status'>>): ChecksVerdict {
  const statuses = checks.map((c) => checkStatus(c));
  if (statuses.includes('failed')) return 'failed';
  if (statuses.includes('inconclusive')) return 'inconclusive';
  return statuses.includes('passed') ? 'passed' : 'not-applicable';
}

export interface FamilyJudged {
  /** The goldens whose checks judged it, nearest first. */
  goldens: string[];
  verdict: ChecksVerdict;
  /** Each check, a golden's after the nearest golden's with the same label left out. */
  checks: FamilyCheck[];
  /** The call the first failed check turned on. */
  callNo: number | null;
}

/**
 * A run judged from its recording by its family's checks (familySpecs), as `shadowlap check` judges
 * a recording: each golden's checks but those on the output, a judge by the verdict the run holds
 * for it. A check two goldens share is judged once, by the nearest. Null when none applies to it.
 */
export function judgeByFamily(store: Store, run: RunRecord, calls: CallRecord[], specs: ReadonlyArray<{ golden: string; spec: TestSpec }>, prices?: Record<string, Price>): FamilyJudged | null {
  const checks: FamilyCheck[] = [];
  const goldens: string[] = [];
  const input = storedCalls(store);
  for (const { golden, spec } of specs) {
    const judged = judgeRecording(store, run, calls, spec, prices).checks;
    let used = false;
    for (const c of judged) {
      if (checks.some((x) => x.label === c.label)) continue;
      checks.push({ ...c, golden, callNo: checkStatus(c) === 'failed' ? checkCallAt(c, calls, input.argsOf) : null });
      used = true;
    }
    if (used) goldens.push(golden);
  }
  if (!checks.length) return null;
  return { goldens, verdict: checksVerdict(checks), checks, callNo: checks.find((c) => checkStatus(c) === 'failed')?.callNo ?? null };
}

// ---- A capture judged by the rules on calls ------------------------------------------------------

/** Where the rules a capture is judged by are, as its verdict says it. */
export const RULES_ON_CALLS = 'the rules on calls in shadowlap.config.json';

/** The project's rules on calls: every `calls` check in any golden's expect, once each, and a key that changes when they do. */
export interface RulesOnCalls {
  rules: CallRule[];
  /** Changes when the rules do: a verdict kept under another is judged again. */
  key: string;
}

/** Every `calls` check under `tests`, in the order the entries give them, a rule two goldens share once. */
export function rulesOnCalls(entries: readonly TestEntry[]): RulesOnCalls {
  const rules: CallRule[] = [];
  const labels: string[] = [];
  for (const e of entries) {
    for (const rule of e.spec.calls ?? []) {
      const label = callRuleLabel(rule);
      if (labels.includes(label)) continue;
      labels.push(label);
      rules.push(rule);
    }
  }
  return { rules, key: createHash('sha256').update(labels.join('\n')).digest('hex').slice(0, 16) };
}

/** A capture's verdict by the rules on calls, as `shadowlap import` keeps it on the run (`meta.judged`). */
export interface CaptureVerdict {
  /** The rules it was judged by (RulesOnCalls.key). */
  rules: string;
  /** When it was judged. */
  at: number;
  /** Passed; failed, by the first rule's failure; or not applicable, when no rule had a call to read. */
  verdict: 'passed' | 'failed' | 'not-applicable';
  /** Why it is not applicable. */
  why: string | null;
  /** Each rule as it came out: one whose tool the capture never called did not apply. */
  checks: StoredCheck[];
}

/**
 * A capture judged by the rules on calls, from its calls, or null with no rule to judge it by. A rule
 * whose tool it never called does not apply; with none that did, the verdict is not applicable and
 * says why: a capture of the model calls alone holds no tool calls, which every rule reads.
 */
export function judgeCapture(store: Store, calls: CallRecord[], rules: RulesOnCalls, at = Date.now()): CaptureVerdict | null {
  if (!rules.rules.length) return null;
  const called = new Set(calls.filter((c) => c.kind === 'tool' && c.meta?.scope !== JUDGE_SCOPE).map((c) => c.name));
  const applies = rules.rules.filter((r) => called.has(r.tool));
  const input: CheckInput = storedCheckInput(store, calls, '');
  const judged = applies.length ? evaluateChecks({ tools: [], calls: applies }, input) : [];
  const checks: StoredCheck[] = rules.rules.map((rule) => {
    const label = callRuleLabel(rule);
    const r = judged.find((x) => x.label === label);
    return r ? { status: r.status, ok: r.ok, label, detail: r.detail } : { status: 'not-applicable', ok: true, label, detail: `${rule.tool} was never called` };
  });
  // A rule on calls holds or is broken (a value it can't read breaks it): never inconclusive.
  const verdict = checks.some((c) => c.status === 'failed') ? 'failed' : checks.some((c) => c.status === 'passed') ? 'passed' : 'not-applicable';
  const tools = [...new Set(rules.rules.map((r) => r.tool))];
  const why = verdict !== 'not-applicable' ? null : called.size ? `none of the rules' tools was called (${tools.join(', ')})` : 'it holds no tool calls, and every rule reads them';
  return { rules: rules.key, at, verdict, why, checks };
}

const VERDICTS: ReadonlyArray<CaptureVerdict['verdict']> = ['passed', 'failed', 'not-applicable'];

/** The verdict a capture kept when it was imported (`meta.judged`), read field by field: a run can come from someone else's pack. */
export function keptCaptureVerdict(run: Pick<RunRecord, 'meta'>): CaptureVerdict | null {
  const v: unknown = (run.meta as { judged?: unknown } | undefined)?.judged;
  if (!isObject(v) || typeof v.rules !== 'string' || !VERDICTS.includes(v.verdict as CaptureVerdict['verdict']) || !Array.isArray(v.checks)) return null;
  const checks = v.checks
    .filter((c): c is Record<string, unknown> & { ok: boolean; label: string } => isObject(c) && typeof c.ok === 'boolean' && typeof c.label === 'string')
    .map((c): StoredCheck => ({ ok: c.ok, label: c.label.slice(0, 2000), detail: typeof c.detail === 'string' ? c.detail.slice(0, 4000) : null, ...(typeof c.status === 'string' ? { status: checkStatus(c) } : {}) }));
  return { rules: v.rules, at: typeof v.at === 'number' && Number.isFinite(v.at) ? v.at : 0, verdict: v.verdict as CaptureVerdict['verdict'], why: typeof v.why === 'string' ? v.why.slice(0, 2000) : null, checks };
}

/**
 * A capture's verdict by the rules on calls as they are now: the one it kept when it was imported,
 * while the rules are those it was judged by; else judged again from its calls (`again`). Null with
 * no rule to judge it by. `calls` are read only to judge it again.
 */
export function captureVerdict(store: Store, run: RunRecord, rules: RulesOnCalls, calls: () => CallRecord[]): (CaptureVerdict & { again: boolean }) | null {
  const kept = keptCaptureVerdict(run);
  if (kept && kept.rules === rules.key) return { ...kept, again: false };
  const now = judgeCapture(store, calls(), rules);
  return now ? { ...now, again: true } : null;
}

/** A capture's verdict in a few words: `1 check passed`, `check failed: <rule>, but <what it found>`, `not applicable: <why>`. */
export function captureVerdictWords(v: Pick<CaptureVerdict, 'verdict' | 'why' | 'checks'>): string {
  if (v.verdict === 'not-applicable') return `not applicable: ${v.why ?? 'no rule had a call to read'}`;
  if (v.verdict === 'failed') {
    const first = v.checks.find((c) => checkStatus(c) === 'failed')!;
    return `check failed: ${checkWords(first, ', but ')}`;
  }
  const passed = v.checks.filter((c) => checkStatus(c) === 'passed').length;
  const na = v.checks.length - passed;
  return `${passed} check${passed === 1 ? '' : 's'} passed${na ? `, ${na} not applicable` : ''}`;
}

/** The line `shadowlap import` prints for a capture's verdict: `✓ judged by the rules on calls in shadowlap.config.json · 1 check passed`. */
export function captureVerdictLine(v: Pick<CaptureVerdict, 'verdict' | 'why' | 'checks'>): string {
  return `${CHECK_MARKS[v.verdict]} judged by ${RULES_ON_CALLS} · ${captureVerdictWords(v)}`;
}

