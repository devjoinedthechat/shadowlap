import { basename } from 'node:path';
import { ciProvider, commitTitle, recordBlame, recordEvent, recordRepair, recordVerdict, resolveAuthor, type BlameReport, type RecordedBlame, type RecordedRepair, type RecordedVerdict, type RepairReport, type Store, type VerifyReport } from '@shadowlap/engine';
import { EXIT_LABEL } from './attempts.js';
import { evaluateChecks, formatAmount, type CheckResult, type CountRange, type TestSpec, type TextCheck, type ToolCheck } from './checks.js';
import { openStore, type GlobalOpts } from './shared.js';
import { quoteArgv, shortId } from './ui.js';

/**
 * What blame, verify and repair leave for Fixes (engine `fixes.ts` says how runs are grouped): a
 * title and a check in plain words for a fix a blame opens, a command line that runs each step
 * again, and the activity each step records. Recording never fails the command that did the work.
 */

// ---- A check, and a failure of it, in plain words ----------------------------------------------

const EMPTY_INPUT = { calls: [], output: '', answer: null, argsOf: () => undefined, costOf: () => 0 };
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
  const parts = [
    ...spec.tools.map(toolWords),
    ...(spec.modelCalls ? [rangeWords(spec.modelCalls, 'model call')] : []),
    ...(spec.toolCalls ? [rangeWords(spec.toolCalls, 'tool call')] : []),
    ...(spec.inputTokens ? [rangeWords(spec.inputTokens, 'input token')] : []),
    ...(spec.outputTokens ? [rangeWords(spec.outputTokens, 'output token')] : []),
    ...(spec.cost ? [`cost ${formatAmount(spec.cost)}`] : []),
    ...textWords(spec.output, 'output'),
    ...textWords(spec.answer, 'final answer'),
  ];
  return parts.length ? parts.join('; ') : EXIT_LABEL;
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
      const label = evaluateChecks(item.spec, EMPTY_INPUT)[0]?.label;
      const result = failed.find((c) => c.label === label);
      if (result) return item.title(result.detail ?? '');
    }
  }
  for (const f of recording.failures) {
    const code = /exited with code (\d+)/.exec(f);
    if (code) return `The agent exited with code ${code[1]}`;
    if (/exited with a non-zero code/.test(f)) return 'The agent exited with an error';
    if (/timed out/.test(f)) return 'The agent timed out';
    if (/interrupted/.test(f)) return 'The run was interrupted';
  }
  return recording.failures[0] ? capital(recording.failures[0].split(', but ')[0]!) : 'The run failed';
}

// ---- Command lines ------------------------------------------------------------------------------

/** `--expect '<json>'`, or nothing for the exit code alone. */
const expectArgs = (expect: unknown): string[] => (expect === null || expect === undefined ? [] : ['--expect', JSON.stringify(expect)]);

const fieldArgs = (fields: Record<string, unknown>): string[] =>
  Object.entries(fields).flatMap(([k, v]) => (k === 'model' && typeof v === 'string' ? ['--model', v] : ['--set', `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`]));

/** A blame command that blames the run the same way again. */
export function blameCommand(runId: string, s: { expect?: unknown; scope?: string | null; fields: Record<string, unknown>; attempts: number; needed: number }): string {
  return quoteArgv([
    'shadowlap',
    'blame',
    shortId(runId),
    ...expectArgs(s.expect),
    ...(s.scope ? ['--scope', s.scope] : []),
    ...fieldArgs(s.fields),
    ...(s.attempts !== 5 ? ['--attempts', String(s.attempts)] : []),
    ...(s.needed !== Math.min(2, s.attempts) ? ['--passes', String(s.needed)] : []),
  ]);
}

/** The runs a verify or repair was given, as they were given: ids or `label:<name>`. */
export interface RunSpecs {
  fixes?: string[] | undefined;
  holdout?: string[] | undefined;
  keeps?: string[] | undefined;
}

const runArgs = (r: RunSpecs): string[] => [...(r.fixes?.length ? ['--fixes', ...r.fixes] : []), ...(r.holdout?.length ? ['--holdout', ...r.holdout] : []), ...(r.keeps?.length ? ['--keeps', ...r.keeps] : [])];

const gateArgs = (attempts: number, passes: number | undefined) => [...(attempts !== 5 ? ['--attempts', String(attempts)] : []), ...(passes !== undefined ? ['--passes', String(passes)] : [])];

export function verifyCommand(runs: RunSpecs, f: { expect?: unknown; attempts: number; passes?: number | undefined; fields: Record<string, unknown>; liveTools: string[] }): string {
  return quoteArgv(['shadowlap', 'verify', ...runArgs(runs), ...expectArgs(f.expect), ...fieldArgs(f.fields), ...f.liveTools.flatMap((t) => ['--live-tool', t]), ...gateArgs(f.attempts, f.passes)]);
}

export function repairCommand(runs: RunSpecs, f: { expect?: unknown; repairer?: string; stronger?: string; scope?: string; attempts: number; passes?: number }): string {
  return quoteArgv([
    'shadowlap',
    'repair',
    ...runArgs(runs),
    ...expectArgs(f.expect),
    ...(f.repairer ? ['--repairer', f.repairer] : []),
    ...(f.stronger ? ['--stronger', f.stronger] : []),
    ...(f.scope ? ['--scope', f.scope] : []),
    ...gateArgs(f.attempts, f.passes),
  ]);
}

// ---- Recording ---------------------------------------------------------------------------------

const actor = () => resolveAuthor({ cwd: process.cwd() });

/**
 * Keeps a blame and opens or joins its fix, in the store the blame used. Returns null, and adds a
 * warning to the report, when the store refuses: the blame itself still stands.
 */
export function recordBlameFix(
  store: Store,
  input: { runId: string; report: BlameReport; settings: { spec: TestSpec | null; expect?: unknown; scope?: string | null; fields: Record<string, unknown>; attempts: number; needed: number }; recording: { checks: readonly CheckResult[]; failures: readonly string[] } },
): RecordedBlame | null {
  const s = input.settings;
  try {
    const who = actor();
    const recorded = recordBlame(store, {
      runId: input.runId,
      report: input.report,
      expect: s.expect ?? null,
      scope: s.scope ?? null,
      command: blameCommand(input.runId, s),
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
      data: { outcome: input.report.outcome, callNo: input.report.blamed?.callNo ?? null, confidence: input.report.confidence, title: recorded.fix.title, opened: recorded.created },
    });
    return recorded;
  } catch (err) {
    input.report.warnings.push(`the blame could not be kept with its fix: ${(err as Error).message}`);
    return null;
  }
}

/** Keeps a verify's verdict, whatever it was, and links it to the fix of its runs. */
export function recordVerifyFix(opts: GlobalOpts, report: VerifyReport, input: { expect?: unknown; command: string }): RecordedVerdict | null {
  let store: Store | null = null;
  try {
    store = openStore(opts);
    const recorded = recordVerdict(store, { report, expect: input.expect ?? null, command: input.command });
    if (report.verdict !== 'incomplete') {
      recordEvent(store, {
        kind: `verify.${report.verdict}`,
        actor: actor(),
        ref: recorded.fixes[0]?.fixId ?? recorded.verdict.verifyId,
        data: { verifyId: recorded.verdict.verifyId, fixes: recorded.fixes.map((f) => f.fixId), code: report.codeVersion, reasons: report.reasons.slice(0, 3) },
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

/** Keeps a repair's report and links it to the fix of its runs; an accepted candidate's verification becomes a verdict. */
export function recordRepairFix(opts: GlobalOpts, report: RepairReport, input: { expect?: unknown; command: string }): RecordedRepair | null {
  if (!report.output.dir) return null;
  let store: Store | null = null;
  try {
    store = openStore(opts);
    const recorded = recordRepair(store, { repairId: basename(report.output.dir), dir: report.output.dir.split(/[\\/]+/).join('/'), report, expect: input.expect ?? null, command: input.command });
    const accepted = report.candidates.find((c) => c.id === report.accepted);
    recordEvent(store, {
      kind: recorded.repair.accepted ? 'repair.accepted' : 'repair.empty',
      actor: actor(),
      ref: recorded.fixes[0]?.fixId ?? recorded.repair.repairId,
      data: {
        repairId: recorded.repair.repairId,
        outcome: report.outcome,
        fixes: recorded.fixes.map((f) => f.fixId),
        ...(accepted && recorded.repair.accepted ? { title: commitTitle(accepted), verifyId: recorded.verdict?.verifyId ?? null } : { why: report.why }),
        candidates: report.candidates.length,
      },
    });
    return recorded;
  } catch (err) {
    report.warnings.push(`the repair could not be kept with its fix: ${(err as Error).message}`);
    return null;
  } finally {
    store?.close();
  }
}
