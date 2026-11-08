import { blockEnd, entriesUnder, parseWorkflow, readWorkflow, scalarValue, splitComment, stepUses, workflowSteps, type WorkflowDoc, type WorkflowLine, type WorkflowStep } from '@shadowlap/engine';

/**
 * Write file's change to a workflow the repository already has: the file as it is, with only the
 * lines a switch or the config owns made what the switches build. Two generated files say what
 * that is: `base`, the whole file for the options the repository's file was read as, and `want`,
 * the one for the options now. A line either names is the switches' (set to `want`'s, added, or
 * taken out when only `base` has it); every other line, the person's build step, their own steps,
 * inputs, env and jobs, and filled-in role ARNs among them, stays byte for byte. What they own:
 * - on:'s `workflow_dispatch:` (taken out only bare, as the switches write it);
 * - under the job's `permissions:`, else the file's, the keys the switches write, and their comments
 *   (a file with neither gets the job's own, so its other jobs keep the token they had);
 * - the checkout's `ref:`;
 * - the step that installs Claude Code;
 * - the bucket's two sign-in steps (`shadowlap store ci`'s, by their `if:`), added with their
 *   placeholders when absent and kept as they are when present;
 * - the action's `uses:` ref and `id: goldens`, the inputs and env keys the switches write (one
 *   already there keeps its line and changes only its value), and the comments they write;
 * - Tell Slack's `if:` and webhook, and Fail the job's `if:`, or both steps whole as Alerts turns.
 * A guard then checks every changed line falls inside one of those blocks. A file it can't be done
 * for gets a `problem`, after its path, and the page offers the whole file to copy instead.
 */

interface Pieces {
  doc: WorkflowDoc;
  /** The line of the job the action runs in. */
  job: number;
  action: WorkflowStep;
  /** The job's steps before and after the action. */
  before: WorkflowStep[];
  after: WorkflowStep[];
}

/** The edits, by the file's line numbers: lines put before a line (or at the end), and lines replaced (by none: taken out). */
interface Patch {
  before: Map<number, string[]>;
  swap: Map<number, string[]>;
}

const pad = (n: number) => ' '.repeat(n);
const lineAt = (doc: WorkflowDoc, i: number): WorkflowLine => doc.lines[i]!;
const scalarAt = (doc: WorkflowDoc, i: number) => scalarValue(lineAt(doc, i).value);
const topKey = (doc: WorkflowDoc, key: string) => entriesUnder(doc, -1).find((i) => !lineAt(doc, i).dash && lineAt(doc, i).key === key);
const childOf = (doc: WorkflowDoc, n: number, key: string) => entriesUnder(doc, n).find((i) => !lineAt(doc, i).dash && lineAt(doc, i).key === key);

/** Where the entries under `n` start: its first one's indent, else two past its key. */
function childIndent(doc: WorkflowDoc, n: number): number {
  const first = entriesUnder(doc, n)[0];
  return first === undefined ? lineAt(doc, n).col + 2 : lineAt(doc, first).indent;
}

/** The keys under `n` with their values as written (quotes kept, a comment left out). */
function valuesOf(doc: WorkflowDoc, n: number | undefined): Map<string, string> {
  if (n === undefined) return new Map();
  return new Map(entriesUnder(doc, n).flatMap((i) => (lineAt(doc, i).dash || lineAt(doc, i).key === null ? [] : [[lineAt(doc, i).key!, splitComment(lineAt(doc, i).value).scalar] as [string, string]])));
}

/** The comment lines between two lines, trimmed. */
function commentsIn(doc: WorkflowDoc, from: number, to: number): string[] {
  return doc.lines.slice(from, to).flatMap((l) => (l.kind === 'comment' ? [l.raw.trim()] : []));
}

/** A line with its value replaced, its key, spacing and comment kept. */
function withValue(line: WorkflowLine, value: string): string {
  if (!line.value) return `${line.raw.trimEnd()} ${value}`;
  const head = line.raw.slice(0, line.raw.length - line.value.length);
  const rest = line.value.slice(splitComment(line.value).scalar.length);
  return `${head}${value}${rest.startsWith('#') ? ` ${rest}` : rest}`;
}

function insert(p: Patch, at: number, lines: readonly string[]): void {
  p.before.set(at, [...(p.before.get(at) ?? []), ...lines]);
}
function replace(p: Patch, at: number, text: string): void {
  p.swap.set(at, [text]);
}
function remove(p: Patch, from: number, to: number): void {
  for (let i = from; i < to; i++) p.swap.set(i, []);
}

/** The action's step and its job, or why Write file can't tell which step the switches are for. */
function piecesOf(doc: WorkflowDoc): Pieces | string {
  const read = readWorkflow(doc);
  if (read.problem) return read.problem;
  if (read.count > 1) return `has ${read.count} steps that use the Shadowlap action, so Write file can’t tell which one the switches are for`;
  if (!read.action) return 'has no step that uses the Shadowlap action';
  const all = workflowSteps(doc);
  const action = all[read.action.index]!;
  const steps = all.filter((s) => s.steps === action.steps);
  const i = steps.indexOf(action);
  return { doc, job: lineAt(doc, action.steps).parent, action, before: steps.slice(0, i), after: steps.slice(i + 1) };
}

/**
 * The keyed lines under `block` made what `b` has, for each key `a` or `b` names: a value set in
 * place, a line added after the last of them seen, or taken out when only `a` has it. Other keys stay.
 */
function patchKeys(p: Patch, doc: WorkflowDoc, block: number, a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): void {
  const indent = childIndent(doc, block);
  let anchor = block + 1;
  for (const key of [...b.keys(), ...[...a.keys()].filter((k) => !b.has(k))]) {
    const at = childOf(doc, block, key);
    const want = b.get(key);
    if (at === undefined) {
      if (want !== undefined) insert(p, anchor, [`${pad(indent)}${key}: ${want}`]);
      continue;
    }
    if (want === undefined) remove(p, at, blockEnd(doc, at));
    else if (scalarAt(doc, at) !== scalarValue(want)) replace(p, at, withValue(lineAt(doc, at), want));
    anchor = blockEnd(doc, at);
  }
}

/** The generated comment lines between two lines made what `b` has, for those `a` or `b` has; missing ones go at `at`. */
function patchComments(p: Patch, doc: WorkflowDoc, range: [number, number], a: readonly string[], b: readonly string[], at: number, indent: number): void {
  const kept = new Set<string>();
  for (let i = range[0]; i < range[1]; i++) {
    const text = lineAt(doc, i).raw.trim();
    if (lineAt(doc, i).kind !== 'comment' || !(a.includes(text) || b.includes(text))) continue;
    if (b.includes(text) && !kept.has(text)) kept.add(text);
    else remove(p, i, i + 1);
  }
  const missing = b.filter((t) => !kept.has(t));
  if (missing.length) insert(p, at, missing.map((t) => pad(indent) + t));
}

const hasDispatch = (doc: WorkflowDoc) => {
  const on = topKey(doc, 'on');
  return on !== undefined && childOf(doc, on, 'workflow_dispatch') !== undefined;
};

function patchDispatch(p: Patch, u: Pieces, a: Pieces, b: Pieces): string | null {
  const want = hasDispatch(b.doc);
  if (!want && !hasDispatch(a.doc)) return null;
  const on = topKey(u.doc, 'on');
  if (on === undefined) return want ? 'has no on: to add workflow_dispatch: to' : null;
  if (splitComment(lineAt(u.doc, on).value).scalar !== '') return want && !lineAt(u.doc, on).value.includes('workflow_dispatch') ? 'names its triggers on one line, so workflow_dispatch: can’t be added to them' : null;
  const child = childOf(u.doc, on, 'workflow_dispatch');
  if (want && child === undefined) insert(p, blockEnd(u.doc, on), [`${pad(childIndent(u.doc, on))}workflow_dispatch:`]);
  // Taken out only bare, as the switches write it: one with inputs of its own is the person's.
  else if (!want && child !== undefined && blockEnd(u.doc, child) === child + 1 && splitComment(lineAt(u.doc, child).value).scalar === '') remove(p, child, child + 1);
  return null;
}

/** The permissions the action's job runs with: its own block, else the file's. */
const permissionsOf = (g: Pieces) => childOf(g.doc, g.job, 'permissions') ?? topKey(g.doc, 'permissions');

function patchPermissions(p: Patch, u: Pieces, a: Pieces, b: Pieces): string | null {
  const ga = permissionsOf(a)!;
  const gb = permissionsOf(b)!;
  const block = permissionsOf(u);
  if (block === undefined) {
    // Under the action's job, first: set for the whole file, it would change what every other job's token may do.
    const indent = pad(childIndent(u.doc, u.job));
    insert(p, u.job + 1, b.doc.lines.slice(gb, blockEnd(b.doc, gb)).flatMap((l) => (l.raw.trim() ? [indent + l.raw] : [])));
    return null;
  }
  const scalar = splitComment(lineAt(u.doc, block).value).scalar;
  if (scalar !== '') return scalar === 'write-all' ? null : 'sets its permissions on one line, so the ones the switches need can’t be added';
  patchKeys(p, u.doc, block, valuesOf(a.doc, ga), valuesOf(b.doc, gb));
  const end = blockEnd(u.doc, block);
  patchComments(p, u.doc, [block + 1, end], commentsIn(a.doc, ga + 1, blockEnd(a.doc, ga)), commentsIn(b.doc, gb + 1, blockEnd(b.doc, gb)), end, childIndent(u.doc, block));
  return null;
}

const usesOf = (g: Pieces, s: WorkflowStep) => stepUses(g.doc, s) ?? '';
const runOf = (g: Pieces, s: WorkflowStep) => (s.keys.run === undefined ? '' : scalarAt(g.doc, s.keys.run));
const ifOf = (g: Pieces, s: WorkflowStep) => (s.keys.if === undefined ? '' : lineAt(g.doc, s.keys.if).value);
const checkoutOf = (g: Pieces) => g.before.find((s) => usesOf(g, s).startsWith('actions/checkout@'));

/** The checkout's `ref:` as written, or undefined. */
function refOf(g: Pieces): string | undefined {
  const w = checkoutOf(g)?.keys.with;
  const ref = w === undefined ? undefined : childOf(g.doc, w, 'ref');
  return ref === undefined ? undefined : splitComment(lineAt(g.doc, ref).value).scalar;
}

function patchCheckout(p: Patch, u: Pieces, a: Pieces, b: Pieces): string | null {
  const want = refOf(b);
  if (want === undefined && refOf(a) === undefined) return null;
  const step = checkoutOf(u);
  if (!step) return want === undefined ? null : 'has no actions/checkout step before the Shadowlap step to check the branch out with';
  const w = step.keys.with;
  if (w !== undefined && splitComment(lineAt(u.doc, w).value).scalar !== '') return want === undefined ? null : 'writes its checkout’s with: on one line, so the branch can’t be added to it';
  const ref = w === undefined ? undefined : childOf(u.doc, w, 'ref');
  if (want === undefined) {
    // Its `with:` goes too when the branch was all it held.
    const only = w !== undefined && entriesUnder(u.doc, w).length === 1;
    if (ref !== undefined) remove(p, only ? w : ref, blockEnd(u.doc, only ? w : ref));
  } else if (ref !== undefined) {
    if (scalarAt(u.doc, ref) !== scalarValue(want)) replace(p, ref, withValue(lineAt(u.doc, ref), want));
  } else if (w !== undefined) insert(p, w + 1, [`${pad(childIndent(u.doc, w))}ref: ${want}`]);
  else {
    const col = lineAt(u.doc, step.dash).col;
    insert(p, blockEnd(u.doc, step.dash), [`${pad(col)}with:`, `${pad(col + 2)}ref: ${want}`]);
  }
  return null;
}

const CLAUDE_CODE = /^npm (?:install|i) (?:-g|--global) @anthropic-ai\/claude-code(?:@\S+)?$/;
const LOGIN = /^(?:aws-actions\/configure-aws-credentials|google-github-actions\/auth|azure\/login)@/;
const isClaudeCode = (g: Pieces, s: WorkflowStep) => CLAUDE_CODE.test(runOf(g, s));
/** One of `shadowlap store ci`'s sign-in steps: a cloud login kept to, or from, pull requests' jobs by its `if:`. */
const isSignIn = (g: Pieces, s: WorkflowStep) => LOGIN.test(usesOf(g, s)) && /startsWith\(github\.event_name,\s*'pull_request'\)/.test(ifOf(g, s));
const isSlack = (g: Pieces, s: WorkflowStep) => usesOf(g, s).startsWith('slackapi/slack-github-action@');
const isFail = (g: Pieces, s: WorkflowStep) => runOf(g, s) === 'exit 1' && ifOf(g, s).includes('steps.goldens.outputs.failed');

/** Generated steps' lines, their dash moved to the file's indent. */
function stepText(g: Pieces, steps: readonly WorkflowStep[], dash: number): string[] {
  const from = lineAt(g.doc, steps[0]!.dash).indent;
  return g.doc.lines.slice(steps[0]!.start, steps[steps.length - 1]!.end).map((l) => (l.kind === 'blank' ? '' : pad(Math.max(0, l.indent - from + dash)) + l.raw.trimStart()));
}

/** Steps of one kind before the action: added as `b` has them when the file has none, taken out when only `a` has them, kept as they are otherwise. */
function patchSteps(p: Patch, u: Pieces, a: Pieces, b: Pieces, is: (g: Pieces, s: WorkflowStep) => boolean, at: number): void {
  const want = b.before.filter((s) => is(b, s));
  const have = u.before.filter((s) => is(u, s));
  if (want.length && !have.length) insert(p, at, stepText(b, want, lineAt(u.doc, u.action.dash).indent));
  else if (!want.length && a.before.some((s) => is(a, s))) for (const s of have) remove(p, s.start, s.end);
}

function patchSetup(p: Patch, u: Pieces, a: Pieces, b: Pieces): null {
  // Claude Code goes before the sign-in steps, as the switches write them.
  const signIn = u.before.find((s) => isSignIn(u, s));
  patchSteps(p, u, a, b, isClaudeCode, signIn?.start ?? u.action.start);
  patchSteps(p, u, a, b, isSignIn, u.action.start);
  return null;
}

/** A step's key set to `b`'s value as written, or added after its dash line. */
function setStepKey(p: Patch, u: Pieces, s: WorkflowStep, key: string, value: string): void {
  const at = s.keys[key];
  if (at === undefined) insert(p, s.dash + 1, [`${pad(lineAt(u.doc, s.dash).col)}${key}: ${value}`]);
  else if (scalarAt(u.doc, at) !== scalarValue(value)) replace(p, at, withValue(lineAt(u.doc, at), value));
}

/** The action's `with:` or `env:` made what `b` has; a whole block added at its place when the file has none, and an `env:` left empty taken out. */
function patchBlock(p: Patch, u: Pieces, a: Pieces, b: Pieces, key: 'with' | 'env'): void {
  const want = valuesOf(b.doc, b.action.keys[key]);
  const at = u.action.keys[key];
  if (at !== undefined) {
    patchKeys(p, u.doc, at, valuesOf(a.doc, a.action.keys[key]), want);
    const left = entriesUnder(u.doc, at).some((i) => p.swap.get(i)?.length !== 0);
    if (!want.size && !left && splitComment(lineAt(u.doc, at).value).scalar === '') remove(p, at, at + 1);
    return;
  }
  if (!want.size) return;
  const col = lineAt(u.doc, u.action.dash).col;
  const where = key === 'with' && u.action.keys.env !== undefined ? u.action.keys.env : blockEnd(u.doc, u.action.dash);
  insert(p, where, [`${pad(col)}${key}:`, ...[...want].map(([k, v]) => `${pad(col + 2)}${k}: ${v}`)]);
}

function patchAction(p: Patch, u: Pieces, a: Pieces, b: Pieces): null {
  const s = u.action;
  const col = lineAt(u.doc, s.dash).col;
  setStepKey(p, u, s, 'uses', splitComment(lineAt(b.doc, b.action.keys.uses!).value).scalar);
  if (s.keys.id === undefined) insert(p, s.keys.uses! + 1, [`${pad(col)}id: goldens`]);
  else setStepKey(p, u, s, 'id', 'goldens');
  patchBlock(p, u, a, b, 'with');
  patchBlock(p, u, a, b, 'env');
  // The comments the switches write: under a real env, else the commented-out env at the step's end.
  const env = s.keys.env;
  const underEnv = b.action.keys.env !== undefined;
  const at = underEnv && env !== undefined ? blockEnd(u.doc, env) : blockEnd(u.doc, s.dash);
  const indent = underEnv ? (env !== undefined ? childIndent(u.doc, env) : col + 2) : col;
  patchComments(p, u.doc, [s.start, s.end], commentsIn(a.doc, a.action.start, a.action.end), commentsIn(b.doc, b.action.start, b.action.end), at, indent);
  return null;
}

function patchAlerts(p: Patch, u: Pieces, a: Pieces, b: Pieces): null {
  const slack = u.after.find((s) => isSlack(u, s));
  const fail = u.after.find((s) => isFail(u, s));
  const bSlack = b.after.find((s) => isSlack(b, s));
  const bFail = b.after.find((s) => isFail(b, s));
  if (!bSlack || !bFail) {
    if (a.after.some((s) => isSlack(a, s) || isFail(a, s))) for (const s of [slack, fail]) if (s) remove(p, s.start, s.end);
    return null;
  }
  const dash = lineAt(u.doc, u.action.dash).indent;
  if (slack) {
    setStepKey(p, u, slack, 'if', ifOf(b, bSlack));
    const hook = valuesOf(b.doc, bSlack.keys.with).get('webhook')!;
    const w = slack.keys.with;
    const at = w === undefined ? undefined : childOf(u.doc, w, 'webhook');
    if (at !== undefined && scalarAt(u.doc, at) !== scalarValue(hook)) replace(p, at, withValue(lineAt(u.doc, at), hook));
  } else insert(p, u.action.end, stepText(b, [bSlack], dash));
  if (fail) setStepKey(p, u, fail, 'if', ifOf(b, bFail));
  else insert(p, slack ? slack.end : u.action.end, stepText(b, [bFail], dash));
  return null;
}

/**
 * The blocks the switches may change, as line ranges of the file, worked out apart from the edits:
 * the on: and permissions blocks, the steps they own before the action, the action, and Slack's.
 */
function ownedRanges(u: Pieces): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const on = topKey(u.doc, 'on');
  if (on !== undefined) ranges.push([on, blockEnd(u.doc, on)]);
  const permissions = permissionsOf(u);
  if (permissions !== undefined) ranges.push([permissions, blockEnd(u.doc, permissions)]);
  else ranges.push([u.job + 1, u.job + 1]);
  for (const s of u.before) if (s === checkoutOf(u) || isClaudeCode(u, s) || isSignIn(u, s)) ranges.push([s.start, s.end]);
  ranges.push([u.action.start, u.action.end]);
  for (const s of u.after) if (isSlack(u, s) || isFail(u, s)) ranges.push([s.start, s.end]);
  return ranges;
}

/** Every changed line inside an owned block, and every added one at one: the guard d3 asked for. */
function guarded(u: Pieces, p: Patch): boolean {
  const ranges = ownedRanges(u);
  const inRange = (i: number, end: boolean) => ranges.some(([from, to]) => i >= from && (end ? i <= to : i < to));
  return [...p.swap.keys()].every((i) => inRange(i, false)) && [...p.before.keys()].every((i) => inRange(i, true));
}

/**
 * The repository's workflow with the switches' change: `base` is the whole file for the options it
 * was read as, `want` for the options now (both from workflowFile). Answers the text to write, which
 * ends with a newline, or why it can't be patched line by line.
 */
export function patchWorkflow(file: string, base: string, want: string): { text: string } | { problem: string } {
  const doc = parseWorkflow(file);
  const u = piecesOf(doc);
  if (typeof u === 'string') return { problem: u };
  const a = piecesOf(parseWorkflow(base));
  const b = piecesOf(parseWorkflow(want));
  if (typeof a === 'string' || typeof b === 'string') return { problem: 'can’t be matched to what the switches build' };
  const p: Patch = { before: new Map(), swap: new Map() };
  const problem = patchDispatch(p, u, a, b) ?? patchPermissions(p, u, a, b) ?? patchCheckout(p, u, a, b) ?? patchSetup(p, u, a, b) ?? patchAction(p, u, a, b) ?? patchAlerts(p, u, a, b);
  if (problem) return { problem };
  if (!guarded(u, p)) return { problem: 'would change lines outside what the switches own' };
  const out: string[] = [];
  doc.lines.forEach((l, i) => out.push(...(p.before.get(i) ?? []), ...(p.swap.get(i) ?? [l.raw])));
  out.push(...(p.before.get(doc.lines.length) ?? []));
  return { text: out.join(doc.eol) + doc.eol };
}
