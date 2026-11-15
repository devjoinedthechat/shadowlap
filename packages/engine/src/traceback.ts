/**
 * What an agent died of, read from the last lines it printed: the exception in one line, where in
 * the agent's own code it was raised, and every frame. Python and Node tracebacks are read as their
 * runtimes print them. Anything else falls back to its last line that says something, as the CLI's
 * chaos report has always read it.
 *
 * The input is a tail. The store keeps an agent's last 20 lines, each cut at 400 characters and at
 * most 6000 in all, with stdout and stderr interleaved as they arrived and shadowlap's own
 * `[shadowlap] …` lines after them. So a traceback can lose its head, and lines can follow it: the
 * parser reads the last traceback in the tail, never just its last line.
 */

export interface Frame {
  /** As printed, a `file://` URL as its path: `/work/shop/agent.py`, `node:internal/modules/cjs/loader`, `<anonymous>`. */
  file: string;
  /** Null for a frame printed with no position, such as Node's `JSON.parse (<anonymous>)`. */
  line: number | null;
  column: number | null;
  fn: string | null;
  /** The line of code there, as the runtime printed it, trimmed. */
  code: string | null;
  /** The agent's own code: not a library's (site-packages, node_modules), the standard library's or the runtime's. */
  own: boolean;
}

export interface ParsedTraceback {
  /** Null when no traceback was found and `exception` is the last line that says something. */
  runtime: 'python' | 'node' | null;
  /** One line: `KeyError: 'total'`. */
  exception: string;
  /** `KeyError`, `anthropic.InternalServerError`, `TypeError`; null for a thrown value that is no error. */
  type: string | null;
  message: string | null;
  /** The innermost frame of the agent's own code; null when the tail kept none. */
  raised: Frame | null;
  /** Outermost first, as Python prints them. */
  frames: Frame[];
  /** The tail began inside the traceback, so its head is gone. */
  cut: boolean;
}

/** The most of a tail the store keeps; anything longer is read by its last part, as the store would keep it. */
const TAIL = 6000;
const COLOUR = /\x1b\[[0-9;]*m/g;
/** Python's markers under a frame's code (3.11 and on), and Node's caret under its throw site. */
const MARKER = /^\s*[\^~]+\s*$/;
const PY_FRAME = /^(\s*)File "(.+)", line (\d+)(?:, in (.+))?$/;
const PY_HEADER = /^Traceback \(most recent call last\):$/;
const GROUP_HEADER = /^ {2}\+ Exception Group Traceback \(most recent call last\):$/;
const NODE_AT = /^\s+at (?:async )?(?:(.+?) \((.+)\)|(.+?))(?: \{)?$/;
const NODE_HEADER = /^((?:file:\/\/)?(?:\/|[A-Za-z]:\\|node:)\S*):(\d+)$/;
/** An error as the CLI has always found one: `SyntaxError: …`, `TypeError [ERR_X]: …`, `ShadowlapInjectedFailure [TimeoutError]: …`. */
const ERROR_SHAPED = /^[\w$.]*(Error|Exception|Failure)\w*(?: \[[\w$.]+\])?: \S/;
/** An exception's line, its type then its message: `KeyError: 'total'`, `TypeError [ERR_X]: …`, a bare `KeyboardInterrupt`. */
const TYPED = /^([A-Za-z_$][\w$.]*)(?: \[[\w$.]+\])?(?:: (.*))?$/;
/** Lines that say nothing of what the agent died of: shadowlap's own, the runtime's version and its hint. */
const NOT_SAID = /^(?:\[shadowlap\]|Node\.js v\d|\(Use `node --)/;

export function parseTraceback(output: string): ParsedTraceback | null {
  const lines = output
    .slice(-TAIL)
    .replace(COLOUR, '')
    .split(/\r\n|\n|\r/)
    .map((l) => l.trimEnd())
    .filter((l) => !l.trimStart().startsWith('[shadowlap]'));
  const python = pythonTraceback(groupLevel(lines));
  const node = nodeError(lines);
  const found = python && node ? (python.end >= node.end ? python : node) : (python ?? node);
  return found ? found.parsed : lastSaid(lines);
}

/**
 * Where a file is the agent's own code. Not a library's (`site-packages`, `dist-packages`,
 * `node_modules`), the Python standard library's (`/lib/python3.12/` outside site-packages),
 * a frozen module, the runtime's (`node:`, `internal/`), or a frame with no file (`<anonymous>`).
 */
export function ownFile(file: string): boolean {
  const f = file.replace(/\\/g, '/');
  if (/(^|\/)(site-packages|dist-packages|node_modules)\//.test(f)) return false;
  if (/\/lib\/python\d+(\.\d+)?\//.test(f)) return false;
  if (/^(node:|internal\/)/.test(f)) return false;
  return !/^<(frozen\b|anonymous>|native>)/.test(f);
}

function framed(file: string, line: number | null, column: number | null, fn: string | null, code: string | null): Frame {
  return { file, line, column, fn, code, own: line !== null && ownFile(file) };
}

/** An exception's line split into its type and its message; a line that names no type keeps neither. */
function typed(exception: string): { type: string | null; message: string | null } {
  const m = TYPED.exec(exception);
  return m ? { type: m[1] ?? null, message: m[2] ?? null } : { type: null, message: null };
}

function result(runtime: 'python' | 'node', exception: string, frames: Frame[], cut: boolean, raised?: Frame | null): ParsedTraceback {
  const own = [...frames].reverse().find((f) => f.own) ?? null;
  return { runtime, exception, ...typed(exception), raised: own ?? raised ?? null, frames, cut };
}

/**
 * An exception group's own level read as a plain traceback: its header as Python's, its `  | `
 * prefix dropped. Its sub-exceptions sit deeper and stay as they are, so they are never descended into.
 */
function groupLevel(lines: string[]): string[] {
  let at = -1;
  for (let i = lines.length - 1; i >= 0 && at < 0; i--) if (GROUP_HEADER.test(lineAt(lines, i))) at = i;
  if (at < 0) return lines;
  return lines.map((l, i) => (i === at ? 'Traceback (most recent call last):' : i > at && l.startsWith('  | ') ? l.slice(4) : l));
}

/** A line of the tail; past either end, an empty one. */
const lineAt = (lines: readonly string[], i: number): string => lines[i] ?? '';

const indent = (l: string): number => l.length - l.trimStart().length;

/**
 * Python's last traceback: the last `File "…", line N` frame, the frames above it back to the
 * header (or to the top of a tail that cut it), and the exception line under them. A SyntaxError in
 * the main file prints its frame with no `in` and no header, which is no cut.
 */
function pythonTraceback(lines: string[]): { parsed: ParsedTraceback; end: number } | null {
  let last = -1;
  for (let i = lines.length - 1; i >= 0 && last < 0; i--) if (PY_FRAME.test(lineAt(lines, i))) last = i;
  if (last < 0) return null;
  let start = last;
  while (start > 0 && lineAt(lines, start - 1) !== '' && (PY_FRAME.test(lineAt(lines, start - 1)) || indent(lineAt(lines, start - 1)) > 0)) start--;
  let end = last + 1;
  while (end < lines.length && lineAt(lines, end) !== '' && indent(lineAt(lines, end)) > 0 && !PY_FRAME.test(lineAt(lines, end))) end++;
  const exception = lineAt(lines, end).trim();
  if (!exception || indent(lineAt(lines, end)) > 0) return null;
  const frames: Frame[] = [];
  for (let i = start; i <= last; i++) {
    const m = PY_FRAME.exec(lineAt(lines, i));
    if (!m) continue;
    const next = lineAt(lines, i + 1);
    const code = i + 1 < end && indent(next) > (m[1] ?? '').length && !MARKER.test(next) && !PY_FRAME.test(next) ? next.trim() : null;
    frames.push(framed(m[2] ?? '', Number(m[3]), null, m[4] ?? null, code));
  }
  const headed = start > 0 && PY_HEADER.test(lineAt(lines, start - 1));
  const syntax = frames.length === 1 && frames[0]?.fn === null && PY_FRAME.test(lineAt(lines, start));
  return { parsed: result('python', exception, frames, !headed && !syntax), end };
}

/** One of Node's stack lines: `at fn (file:line:column)`, `at file:line:column`, `at async fn (…) {`. */
function nodeFrame(line: string): Frame | null {
  const m = NODE_AT.exec(line);
  if (!m) return null;
  const where = m[2] ?? m[3] ?? '';
  const fn = m[2] === undefined ? null : (m[1] ?? null);
  const pos = /^(.*?):(\d+)(?::(\d+))?$/.exec(where);
  if (!pos && fn === null) return null;
  const file = fileOf(pos ? (pos[1] ?? '') : where);
  return framed(file, pos ? Number(pos[2]) : null, pos?.[3] ? Number(pos[3]) : null, fn, null);
}

/** A `file://` URL as its path; anything else as printed. */
function fileOf(where: string): string {
  if (!where.startsWith('file://')) return where;
  try {
    return decodeURIComponent(where.slice('file://'.length));
  } catch {
    return where.slice('file://'.length);
  }
}

/** Node's throw site, printed over an uncaught error: `path:line`, the line of code, a caret under it. Looked for above `before`, as far up as `from`. */
function nodeHeader(lines: string[], before: number, from = 0): { at: number; frame: Frame } | null {
  for (let i = Math.min(before, lines.length) - 1; i >= Math.max(from, 0); i--) {
    const m = NODE_HEADER.exec(lineAt(lines, i));
    if (!m || i + 2 >= lines.length || !MARKER.test(lineAt(lines, i + 2))) continue;
    const caret = lineAt(lines, i + 2).indexOf('^');
    return { at: i, frame: framed(fileOf(m[1] ?? ''), Number(m[2]), caret >= 0 ? caret + 1 : null, null, lineAt(lines, i + 1).trim() || null) };
  }
  return null;
}

/**
 * Node's last error: the stack's `at` lines and the error's own line over them, or, for a thrown
 * value that is no error, the value under the throw site's caret. Node prints the stack innermost
 * first; the frames are turned outermost first, as Python's are. The throw site gives its frame the
 * line of code.
 */
function nodeError(lines: string[]): { parsed: ParsedTraceback; end: number } | null {
  let lastAt = -1;
  for (let i = lines.length - 1; i >= 0 && lastAt < 0; i--) if (nodeFrame(lineAt(lines, i))) lastAt = i;
  if (lastAt < 0) return thrownValue(lines);
  let firstAt = lastAt;
  while (firstAt > 0 && nodeFrame(lineAt(lines, firstAt - 1))) firstAt--;
  const said = errorLine(lines, firstAt);
  if (!said) return null;
  const stack = lines.slice(firstAt, lastAt + 1).map(nodeFrame).filter((f): f is Frame => f !== null);
  const header = nodeHeader(lines, said.at, said.at - 6);
  const top = stack[0];
  if (header && top && top.file === header.frame.file && top.line === header.frame.line) stack[0] = { ...top, code: header.frame.code };
  const raised = header?.frame.own ? header.frame : null;
  return { parsed: result('node', said.line, stack.reverse(), false, raised), end: lastAt };
}

/**
 * The error's own line over a stack: the first error-shaped line in the lines that run on above the
 * `at` lines (a message can take several), else the line right over them when it names a type.
 * Null when neither is there, as when the tail began inside the stack.
 */
function errorLine(lines: string[], firstAt: number): { line: string; at: number } | null {
  let top = firstAt;
  while (top > 0 && firstAt - top < 10 && lineAt(lines, top - 1) !== '' && !MARKER.test(lineAt(lines, top - 1))) top--;
  for (let i = top; i < firstAt; i++) if (ERROR_SHAPED.test(lineAt(lines, i).trim())) return { line: lineAt(lines, i).trim(), at: i };
  const over = lineAt(lines, firstAt - 1).trim();
  return over && TYPED.test(over) ? { line: over, at: firstAt - 1 } : null;
}

/** A thrown value that is no error (`throw 'no order'`): Node prints the throw site, then the value, then its hint. */
function thrownValue(lines: string[]): { parsed: ParsedTraceback; end: number } | null {
  const header = nodeHeader(lines, lines.length);
  if (!header) return null;
  let i = header.at + 3;
  while (i < lines.length && lineAt(lines, i).trim() === '') i++;
  const value = lineAt(lines, i).trim();
  if (!value || NOT_SAID.test(value)) return null;
  return { parsed: { runtime: 'node', exception: value, type: null, message: null, raised: header.frame.own ? header.frame : null, frames: [header.frame], cut: false }, end: i };
}

/**
 * No traceback: the last line that says something, as the CLI's chaos report reads it. An
 * error-shaped line wins over a later one that isn't; a stack frame, a caret or the runtime's own
 * lines are never it.
 */
function lastSaid(lines: string[]): ParsedTraceback | null {
  const said = lines.map((l) => l.trim()).filter((l) => l && !NOT_SAID.test(l) && !/^at\s/.test(l) && !MARKER.test(l) && !/^File ".*", line \d+/.test(l));
  let line: string | undefined;
  for (let i = said.length - 1; i >= 0 && line === undefined; i--) if (ERROR_SHAPED.test(said[i] ?? '')) line = said[i];
  line ??= said.at(-1);
  if (!line) return null;
  const named = ERROR_SHAPED.test(line) ? typed(line) : { type: null, message: null };
  return { runtime: null, exception: line, ...named, raised: null, frames: [], cut: false };
}
