import { createHash, randomBytes } from 'node:crypto';
import { accessSync, closeSync, constants, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { messageOf } from './message-of.js';

/**
 * A project's GitHub Actions workflow that runs the shadowlap action, as Settings → CI reads and
 * writes it: found where GitHub reads it, read line by line with no YAML library (block style only:
 * the action step's inputs and env keys, and the Slack step's secret and branch), diffed line by
 * line against the text the switches build, and written back only while it is the version read.
 *
 * The reader never guesses: tabs, a `with:` in braces, an anchor or alias, or a value over several
 * lines in the action's `with:` give a `problem` instead, in words that follow the file's path, and
 * a writer then offers the text to copy. A write replaces the file with one rename, keeps its mode,
 * leaves no lock or temporary file behind, and refuses a file changed since it was read or a link
 * that leads out of the project folder.
 */

/** Where GitHub reads a repository's workflows. */
export const WORKFLOWS_DIR = '.github/workflows';
/** The file Settings → CI writes when no workflow uses the action yet. */
export const AGENT_WORKFLOW = `${WORKFLOWS_DIR}/agent.yml`;
/** The action, as a step's `uses:` names it before its `@ref`. */
export const ACTION_REPO = 'devjoinedthechat/shadowlap';
/** The version of a workflow file that isn't there. */
export const NO_WORKFLOW = 'absent';
/** The most of a workflow file read: as much as a request body may be, far past any workflow. */
export const WORKFLOW_READ_MAX = 256 * 1024;

/** The file changed since the version a write was based on. */
export class WorkflowConflictError extends Error {
  override readonly name = 'WorkflowConflictError';
}

/** The file can't be written: outside the project, read-only, or its folder can't be made. */
export class WorkflowFileError extends Error {
  override readonly name = 'WorkflowFileError';
}

export interface WorkflowFile {
  /** Relative to the project, with `/`: `.github/workflows/agent.yml`, or the file that uses the action. */
  path: string;
  exists: boolean;
  /** `absent`, or the SHA-256 of its bytes: a write names it. */
  version: string;
  /** Its text as read, line endings kept; empty when absent or unreadable. */
  text: string;
  /** Why it can't be read, after its path: `is 300 KB, more than the 256 KB Settings reads`. */
  problem: string | null;
}

/** A file's version: `absent`, or the SHA-256 of its bytes. */
export function workflowVersion(bytes: Buffer | string | null): string {
  return bytes === null ? NO_WORKFLOW : createHash('sha256').update(bytes).digest('hex');
}

/** A path inside a folder, by their real paths: a link that leads out of it isn't. */
function inside(folder: string, path: string): boolean {
  const rel = relative(folder, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** A path's real path, through the nearest folder above it that exists when it doesn't yet. */
function realPath(path: string): string {
  const rest: string[] = [];
  let at = path;
  for (;;) {
    try {
      return join(realpathSync(at), ...rest.reverse());
    } catch {
      const up = dirname(at);
      if (up === at) return path;
      rest.push(basename(at));
      at = up;
    }
  }
}

/**
 * Where a workflow path is written: the file, or what a link to it points at, refused when either,
 * or a folder above it, leads out of the project. The path must name a file in .github/workflows/.
 */
function targetOf(project: string, path: string): string {
  if (!/^\.github\/workflows\/[^/\\]+\.ya?ml$/i.test(path) || path.includes('..')) throw new WorkflowFileError(`${path} is not a workflow file in ${WORKFLOWS_DIR}/`);
  const root = realPath(resolve(project));
  const abs = join(root, path);
  let target = abs;
  try {
    if (lstatSync(abs).isSymbolicLink()) target = realpathSync(abs);
  } catch {
    // not there yet, or a link to nothing: written in its place
  }
  const real = join(realPath(dirname(target)), basename(target));
  if (!inside(root, real)) throw new WorkflowFileError(`${path} leads out of the project folder`);
  return real;
}

/** Reads one workflow file of the project, saying why when it can't. */
export function readWorkflowFile(project: string, path: string): WorkflowFile {
  const none = { path, exists: false, version: NO_WORKFLOW, text: '' };
  let target: string;
  try {
    target = targetOf(project, path);
  } catch (err) {
    return { ...none, exists: true, problem: messageOf(err).replace(`${path} `, '') };
  }
  let st;
  try {
    st = statSync(target);
  } catch {
    return { ...none, problem: null };
  }
  if (!st.isFile()) return { ...none, exists: true, problem: 'is not a file' };
  if (st.size > WORKFLOW_READ_MAX) return { ...none, exists: true, problem: `is ${Math.ceil(st.size / 1024)} KB, more than the ${WORKFLOW_READ_MAX / 1024} KB Settings reads` };
  let bytes: Buffer;
  try {
    bytes = readFileSync(target);
  } catch (err) {
    return { ...none, exists: true, problem: `can't be read (${(err as NodeJS.ErrnoException).code ?? 'error'})` };
  }
  return { path, exists: true, version: workflowVersion(bytes), text: bytes.toString('utf8'), problem: null };
}

/** A step that uses the action, at any ref, quoted or not. */
const USES_ACTION = new RegExp(`^[ \\t]*(?:-[ \\t]+)?uses:[ \\t]*["']?${ACTION_REPO.replace('/', '\\/')}@`, 'm');

/**
 * The project's workflow that runs the action: .github/workflows/agent.yml when it exists, else the
 * first other .yml or .yaml there, by name, with a step that uses the action, else agent.yml as
 * absent, where a write puts it.
 */
export function findWorkflow(project: string): WorkflowFile {
  const agent = readWorkflowFile(project, AGENT_WORKFLOW);
  if (agent.exists) return agent;
  let names: string[] = [];
  try {
    names = readdirSync(join(project, WORKFLOWS_DIR))
      .filter((n) => /\.ya?ml$/i.test(n))
      .sort();
  } catch {
    // no workflows folder
  }
  for (const name of names) {
    const file = readWorkflowFile(project, `${WORKFLOWS_DIR}/${name}`);
    if (file.exists && !file.problem && USES_ACTION.test(file.text)) return file;
  }
  return agent;
}

/**
 * Writes a workflow file in one rename, only while it is still the version `expect` names: a temp
 * file beside it (named so GitHub never reads it), its mode kept, compared once more just before
 * the rename, so no lock is left in the repository after a crash. Null removes the file, as the
 * Undo of a write that made it does. Answers the version written.
 */
export function writeWorkflow(project: string, path: string, text: string | null, options: { expect: string }): { version: string } {
  const target = targetOf(project, path);
  const now = () => {
    try {
      return workflowVersion(readFileSync(target));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return NO_WORKFLOW;
      throw err;
    }
  };
  const changed = () => new WorkflowConflictError(`${path} changed since it was read`);
  const before = now();
  if (before !== options.expect) throw changed();
  const existed = before !== NO_WORKFLOW;
  if (existed) {
    try {
      accessSync(target, constants.W_OK);
    } catch (err) {
      throw new WorkflowFileError(`${path} is read-only (${(err as NodeJS.ErrnoException).code ?? 'EACCES'}): make it writable to write it`);
    }
  }
  if (text === null) {
    if (existed) rmSync(target);
    return { version: NO_WORKFLOW };
  }
  try {
    mkdirSync(dirname(target), { recursive: true });
  } catch (err) {
    throw new WorkflowFileError(`${WORKFLOWS_DIR}/ can't be made (${(err as NodeJS.ErrnoException).code ?? 'error'})`);
  }
  const mode = existed ? statSync(target).mode & 0o777 : 0o644;
  const tmp = join(dirname(target), `.${basename(target)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  let fd: number;
  try {
    fd = openSync(tmp, 'wx', mode);
  } catch (err) {
    throw new WorkflowFileError(`${WORKFLOWS_DIR}/ can't be written (${(err as NodeJS.ErrnoException).code ?? 'error'})`);
  }
  try {
    if (existed) fchmodSync(fd, mode);
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    if (now() !== options.expect) throw changed();
    renameSync(tmp, target);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  return { version: workflowVersion(text) };
}

// ---- the diff ----

/** A line of the diff: kept (` `), added (`+`) or taken out (`-`). */
export interface DiffLine {
  op: ' ' | '+' | '-';
  text: string;
}

/** A text's lines, its line endings normalised; the last newline is no line. */
export function textLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Past this many cells the middle of a diff is shown as taken out, then added, instead of matched. */
const DIFF_CELLS = 4_000_000;

/**
 * The lines of `after` against `before`: the longest run of lines the two share stays put, and a
 * line taken out comes before the one that replaces it. A missing file (empty) diffs as every line
 * added. The lines they start and end with are matched first, so a small change costs little.
 */
export function diffLines(before: string, after: string): { lines: DiffLine[]; added: number; removed: number } {
  const a = textLines(before);
  const b = textLines(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const A = a.slice(head, a.length - tail);
  const B = b.slice(head, b.length - tail);
  const middle = middleDiff(A, B);
  const lines: DiffLine[] = [...a.slice(0, head).map((text) => ({ op: ' ' as const, text })), ...middle, ...a.slice(a.length - tail).map((text) => ({ op: ' ' as const, text }))];
  return { lines, added: middle.filter((l) => l.op === '+').length, removed: middle.filter((l) => l.op === '-').length };
}

function middleDiff(A: readonly string[], B: readonly string[]): DiffLine[] {
  const n = A.length;
  const m = B.length;
  if ((n + 1) * (m + 1) > DIFF_CELLS) return [...A.map((text) => ({ op: '-' as const, text })), ...B.map((text) => ({ op: '+' as const, text }))];
  const w = m + 1;
  const T = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) T[i * w + j] = A[i] === B[j] ? T[(i + 1) * w + j + 1]! + 1 : Math.max(T[(i + 1) * w + j]!, T[i * w + j + 1]!);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) {
      out.push({ op: ' ', text: B[j]! });
      i++;
      j++;
    } else if (i < n && (j === m || T[(i + 1) * w + j]! >= T[i * w + j + 1]!)) out.push({ op: '-', text: A[i++]! });
    else out.push({ op: '+', text: B[j++]! });
  }
  return out;
}

// ---- reading it line by line ----

/** A line of a workflow as the reader sees it. */
export interface WorkflowLine {
  /** As written, without its line ending. */
  raw: string;
  indent: number;
  /** `text` continues the scalar of the entry it sits under: a block of lines, or a value over several lines. */
  kind: 'blank' | 'comment' | 'entry' | 'text';
  /** A sequence item: `- uses: …`. */
  dash: boolean;
  /** Where its key starts: after the dash for an item. */
  col: number;
  key: string | null;
  /** What follows the key's colon, its comment included (an item's scalar when it has no key); '' for none. */
  value: string;
  /** The entry it sits under: the key whose block holds it, or the item it belongs to; -1 at the top, -2 for a blank or comment line. */
  parent: number;
}

export interface WorkflowDoc {
  lines: WorkflowLine[];
  eol: '\n' | '\r\n';
  /** The text ends with a line ending. */
  finalNewline: boolean;
  /** Why it can't be read line by line, after the file's path; null when it can. */
  problem: string | null;
}

/** A key, plain or quoted, then its colon and a space or the line's end. */
const KEY = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#'"{}[\],&*!|>%@`-][^:#]*?|-[^\s:#][^:#]*?)[ \t]*:(?:[ \t]+(.*)|$)/;

/** A value and the comment after it: `'a # b' # c` is `'a # b'` and `# c`. */
export function splitComment(value: string): { scalar: string; comment: string } {
  const v = value.trimStart();
  let end = -1;
  if (v.startsWith("'")) {
    for (let i = 1; i < v.length; i++) {
      if (v[i] !== "'") continue;
      if (v[i + 1] === "'") i++;
      else {
        end = i + 1;
        break;
      }
    }
  } else if (v.startsWith('"')) {
    for (let i = 1; i < v.length; i++) {
      if (v[i] === '\\') i++;
      else if (v[i] === '"') {
        end = i + 1;
        break;
      }
    }
  }
  const hash = /(^|[ \t])#/.exec(end < 0 ? v : v.slice(end));
  const at = hash ? hash.index + (end < 0 ? 0 : end) : -1;
  return at < 0 ? { scalar: v.trimEnd(), comment: '' } : { scalar: v.slice(0, at).trimEnd(), comment: v.slice(at).trim() };
}

/** A scalar's string: quotes taken off (`''` is a quote in single quotes), a comment left out; `${{ … }}` kept as written. */
export function scalarValue(value: string): string {
  const s = splitComment(value).scalar;
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1).replace(/\\(["\\/])/g, '$1').replace(/\\n/g, '\n').replace(/\\t/g, '\t');
  return s;
}

const TABS = 'indents with tabs, which YAML doesn’t allow';

/** Reads a workflow's lines: what each is, and the entry it sits under. */
export function parseWorkflow(text: string): WorkflowDoc {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const raws = text ? text.split(/\r?\n/) : [];
  const finalNewline = raws.length > 0 && raws[raws.length - 1] === '';
  if (finalNewline) raws.pop();
  const lines: WorkflowLine[] = [];
  const stack: Array<{ col: number; n: number; item: boolean }> = [];
  // A scalar that may go on over deeper lines: a block of lines (| or >) takes its comments too.
  let open: { col: number; n: number; block: boolean } | null = null;
  let problem: string | null = null;
  raws.forEach((raw, n) => {
    const body = n === 0 ? raw.replace(/^\uFEFF/, '') : raw;
    const lead = /^[ \t]*/.exec(body)![0];
    const rest = body.slice(lead.length);
    const indent = lead.length;
    const plain = { raw, indent, dash: false, col: indent, key: null, value: '' };
    if (!rest.trim()) {
      lines.push({ ...plain, kind: 'blank', parent: -2 });
      return;
    }
    if (open && indent > open.col && (open.block || !rest.startsWith('#'))) {
      lines.push({ ...plain, kind: 'text', parent: open.n });
      return;
    }
    if (rest.startsWith('#')) {
      lines.push({ ...plain, kind: 'comment', parent: -2 });
      return;
    }
    open = null;
    if (lead.includes('\t')) problem ??= TABS;
    const entry = entryOf(rest, indent);
    while (stack.length && popped(stack[stack.length - 1]!, entry.dash, indent)) stack.pop();
    const parent = stack.length ? stack[stack.length - 1]!.n : -1;
    if (!entry.key && !entry.dash) {
      lines.push({ ...plain, kind: 'text', parent });
      return;
    }
    lines.push({ raw, indent, kind: 'entry', ...entry, parent });
    if (entry.dash) stack.push({ col: indent, n, item: true });
    const scalar = splitComment(entry.value).scalar;
    if (entry.key !== null && scalar === '') stack.push({ col: entry.col, n, item: false });
    else if (scalar !== '') open = { col: entry.col, n, block: /^[|>]/.test(scalar) };
  });
  return { lines, eol, finalNewline, problem };
}

/** A line's dash, key and value. */
function entryOf(rest: string, indent: number): { dash: boolean; col: number; key: string | null; value: string } {
  const dash = /^-(?:[ \t]+|$)/.exec(rest);
  const content = dash ? rest.slice(dash[0].length) : rest;
  const k = KEY.exec(content);
  return { dash: !!dash, col: indent + (dash ? dash[0].length : 0), key: k ? scalarValue(k[1]!) : null, value: k ? (k[2] ?? '') : content };
}

/** Whether an open entry ends at a line of this indent: a deeper one sits under it, and an item at its indent is the next of a list. */
function popped(top: { col: number; item: boolean }, dash: boolean, indent: number): boolean {
  return dash ? top.col > indent || (top.col === indent && top.item) : top.col >= indent;
}

/** The entries that sit right under line `n` (-1: the top). */
export function entriesUnder(doc: WorkflowDoc, n: number): number[] {
  const out: number[] = [];
  doc.lines.forEach((l, i) => {
    if (l.kind === 'entry' && l.parent === n) out.push(i);
  });
  return out;
}

/** Whether line `i` sits somewhere under entry `n`. */
function under(doc: WorkflowDoc, i: number, n: number): boolean {
  for (let p = doc.lines[i]!.parent; p >= 0; p = doc.lines[p]!.parent) if (p === n) return true;
  return false;
}

/**
 * Where entry `n`'s block ends (exclusive): after the last line under it, with the comments right
 * after it that are indented under it too. Blank lines, and comments at its own indent or less, go
 * with what comes next.
 */
export function blockEnd(doc: WorkflowDoc, n: number): number {
  let last = n;
  for (let i = n + 1; i < doc.lines.length; i++) {
    const l = doc.lines[i]!;
    if (l.kind === 'blank' || l.kind === 'comment') continue;
    if (!under(doc, i, n)) break;
    last = i;
  }
  const indent = doc.lines[n]!.indent;
  let end = last + 1;
  while (end < doc.lines.length && doc.lines[end]!.kind === 'comment' && doc.lines[end]!.indent > indent) end++;
  return end;
}

/** A job's step: where its lines are, its keys by name, and the job and steps it sits in. */
export interface WorkflowStep {
  job: string;
  /** The `steps:` line it sits under. */
  steps: number;
  /** Its dash's line. */
  dash: number;
  /** Its first line: the blank and comment lines right before its dash go with it. */
  start: number;
  /** After its last line. */
  end: number;
  /** Its keys' lines by name: `uses`, `with`, `env`. */
  keys: Record<string, number>;
}

/** The lines right before line `dash` that are blank or comments not indented under the step before. */
function leadOf(doc: WorkflowDoc, dash: number, floor: number): number {
  let start = dash;
  while (start - 1 >= floor && (doc.lines[start - 1]!.kind === 'blank' || (doc.lines[start - 1]!.kind === 'comment' && doc.lines[start - 1]!.indent <= doc.lines[dash]!.indent))) start--;
  return start;
}

/** Every job's steps, in the file's order. */
export function workflowSteps(doc: WorkflowDoc): WorkflowStep[] {
  const jobs = entriesUnder(doc, -1).find((i) => doc.lines[i]!.key === 'jobs' && !doc.lines[i]!.dash);
  if (jobs === undefined) return [];
  const out: WorkflowStep[] = [];
  for (const job of entriesUnder(doc, jobs)) {
    const steps = entriesUnder(doc, job).find((i) => doc.lines[i]!.key === 'steps' && !doc.lines[i]!.dash);
    if (steps === undefined) continue;
    let floor = steps + 1;
    for (const dash of entriesUnder(doc, steps).filter((i) => doc.lines[i]!.dash)) {
      const keys: Record<string, number> = {};
      if (doc.lines[dash]!.key !== null) keys[doc.lines[dash]!.key] = dash;
      for (const k of entriesUnder(doc, dash)) if (doc.lines[k]!.key !== null && !doc.lines[k]!.dash && doc.lines[k]!.col === doc.lines[dash]!.col) keys[doc.lines[k]!.key] ??= k;
      const end = blockEnd(doc, dash);
      out.push({ job: doc.lines[job]!.key ?? '', steps, dash, start: leadOf(doc, dash, floor), end, keys });
      floor = end;
    }
  }
  return out;
}

/** A step's `uses:` as written, quotes taken off; null when it runs no action. */
export function stepUses(doc: WorkflowDoc, step: WorkflowStep): string | null {
  const at = step.keys.uses;
  return at === undefined ? null : scalarValue(doc.lines[at]!.value);
}

/** The action's step as the reader found it. */
export interface ActionStep {
  /** Its place in `workflowSteps`. */
  index: number;
  job: string;
  /** What its `uses:` names after the `@`: `v0.1.0`. */
  ref: string;
  id: string | null;
  /** Its `with:` inputs, quotes and comments taken off. */
  inputs: Record<string, string>;
  /** The names under its `env:`. */
  env: string[];
  /** Its `env:` values by name, quotes and comments taken off: a `GH_TOKEN` or `GITHUB_TOKEN` there says whose token the action comments with. */
  envValues: Record<string, string>;
}

export interface WorkflowRead {
  /** Why the switches can't be read from it, after the file's path; null when they can. */
  problem: string | null;
  /** How many steps use the action: the switches read the first. */
  count: number;
  action: ActionStep | null;
  /** The Slack step after it: the secret its webhook comes from, and the branch its `if:` keeps it to. */
  slack: { secret: string | null; branch: string | null } | null;
}

/** A value the reader refuses in the action's step: an anchor or alias, a tag, braces or brackets. */
function refusedValue(value: string): string | null {
  const s = splitComment(value).scalar;
  if (/^[&*]/.test(s)) return 'uses a YAML anchor or alias';
  if (/^!/.test(s)) return 'uses a YAML tag';
  if (/^[{[]/.test(s)) return 'is written on one line in braces or brackets';
  if (/^[|>]/.test(s)) return 'is a block of lines (| or >)';
  return null;
}

/** A mapping's entries as key and value, or why the reader can't take them. */
function mappingOf(doc: WorkflowDoc, n: number, what: string): { values: Record<string, string>; problem: string | null } {
  const values: Record<string, string> = {};
  const own = refusedValue(doc.lines[n]!.value);
  if (own) return { values, problem: `has a shadowlap step whose ${what} ${own}` };
  for (let i = n + 1; i < blockEnd(doc, n); i++) {
    const l = doc.lines[i]!;
    if (l.kind === 'blank' || l.kind === 'comment') continue;
    if (l.kind === 'text') return { values, problem: `has a shadowlap step whose ${what} holds a value over several lines` };
    if (l.parent !== n) continue;
    if (l.dash || l.key === null) return { values, problem: `has a shadowlap step whose ${what} is not a list of keys` };
    const why = refusedValue(l.value);
    if (why) return { values, problem: `has a shadowlap step whose ${what} ${l.key} ${why}` };
    values[l.key] = scalarValue(l.value);
  }
  return { values, problem: null };
}

/** The Slack step's `webhook: ${{ secrets.NAME }}` and the branch its `if:` names. */
function slackOf(doc: WorkflowDoc, step: WorkflowStep): { secret: string | null; branch: string | null } {
  const withAt = step.keys.with;
  let secret: string | null = null;
  if (withAt !== undefined) {
    const hook = entriesUnder(doc, withAt).find((i) => doc.lines[i]!.key === 'webhook');
    if (hook !== undefined) secret = /^\$\{\{\s*secrets\.([A-Za-z0-9_]+)\s*\}\}$/.exec(scalarValue(doc.lines[hook]!.value))?.[1] ?? null;
  }
  const ifAt = step.keys.if;
  const branch = ifAt === undefined ? null : (/refs\/heads\/([^'"\s)]+)/.exec(doc.lines[ifAt]!.value)?.[1] ?? null);
  return { secret, branch };
}

/**
 * Reads the action's step: the first step that uses the action, its id, its `with:` inputs and its
 * `env:` names, and the Slack step after it in the same job. Main's own quoting is undone
 * (`'goldens/* allow'`), a comment is no value, `${{ … }}` is kept as written, and a commented-out
 * `# env:` is a comment.
 */
export function readWorkflow(input: string | WorkflowDoc): WorkflowRead {
  const doc = typeof input === 'string' ? parseWorkflow(input) : input;
  const steps = workflowSteps(doc);
  const uses = steps.map((s) => stepUses(doc, s));
  const found = uses.flatMap((u, i) => (u !== null && u.startsWith(`${ACTION_REPO}@`) ? [i] : []));
  const none: WorkflowRead = { problem: doc.problem, count: found.length, action: null, slack: null };
  if (doc.problem || !found.length) return none;
  const index = found[0]!;
  const step = steps[index]!;
  const inputs = step.keys.with === undefined ? { values: {}, problem: null } : mappingOf(doc, step.keys.with, 'with:');
  if (inputs.problem) return { ...none, problem: inputs.problem };
  const env = step.keys.env === undefined ? { values: {}, problem: null } : mappingOf(doc, step.keys.env, 'env:');
  if (env.problem) return { ...none, problem: env.problem };
  const id = step.keys.id === undefined ? null : scalarValue(doc.lines[step.keys.id]!.value);
  const action: ActionStep = { index, job: step.job, ref: uses[index]!.slice(ACTION_REPO.length + 1), id, inputs: inputs.values, env: Object.keys(env.values), envValues: env.values };
  const slack = steps.findIndex((s, i) => i > index && s.job === step.job && (uses[i] ?? '').startsWith('slackapi/slack-github-action@'));
  return { problem: null, count: found.length, action, slack: slack < 0 ? null : slackOf(doc, steps[slack]!) };
}
