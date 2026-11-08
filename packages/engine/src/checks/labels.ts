import { checkStatus } from '../check-status.js';
import { aboutUsd, formatUsd } from '../prices.js';
import type { CheckStatus, JudgeOutcome, StoredCheck } from '../types.js';
import { pathAt, type CallCondition, type CallRule, type CountRange, type ExpectSpec, type JudgeCheck, type Matcher, type Operand, type TextCheck, type ToolCheck } from './grammar.js';

/**
 * What checks are called and how a result reads, as every report writes them: each kind of check's
 * label (a tool's count, a count or budget, a text, a rule's clauses, a check under a `when`
 * condition, a judge's question), every label of an expect in the order `evaluateChecks` reports
 * them (`checkLabels`), and a result's line with its mark. `evaluateChecks` takes its labels from
 * here, and nothing here needs Node, so the dashboard's pages can say a check in the same words.
 */

export function formatCount(r: CountRange, noun = 'time'): string {
  const plural = (n: number) => `${n} ${noun}${n === 1 ? '' : 's'}`;
  if (r.min === r.max) return plural(r.min);
  if (r.max === Infinity) return `at least ${plural(r.min)}`;
  if (r.min === 0) return `at most ${plural(r.max)}`;
  return `${r.min} to ${plural(r.max)}`;
}

/**
 * A budget in a label, not a measurement. `formatUsd` carries sub-cent precision because a measured
 * cost needs it, which turns the `<= 0.50` someone wrote into `$0.500`. A threshold is a round
 * number a person chose, so it is echoed as they would have written it; the measured side that a
 * failure reports still goes through `formatUsd`.
 */
const threshold = (n: number) => (n === 0 ? '$0' : n < 0.01 ? formatUsd(n) : `$${n.toFixed(2)}`);

export function formatAmount(r: CountRange): string {
  if (r.min === r.max) return `exactly ${threshold(r.min)}`;
  if (r.max === Infinity) return `at least ${threshold(r.min)}`;
  if (r.min === 0) return `at most ${threshold(r.max)}`;
  return `${threshold(r.min)} to ${threshold(r.max)}`;
}

/**
 * A value in a label or a detail: JSON in one line, cut at 80 characters. Cut inside a quoted
 * string, it is closed after the mark (`"Replay works; forks…"`), so a detail's quotes stay paired
 * and what reads one (a fix's title, which takes its first problem) never takes a value's own '; '
 * for the one between problems.
 */
export function showValue(v: unknown): string {
  if (v === undefined) return 'nothing';
  const s = JSON.stringify(v) ?? String(v);
  if (s.length <= 80) return s;
  let cut = s.slice(0, 79);
  let quoted = false;
  let i = 0;
  while (i < cut.length) {
    if (cut[i] === '\\') i += 2;
    else {
      if (cut[i] === '"') quoted = !quoted;
      i++;
    }
  }
  // An escape cut in two loses its backslash, which would escape the closing quote.
  if (i > cut.length) cut = cut.slice(0, -1);
  return quoted ? `${cut}…"` : `${cut}…`;
}

const operandText = (o: Operand) => ('ref' in o ? o.ref.text : showValue(o.value));
export const PHRASE = { '=': '=', '!=': '!=', '<': '<', '<=': '<=', '>': '>', '>=': '>=', includes: 'includes', startsWith: 'starts with', endsWith: 'ends with', in: 'in' } as const;
export const NEGATED = { '=': '!=', '!=': '=', '<': '>=', '<=': '>', '>': '<=', '>=': '<', includes: "doesn't include", startsWith: "doesn't start with", endsWith: "doesn't end with", in: 'not in' } as const;

/** What a matcher asks of the value at `path`, as clauses: `amount <= lookup_order.result.total`. */
function clauses(m: Matcher, path: string): string[] {
  const subject = path || 'the value';
  switch (m.op) {
    case 'object':
      return m.keys.length ? m.keys.flatMap((k) => clauses(k.matcher, pathAt(path, k.key))) : [`${subject} is an object`];
    case 'array':
      return m.items.every((i) => i.op === '=' && 'value' in i.operand)
        ? [`${subject} = ${showValue(m.items.map((i) => ((i as { operand: { value: unknown } }).operand.value)))}`]
        : [`${subject} has ${m.items.length} item${m.items.length === 1 ? '' : 's'}`, ...m.items.flatMap((i, n) => clauses(i, pathAt(path, n)))];
    case 'all':
      return m.matchers.flatMap((x) => clauses(x, path));
    case 'not': {
      const inner = m.matcher;
      if (inner.op === 'in' || inner.op === 'includes' || inner.op === 'startsWith' || inner.op === 'endsWith' || inner.op === '=' || inner.op === '!=') return [clause(inner, subject, true)];
      return [`not (${clauses(inner, path).join(' and ')})`];
    }
    default:
      return [clause(m, subject, false)];
  }
}

function clause(m: Extract<Matcher, { op: keyof typeof PHRASE }>, subject: string, negated: boolean): string {
  const word = (negated ? NEGATED : PHRASE)[m.op];
  if (m.op === 'in') return `${subject} ${word} ${'list' in m ? m.list.text : `[${m.items.map(operandText).join(', ')}]`}`;
  return `${subject} ${word} ${operandText(m.operand)}`;
}

const andList = (items: readonly string[]) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)!}`);
export const orList = (items: readonly string[]) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} or ${items.at(-1)!}`);

/** `every issue_refund call: after lookup_order, amount <= lookup_order.result.total`. */
export function callRuleLabel(rule: CallRule): string {
  const parts = [...(rule.after.length ? [`after ${andList(rule.after)}`] : []), ...(rule.args ? clauses(rule.args, '') : [])];
  return `every ${rule.tool} call: ${parts.join(', ')}`;
}

/** `when lookup_order has result.total > 200`, `when escalate is called`. */
export function conditionLabel(c: CallCondition): string {
  const parts = [...(c.args ? clauses(c.args, 'args') : []), ...(c.result ? clauses(c.result, 'result') : [])];
  return parts.length ? `when ${c.tool} has ${parts.join(' and ')}` : `when ${c.tool} is called`;
}

/** `judge "explains-escalation" answers yes`. */
export const judgeLabel = (j: JudgeCheck): string => `judge "${j.name}" answers ${j.pass}`;

// ---- Each check's label -------------------------------------------------------------------------

/** A count under `tools`: `send_email called 0 times`, `issue_refund with {"order_id":"A-1042"} called at least 1 time`. */
export function toolCheckLabel(t: ToolCheck): string {
  return `${t.name}${t.args ? ` with ${JSON.stringify(t.args)}` : ''} called ${formatCount(t.count)}`;
}

/** A tool's calls fenced after a fork, said exactly: `2 blocked`, `1 stubbed`, `1 blocked, 1 stubbed`; empty for none. */
export function fencedLabel(blocked: number, stubbed: number): string {
  return [blocked ? `${blocked} blocked` : '', stubbed ? `${stubbed} stubbed` : ''].filter(Boolean).join(', ');
}

/**
 * What a tool's calls did against a count under `tools` they failed, as the check's detail says it:
 * `called 2 times (1 blocked)`, then `; 1 call with other arguments` when the check names arguments
 * and the tool was called with others too (`named` counts every call of it), or `; tools called:
 * lookup_order, send_email` when it was never called. `evaluateChecks` reports it, and the dashboard
 * says a fix's check a run failed in the same words.
 */
export function toolCountDetail(d: { count: number; blocked: number; stubbed: number; named: number; args: boolean; tools: readonly string[] }): string {
  const fenced = fencedLabel(d.blocked, d.stubbed);
  let detail = `called ${formatCount({ min: d.count, max: d.count })}${fenced ? ` (${fenced})` : ''}`;
  const other = d.named - d.count;
  if (d.args && other > 0) detail += `; ${other} call${other === 1 ? '' : 's'} with other arguments`;
  if (d.named === 0 && d.tools.length) detail += `; tools called: ${d.tools.join(', ')}`;
  return detail;
}

/** The counts an expect may hold beside `tools`, in the order they are reported, by what each one counts. */
export const COUNT_NOUNS = { modelCalls: 'model call', toolCalls: 'tool call', inputTokens: 'input token', outputTokens: 'output token' } as const;
export type CountKey = keyof typeof COUNT_NOUNS;
const COUNT_KEYS = Object.keys(COUNT_NOUNS) as CountKey[];

/** `at most 12 model calls`, `at least 1 tool call`, `at most 60000 input tokens`. */
export const countLabel = (key: CountKey, range: CountRange): string => formatCount(range, COUNT_NOUNS[key]);

/** A budget in dollars: `cost at most $0.50`. */
export const costLabel = (range: CountRange): string => `cost ${formatAmount(range)}`;

/** What each text check reads: what the agent printed, or the last model response. */
export const TEXT_NOUNS = { output: 'output', answer: 'final answer' } as const;
export type TextKey = keyof typeof TEXT_NOUNS;

/** A text an `output` or `answer` check asks for or rules out: `final answer includes "refund issued"`, `output doesn't include "cannot help"`. */
export const textLabel = (key: TextKey, text: string, included: boolean): string => `${TEXT_NOUNS[key]} ${included ? 'includes' : "doesn't include"} "${text}"`;

/** An `output` or `answer` check's labels: the texts it must include, then those it must not. */
export const textLabels = (key: TextKey, check: TextCheck): string[] => [...check.includes.map((s) => textLabel(key, s, true)), ...check.excludes.map((s) => textLabel(key, s, false))];

/** A check under a `when` rule, said under its condition: `when lookup_order has result.total > 200: escalate called at least 1 time`. */
export const whenLabel = (c: CallCondition, label: string): string => `${conditionLabel(c)}: ${label}`;

/**
 * Every check of an expect by its label, in the order `evaluateChecks` reports them: its tools, its
 * counts and cost, its output and final answer, its `calls` rules, each `when` rule's checks under
 * the rule's condition, and its judges. A label depends on the check alone, so a golden's checks
 * have their names before any run is judged by them.
 */
export function checkLabels(spec: ExpectSpec): string[] {
  return [
    ...spec.tools.map(toolCheckLabel),
    ...COUNT_KEYS.flatMap((key) => {
      const range = spec[key];
      return range ? [countLabel(key, range)] : [];
    }),
    ...(spec.cost ? [costLabel(spec.cost)] : []),
    ...(spec.output ? textLabels('output', spec.output) : []),
    ...(spec.answer ? textLabels('answer', spec.answer) : []),
    ...(spec.calls ?? []).map(callRuleLabel),
    ...(spec.when ?? []).flatMap((w) => checkLabels(w.then).map((label) => whenLabel(w.if, label))),
    ...(spec.judge ?? []).map(judgeLabel),
  ];
}

// ---- Reports ------------------------------------------------------------------------------------

/** Where the rules a capture is judged by are, as its verdict says it: `shadowlap import` prints it, and the dashboard's pages show it. */
export const RULES_ON_CALLS = 'the rules on calls in shadowlap.config.json';

/** A count as a report writes it: `1,000` from a thousand on. */
const countWords = (n: number) => (n >= 1000 ? n.toLocaleString('en-US') : String(n));

/**
 * Checks that passed, and those that did not apply, in a few words, as an import's verdict and the
 * pages' status say them: `2 checks passed`, `1 check passed, 2 not applicable`, `1 check not
 * applicable`. A check that did not apply never counts as passed.
 */
export function passedWords(passed: number, notApplicable = 0): string {
  const noun = (n: number) => `${countWords(n)} check${n === 1 ? '' : 's'}`;
  if (!notApplicable) return `${noun(passed)} passed`;
  return passed ? `${noun(passed)} passed, ${countWords(notApplicable)} not applicable` : `${noun(notApplicable)} not applicable`;
}

/** Each status's mark at the start of a report's line. */
export const CHECK_MARKS: Readonly<Record<CheckStatus, string>> = { passed: '✓', failed: '✗', inconclusive: '?', 'not-applicable': '–' };

/**
 * A check as one line of a report: `✓ label`, `✗ label: detail`, `? label: inconclusive · detail`,
 * `– label: not applicable · detail`, and a judge's reason after it. `join` is what comes between a
 * failed check's label and its detail (a replay's report writes `, but `). A result kept before
 * results had a status reads as `ok` says.
 */
export function checkLine(c: StoredCheck, join = ': '): string {
  return `${CHECK_MARKS[checkStatus(c)]} ${checkWords(c, join)}`;
}

/** The line `checkLine` writes, without its mark, for a report that draws the mark itself. A judge's verdict says where it came from. */
export function checkWords(c: StoredCheck, join = ': '): string {
  const source = c.judge ? judgeSource(c.judge) : null;
  const reason = `${c.reason ? ` · ${c.reason}` : ''}${source ? ` (${source})` : ''}`;
  switch (checkStatus(c)) {
    case 'passed':
      return `${c.label}${reason}`;
    case 'failed':
      return `${c.label}${join}${c.detail ?? ''}${reason}`;
    case 'inconclusive':
      return `${c.label}: inconclusive · ${c.detail ?? ''}`;
    case 'not-applicable':
      return `${c.label}: not applicable · ${c.detail ?? ''}`;
  }
}

/**
 * Where a judge check's verdict came from and what it cost, with what was done to what it read:
 * `judged from the recording, free`, `judged live, ≈$0.0004 · read with 1 redaction rule applied`.
 * Null for a check that was not judged.
 */
export function judgeSource(j: JudgeOutcome): string | null {
  if (!j.source) return null;
  const read = [
    j.redactions ? `read with ${j.redactions} redaction rule${j.redactions === 1 ? '' : 's'} applied` : null,
    j.normalized ? 'values that change every run masked' : null,
    j.cut ? `${j.cut.toLocaleString('en-US')} characters left out` : null,
  ].filter(Boolean);
  const how = j.source === 'recording' ? 'judged from the recording, free' : `judged live, ${j.cost === null ? `no price for ${j.model}` : aboutUsd(j.cost)}`;
  return [how, ...read].join(' · ');
}
