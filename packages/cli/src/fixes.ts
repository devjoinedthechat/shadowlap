import { basename } from 'node:path';
import { BLAME_DEFAULTS, ciProvider, commitTitle, recordBlame, recordEvent, recordRepair, recordVerdict, resolveAuthor, SPRT_DEFAULTS, unsettledFirst, type BlameReport, type RecordedBlame, type RecordedRepair, type RecordedVerdict, type RepairReport, type SprtGate, type StepRerun, type Store, type VerifyReport } from '@shadowlap/engine';
import { EXIT_LABEL } from './attempts.js';
import { callRuleLabel, conditionLabel, evaluateChecks, formatAmount, judgeLabel, LABEL_INPUT, type CheckResult, type CountRange, type ExpectSpec, type TestSpec, type TextCheck, type ToolCheck } from './checks.js';
import { openStore, type GlobalOpts } from './shared.js';
import { quoteArgv, shortId } from './ui.js';

/**
 * What blame, verify and repair leave for Fixes (engine `fixes.ts` says how runs are grouped): a
 * title and a check in plain words for a fix a blame opens, a command line that runs each step
 * again, and the activity each step records. Recording never fails the command that did the work.
 */

// ---- A check, and a failure of it, in plain words ----------------------------------------------

const EMPTY_SPEC: TestSpec = { fork: true, repeat: 1, passes: 1, tools: [] };

const times = (n: number) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);
const plural = (n: number, noun: string) => `${n.toLocaleString('en-US')} ${noun}${n === 1 ? '' : 's'}`;
const capital = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

function countWords(r: CountRange): string {
  if (r.min === r.max) return r.min === 0 ? 'never' : times(r.min);
  if (r.max === Infinity) return `at least ${times(r.min)}`;
  if (r.min === 0) return `at most ${times(r.max)}`;
  return `${r.min} to ${r.max} times`;
}

function rangeWords(r: CountRange, noun: string): string {
  if (r.min === r.max) return plural(r.min, noun);
  if (r.max === Infinity) return `at least ${plural(r.min, noun)}`;
  if (r.min === 0) return `at most ${plural(r.max, noun)}`;
  return `${r.min.toLocaleString('en-US')} to ${plural(r.max, noun)}`;
}

/** `issue_refund never called with {"amount":240}`, `send_email called once`. */
function toolWords(t: ToolCheck): string {
  const args = t.args ? ` with ${JSON.stringify(t.args)}` : '';
  return t.count.min === 0 && t.count.max === 0 ? `${t.name} never called${args}` : `${t.name} called ${countWords(t.count)}${args}`;
}

function textWords(t: TextCheck | undefined, what: string): string[] {
  if (!t) return [];
  return [...t.includes.map((s) => `${what} includes "${s}"`), ...t.excludes.map((s) => `${what} doesn't include "${s}"`)];
}

/** What a passing run does, in plain words: the fix's check. The exit code alone when nothing else is asked. */
export function checkText(spec: TestSpec | null): string {
  if (!spec) return EXIT_LABEL;
  const parts = checkParts(spec);
  return parts.length ? parts.join('; ') : EXIT_LABEL;
}

/** Each check of a spec in plain words; a `when` rule's checks joined under its condition. */
function checkParts(spec: ExpectSpec): string[] {
  return [
    ...spec.tools.map(toolWords),
    ...(spec.modelCalls ? [rangeWords(spec.modelCalls, 'model call')] : []),
    ...(spec.toolCalls ? [rangeWords(spec.toolCalls, 'tool call')] : []),
    ...(spec.inputTokens ? [rangeWords(spec.inputTokens, 'input token')] : []),
    ...(spec.outputTokens ? [rangeWords(spec.outputTokens, 'output token')] : []),
    ...(spec.cost ? [`cost ${formatAmount(spec.cost)}`] : []),
    ...textWords(spec.output, 'output'),
    ...textWords(spec.answer, 'final answer'),
    ...(spec.calls ?? []).map(callRuleLabel),
    ...(spec.when ?? []).map((w) => `${conditionLabel(w.if)}: ${checkParts(w.then).join(' and ')}`),
    ...(spec.judge ?? []).map(judgeLabel),
  ];
}

/** Tool arguments as words: `amount 240`, `to ops@example.com, subject "Your refund"`. */
function argWords(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([k, v]) => `${k} ${typeof v === 'string' ? (/[\s,]/.test(v) || !v ? JSON.stringify(v) : v) : JSON.stringify(v)}`)
    .join(', ');
}

const counted = (detail: string, re: RegExp): number | null => {
  const m = re.exec(detail);
  return m ? Number(m[1]) : null;
};

/**
 * A calls rule's first problem, without the call numbers, as its fix's title says it (a fix groups
 * runs whose calls are numbered differently): its detail up to the first '; ' outside a quoted
 * value. Values are quoted as JSON (showValue), and one may hold '; ' or '#12' itself, as `body
 * "Replay works; see #12."` does: it is kept whole.
 */
export function firstProblem(detail: string): string {
  // The quoted values land at the odd places: JSON strings, escapes and all.
  const parts = detail.split(/("(?:[^"\\]|\\.)*")/);
  let out = '';
  for (const [i, part] of parts.entries()) {
    if (i % 2) {
      out += part;
      continue;
    }
    const end = part.indexOf('; ');
    out += (end < 0 ? part : part.slice(0, end)).replace(/ \(#\d+\)/g, '').replace(/ #\d+/g, '');
    if (end >= 0) break;
  }
  return out;
}

/** One check of a spec on its own, with how to say that a run failed it. */
interface CheckItem {
  spec: TestSpec;
  title: (detail: string) => string;
}

function checkItems(spec: TestSpec): CheckItem[] {
  const items: CheckItem[] = [];
  for (const t of spec.tools) {
    items.push({
      spec: { ...EMPTY_SPEC, tools: [t] },
      title: (detail) => {
        const n = counted(detail, /^called (\d+) times?/);
        const what = t.args ? ` with ${argWords(t.args)}` : '';
        if (t.count.max === 0) return `${t.name} called${what}`;
        if (n === null) return toolWords(t).replace(/^(\S+) /, '$1 not ');
        if (n === 0) return `${t.name} never called${what}`;
        const exact = t.count.min === t.count.max;
        if (n > t.count.max) return `${t.name} called ${times(n)}${what}, ${exact ? 'not' : 'more than'} ${times(t.count.max)}`;
        return `${t.name} called ${times(n)}${what}, ${exact ? 'not' : 'fewer than'} ${times(t.count.min)}`;
      },
    });
  }
  const ranged = (key: 'modelCalls' | 'toolCalls' | 'inputTokens' | 'outputTokens', noun: string) => {
    const r = spec[key];
    if (!r) return;
    items.push({
      spec: { ...EMPTY_SPEC, [key]: r },
      title: (detail) => {
        const n = counted(detail.replace(/,/g, ''), /^(\d+)/);
        if (n === null) return capital(`${noun}s not ${rangeWords(r, noun)}`);
        return n > r.max ? `${plural(n, noun)}, more than ${r.max.toLocaleString('en-US')}` : `${plural(n, noun)}, fewer than ${r.min.toLocaleString('en-US')}`;
      },
    });
  };
  ranged('modelCalls', 'model call');
  ranged('toolCalls', 'tool call');
  ranged('inputTokens', 'input token');
  ranged('outputTokens', 'output token');
  if (spec.cost) {
    const r = spec.cost;
    items.push({
      spec: { ...EMPTY_SPEC, cost: r },
      title: (detail) => {
        if (/^no price/.test(detail)) return capital(detail.split(';')[0]!);
        const usd = Number(/\$([\d.]+)/.exec(detail)?.[1]);
        const limit = (n: number) => (n < 0.01 ? `$${n}` : `$${n.toFixed(2)}`);
        return Number.isFinite(usd) && usd < r.min ? `Costs less than ${limit(r.min)}` : `Costs more than ${limit(r.max)}`;
      },
    });
  }
  for (const [what, t] of [['Output', spec.output], ['Final answer', spec.answer]] as const) {
    if (!t) continue;
    const key = what === 'Output' ? 'output' : 'answer';
    for (const s of t.includes) items.push({ spec: { ...EMPTY_SPEC, [key]: { includes: [s], excludes: [] } }, title: () => `${what} never says "${s}"` });
    for (const s of t.excludes) items.push({ spec: { ...EMPTY_SPEC, [key]: { includes: [], excludes: [s] } }, title: () => `${what} says "${s}"` });
  }
  for (const rule of spec.calls ?? []) {
    items.push({ spec: { ...EMPTY_SPEC, calls: [rule] }, title: (detail) => `${rule.tool}: ${firstProblem(detail.replace(/^[^:]*#\d+: /, ''))}` });
  }
  for (const w of spec.when ?? []) {
    for (const inner of checkItems({ ...EMPTY_SPEC, ...w.then })) {
      items.push({ spec: { ...EMPTY_SPEC, when: [{ if: w.if, then: inner.spec }] }, title: (detail) => `${inner.title(detail.replace(/; the condition held at .*$/s, ''))}, ${conditionLabel(w.if)}` });
    }
  }
  for (const j of spec.judge ?? []) {
    items.push({ spec: { ...EMPTY_SPEC, judge: [j] }, title: (detail) => (/^not judged/.test(detail) ? `Judge "${j.name}" not judged` : `Judge "${j.name}" answered ${j.pass === 'yes' ? 'no' : 'yes'}`) });
  }
  return items;
}

/**
 * A failure's title, from the check the recording failed first: `issue_refund called with amount
 * 240`, `send_email called twice, not once`, `Output never says "refund issued"`. A failure of the
 * exit code alone says how the agent exited.
 */
export function failureTitle(spec: TestSpec | null, recording: { checks: readonly CheckResult[]; failures: readonly string[] }): string {
  const failed = recording.checks.filter((c) => !c.ok);
  if (spec && failed.length) {
    for (const item of checkItems(spec)) {
      const label = evaluateChecks(item.spec, LABEL_INPUT)[0]?.label;
      const result = failed.find((c) => c.label === label);
      if (result) return item.title(result.detail ?? '');
    }
  }
  for (const f of recording.failures) {
    const code = /exited with code (\d+)/.exec(f);
    if (code) return `The agent exited with code ${code[1]!}`;
    if (/exited with a non-zero code/.test(f)) return 'The agent exited with an error';
    if (/timed out/.test(f)) return 'The agent timed out';
    if (/interrupted/.test(f)) return 'The run was interrupted';
  }
  return recording.failures[0] ? capital(recording.failures[0].split(', but ')[0]!) : 'The run failed';
}

// ---- Command lines ------------------------------------------------------------------------------

/** `--expect '<json>'`, or nothing for the exit code alone. */
const expectArgs = (expect: unknown): string[] => (expect === null || expect === undefined ? [] : ['--expect', JSON.stringify(expect)]);

const fieldValue = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));

const fieldArgs = (fields: Record<string, unknown>): string[] =>
  Object.entries(fields).flatMap(([k, v]) => (k === 'model' && typeof v === 'string' ? ['--model', v] : ['--set', `${k}=${fieldValue(v)}`]));

/** What every step takes that changes what it finds, when it differs from the default. */
export interface StepFlags {
  writes?: 'stub' | 'block';
  reads?: 'live' | 'replay';
  budget?: number | null;
  timeoutMs?: number | null;
  /** The command given after `--`, when it replaced each run's recorded one. */
  argv?: readonly string[] | null;
}

const stepArgs = (f: StepFlags): string[] => [
  ...(f.writes === 'block' ? ['--writes', 'block'] : []),
  ...(f.reads === 'replay' ? ['--reads', 'replay'] : []),
  ...(f.budget !== null && f.budget !== undefined ? ['--budget', String(f.budget)] : []),
  ...(f.timeoutMs !== null && f.timeoutMs !== undefined ? ['--timeout', String(Math.round(f.timeoutMs / 1000))] : []),
];

/** The command after `--` goes last, as it was typed. */
const commandArgs = (f: StepFlags): string[] => (f.argv?.length ? ['--', ...f.argv] : []);

/**
 * `--gate` with the figures that differ from the command's own defaults, as JSON; nothing when none
 * do. A fixed count is written out in full, since the gate is what runs without one.
 */
export function gateFlags(gate: SprtGate | null, defaults: Omit<SprtGate, 'kind'>, count: { attempts: number; passes?: number | undefined }): string[] {
  if (!gate) return ['--attempts', String(count.attempts), ...(count.passes !== undefined ? ['--passes', String(count.passes)] : [])];
  const differs = (['good', 'bad', 'risk', 'max'] as const).filter((k) => gate[k] !== defaults[k]);
  return differs.length ? ['--gate', JSON.stringify(Object.fromEntries(differs.map((k) => [k, gate[k]])))] : [];
}

type BlameFlags = StepFlags & { expect?: unknown; scope?: string | null; fields: Record<string, unknown>; attempts: number; needed: number; gate: SprtGate | null; scan?: number };

/** What a blame takes beyond its report and its kept scope and check: `--scan` and the step's flags. */
const blameExtras = (s: BlameFlags): string[] => [...(s.scan !== undefined && s.scan !== 2 ? ['--scan', String(s.scan)] : []), ...stepArgs(s)];

/** A blame command that blames the run the same way again. */
export function blameCommand(runId: string, s: BlameFlags): string {
  return quoteArgv(['shadowlap', 'blame', shortId(runId), ...expectArgs(s.expect), ...(s.scope ? ['--scope', s.scope] : []), ...fieldArgs(s.fields), ...gateFlags(s.gate, BLAME_DEFAULTS, { attempts: s.attempts, passes: s.needed }), ...blameExtras(s), ...commandArgs(s)]);
}

/**
 * The flags a blame kept beside its report, which Blame again runs it with (`StepRerun`): the same
 * as `blameCommand` writes beyond the run, its check, scope, rescue and gate, which the record holds.
 */
export function blameRerun(s: BlameFlags): StepRerun {
  return { flags: blameExtras(s), command: s.argv?.length ? [...s.argv] : null };
}

/** The runs a verify or repair was given, as they were given: ids or `label:<name>`. */
export interface RunSpecs {
  fixes?: string[] | undefined;
  holdout?: string[] | undefined;
  keeps?: string[] | undefined;
}

const runArgs = (r: RunSpecs): string[] => [...(r.fixes?.length ? ['--fixes', ...r.fixes] : []), ...(r.holdout?.length ? ['--holdout', ...r.holdout] : []), ...(r.keeps?.length ? ['--keeps', ...r.keeps] : [])];

const gateArgs = (gate: SprtGate | null, attempts: number, passes: number | undefined) => gateFlags(gate, SPRT_DEFAULTS, { attempts, passes });

export type VerifyFlags = StepFlags & { expect?: unknown; attempts: number; passes?: number | undefined; gate: SprtGate | null; fields: Record<string, unknown>; from?: readonly string[] | undefined; liveTools: string[]; failFast?: boolean; margin?: number | undefined; baseline?: 'paired' | 'history' | undefined; base?: string | undefined; build?: string | null | undefined };

/** Which model calls the change's fields change, and the tools it runs live. */
const changeArgs = (f: VerifyFlags): string[] => [...(f.from ?? []).flatMap((m) => ['--from', m]), ...f.liveTools.flatMap((t) => ['--live-tool', t])];

/** How good runs were kept, when given (against what, from which commit, by what margin), and the step's flags. */
const keptArgs = (f: VerifyFlags): string[] => [
  ...(f.margin !== undefined ? ['--margin', String(f.margin)] : []),
  ...(f.baseline ? ['--baseline', f.baseline] : []),
  ...(f.base ? ['--base', f.base] : []),
  ...(f.build ? ['--build', f.build] : []),
  ...(f.failFast ? ['--fail-fast'] : []),
  ...stepArgs(f),
];

export function verifyCommand(runs: RunSpecs, f: VerifyFlags): string {
  return quoteArgv(['shadowlap', 'verify', ...runArgs(runs), ...expectArgs(f.expect), ...fieldArgs(f.fields), ...changeArgs(f), ...gateArgs(f.gate, f.attempts, f.passes), ...keptArgs(f), ...commandArgs(f)]);
}

/**
 * The flags a verdict kept beside its report, which Run more attempts and Verify again run it with
 * (`StepRerun`): the same as `verifyCommand` writes beyond its runs, check, fields and gate, which
 * the report holds.
 */
export function verifyRerun(f: VerifyFlags): StepRerun {
  return { flags: [...changeArgs(f), ...keptArgs(f)], command: f.argv?.length ? [...f.argv] : null };
}

/** A repair command that repairs the same way again; how it hands over (`--apply`, `--branch`, `--pr`) is left out. */
export function repairCommand(
  runs: RunSpecs,
  f: StepFlags & { expect?: unknown; repairer?: string; candidates?: number; stronger?: string; scope?: string; set?: Record<string, unknown>; attempts: number; passes?: number; gate: SprtGate | null; maxGrowth?: number; build?: string | null },
): string {
  return quoteArgv([
    'shadowlap',
    'repair',
    ...runArgs(runs),
    ...expectArgs(f.expect),
    ...(f.repairer ? ['--repairer', f.repairer] : []),
    ...(f.candidates !== undefined && f.candidates !== 3 ? ['--candidates', String(f.candidates)] : []),
    ...(f.stronger ? ['--stronger', f.stronger] : []),
    ...(f.scope ? ['--scope', f.scope] : []),
    ...Object.entries(f.set ?? {}).flatMap(([k, v]) => ['--set', `${k}=${fieldValue(v)}`]),
    ...gateArgs(f.gate, f.attempts, f.passes),
    ...(f.maxGrowth !== undefined && f.maxGrowth !== 0.25 ? ['--max-growth', String(+(f.maxGrowth * 100).toFixed(4))] : []),
    ...(f.build ? ['--build', f.build] : []),
    ...stepArgs(f),
    ...commandArgs(f),
  ]);
}

// ---- Recording ---------------------------------------------------------------------------------

const actor = () => resolveAuthor({ cwd: process.cwd() });

/**
 * Keeps a blame and opens or joins its fix, in the store the blame used. Returns null, and adds a
 * warning to the report, when the store refuses: the blame itself still stands. `command` is the
 * blame as it was typed; without one (a blame a repair ran) it is made from the settings.
 */
export function recordBlameFix(
  store: Store,
  input: {
    runId: string;
    report: BlameReport;
    settings: StepFlags & { spec: TestSpec | null; expect?: unknown; scope?: string | null; fields: Record<string, unknown>; attempts: number; needed: number; gate: SprtGate | null; scan?: number };
    recording: { checks: readonly CheckResult[]; failures: readonly string[] };
    command?: string | undefined;
  },
): RecordedBlame | null {
  const s = input.settings;
  try {
    const who = actor();
    // A repair's budget for its blames is what it had left, not something to type again.
    const flags = input.command !== undefined ? s : { ...s, budget: null };
    const recorded = recordBlame(store, {
      runId: input.runId,
      report: input.report,
      expect: s.expect ?? null,
      scope: s.scope ?? null,
      command: input.command ?? blameCommand(input.runId, flags),
      rerun: blameRerun(flags),
      title: failureTitle(s.spec, input.recording),
      checkText: checkText(s.spec),
      actor: who,
      ci: ciProvider(process.env),
    });
    recordEvent(store, {
      kind: 'blame.done',
      actor: who,
      runId: input.runId,
      ref: recorded.fix.fixId,
      // The calls it was lost between, so the activity feed can say a run lost gradually around two (`gradual`).
      data: { outcome: input.report.outcome, callNo: input.report.blamed?.callNo ?? null, confidence: input.report.confidence, title: recorded.fix.title, opened: recorded.created, ...(unsettledFirst(input.report) ? { unsettled: true } : {}), ...(input.report.range ? { range: { from: input.report.range.from, to: input.report.range.to, ...(input.report.range.gradual ? { gradual: true } : {}) } } : {}) },
    });
    return recorded;
  } catch (err) {
    input.report.warnings.push(`the blame could not be kept with its fix: ${(err as Error).message}`);
    return null;
  }
}

/** Keeps a verify's verdict, whatever it was, and links it to the fix of its runs, with the flags it ran with (`verifyRerun`). */
export function recordVerifyFix(opts: GlobalOpts, report: VerifyReport, input: { expect?: unknown; command: string; rerun?: StepRerun | null }): RecordedVerdict | null {
  let store: Store | null = null;
  try {
    store = openStore(opts);
    const recorded = recordVerdict(store, { report, expect: input.expect ?? null, command: input.command, ...(input.rerun ? { rerun: input.rerun } : {}) });
    if (report.verdict !== 'incomplete') {
      const counted = recorded.fixes.filter((x) => x.standing.counts).map((x) => x.fix.fixId);
      recordEvent(store, {
        kind: `verify.${report.verdict}`,
        actor: actor(),
        ref: counted[0] ?? recorded.fixes[0]?.fix.fixId ?? recorded.verdict.verifyId,
        data: { verifyId: recorded.verdict.verifyId, fixes: recorded.fixes.map((x) => x.fix.fixId), counts: counted, code: report.codeVersion, reasons: report.reasons.slice(0, 3) },
      });
    }
    return recorded;
  } catch (err) {
    report.warnings.push(`the verdict could not be kept: ${(err as Error).message}`);
    return null;
  } finally {
    store?.close();
  }
}

/**
 * Keeps a repair's report and links it to the fix of its runs; an accepted candidate's verification
 * becomes a verdict. `goldensCopied` are the recordings `--apply --goldens` put in the project.
 */
export function recordRepairFix(opts: GlobalOpts, report: RepairReport, input: { expect?: unknown; command: string; goldensCopied?: string[] }): RecordedRepair | null {
  if (!report.output.dir) return null;
  let store: Store | null = null;
  try {
    store = openStore(opts);
    const recorded = recordRepair(store, {
      repairId: basename(report.output.dir),
      dir: report.output.dir.split(/[\\/]+/).join('/'),
      report,
      expect: input.expect ?? null,
      command: input.command,
      ...(input.goldensCopied ? { goldensCopied: input.goldensCopied.map((g) => g.split(/[\\/]+/).join('/')) } : {}),
    });
    const accepted = report.candidates.find((c) => c.id === report.accepted);
    const who = actor();
    recordEvent(store, {
      kind: recorded.repair.accepted ? 'repair.accepted' : 'repair.empty',
      actor: who,
      ref: recorded.fixes[0]?.fix.fixId ?? recorded.repair.repairId,
      data: {
        repairId: recorded.repair.repairId,
        outcome: report.outcome,
        fixes: recorded.fixes.map((x) => x.fix.fixId),
        ...(accepted && recorded.repair.accepted ? { title: commitTitle(accepted), verifyId: recorded.verdict?.verifyId ?? null, counts: recorded.fixes.filter((x) => x.standing?.counts).map((x) => x.fix.fixId) } : { why: report.why }),
        candidates: report.candidates.length,
      },
    });
    for (const { fix } of recorded.fixes) {
      const applied = fix.data.applied;
      if (fix.status === 'applied' && applied?.via === 'repair --apply' && applied.repairId === recorded.repair.repairId) {
        recordEvent(store, { kind: 'fix.applied', actor: who, ref: fix.fixId, data: { title: fix.title, repairId: recorded.repair.repairId, patch: 'applied', goldens: applied.goldens.length, tests: 'skipped', via: 'repair --apply' } });
      }
    }
    return recorded;
  } catch (err) {
    report.warnings.push(`the repair could not be kept with its fix: ${(err as Error).message}`);
    return null;
  } finally {
    store?.close();
  }
}
