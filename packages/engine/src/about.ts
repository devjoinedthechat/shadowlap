/**
 * A run's about line: one quiet line that says what a run was. A run is named by its id; the about
 * line is worked out from the run and never edited, so it is never a second name. The first that
 * applies:
 *
 *   - a test replay: the golden it replays (`refund-in-limit`);
 *   - an attempt bundled under another run (blame's, verify's, a test's, `--repeat`'s, an error-path
 *     preset's): what it asked again, and which attempt it was (`resampled #5, attempt 2`);
 *   - a replay or a fork: what it changed, the call it changed written with # (`override #16`,
 *     `HTTP 529 #19`, `rescued #5`); @ is only the fork point, which the kind says (FORK @17). A clean
 *     replay changed nothing (`clean replay`), and a fork no flag made forked because its code or a
 *     request changed (`code changed`, `request changed`);
 *   - an import: where it came from, the file or the trace (`traffic.har`, `Langfuse trace 7f3a9c2e`);
 *   - a recording: the first thing the user asked, its first sentence whole, with no full stop; in a
 *     run of several agents, the first message the agent under test received; a run that holds
 *     several conversations (a batch) by its input instead (`--batch inbox/2026-09-30.jsonl` reads
 *     `inbox 2026-09-30`);
 *   - otherwise its command.
 *
 * Pure functions of what a run holds, with no Node imports: the dashboard's browser code reads the
 * words of `ABOUT_FROM` from here too. What the first user message says is read from the store by
 * `runAsk` (about-ask.ts); everything else is in the run's record. The about line quotes recorded
 * content, so a copy that leaves the store works it out from its own redacted record.
 */
import { isChaosPreset, PRESET_LABELS } from './chaos.js';
import type { AttemptKind, RunKind } from './classify.js';

/** Where an about line comes from. */
export type AboutFrom = 'user' | 'agent' | 'input' | 'golden' | 'change' | 'nothing' | 'source' | 'command';

/** Where an about line comes from, as a run's Provenance says it under the line. */
export const ABOUT_FROM: Readonly<Record<AboutFrom, string>> = {
  user: 'the first thing the user asked',
  agent: 'what the agent under test was asked first',
  input: 'the input it ran on',
  golden: 'the golden it replays',
  change: 'what it changed',
  nothing: 'nothing changed',
  source: 'where it was imported from',
  command: 'its command',
};

/** A run's about line, where it comes from, and for a replay or a fork its change apart. */
export interface RunAbout {
  text: string;
  from: AboutFrom;
  /**
   * For a replay or a fork made with a flag: the flag (`--override`), the call of its parent it changed
   * (`16`), and where it forked (`17`, its divergence). Null for one no flag made.
   */
  change?: { flag: string; callNo: number | null; forkAt: number | null } | null;
}

/** The first thing a recording's user asked, as `runAsk` reads it from the store. */
export interface RunAsk {
  /** Its first sentence, whole, with no full stop (`firstSentence`). */
  text: string;
  /** A run of several agents: what the agent under test was asked first. */
  agent: boolean;
  /** The agent under test held several conversations: a batch, which reads by its input. */
  batch: boolean;
}

/** A flag a replay ran with, as the run keeps it (`RunIntervention`), read loosely: a pack can carry anything. */
export interface AboutIntervention {
  kind?: unknown;
  at?: unknown;
  flag?: unknown;
}

/** What the about line is worked out from: the run's record, its parent's revision, and where it sits among its run's attempts. */
export interface AboutFacts {
  kind: RunKind;
  /** The command it ran (`<no-recorded-command>` for an import). */
  argv: readonly string[];
  codeVersion: string | null;
  /** The run it replayed, when the store has it. */
  parent?: { codeVersion: string | null } | null;
  divergence: { callNo: number; type?: string } | null;
  meta?: {
    test?: unknown;
    imported?: unknown;
    interventions?: unknown;
    probe?: unknown;
    verify?: unknown;
    repeat?: unknown;
    chaos?: unknown;
    injection?: unknown;
    task?: unknown;
  } | null;
  /** For an attempt bundled under another run: what made it one, and its place among that run's attempts of its kind (from 1). */
  attempt?: { kind: AttemptKind; index: number } | null;
  /** The fork blame rescued a run with (a probe that shows as a fork of its own). */
  rescued?: boolean;
  /** An `--override` of a call a person answered (a recorded user input): it changed the user's answer. */
  answered?: boolean;
  /** For a recording: the first thing its user asked (`runAsk`); null when it made no model call. */
  ask?: RunAsk | null;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null);

/** The longest a first sentence is kept: past it, the line ends at a whole word, with "…". */
export const ABOUT_MAX = 300;

/** Whitespace as one space (\s takes in the line and paragraph separators), control characters too. */
function oneLine(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * A text's first sentence, whole, with no full stop ("A customer asks for a refund of order
 * A-1131"): a question or an exclamation keeps its mark. The place that shows it fits it to its
 * room; only a sentence longer than `ABOUT_MAX` characters is cut here, after a whole word, with
 * "…" at its end.
 */
export function firstSentence(text: string): string {
  const s = oneLine(text);
  const m = /^(.+?[.!?])(?=\s|$)/.exec(s);
  let out = (m ? m[1]! : s).replace(/\.$/, '');
  if (out.length > ABOUT_MAX) {
    const cut = out.slice(0, ABOUT_MAX + 1);
    const space = cut.lastIndexOf(' ');
    out = `${(space > 0 ? cut.slice(0, space) : cut.slice(0, ABOUT_MAX)).replace(/[\s,;:·…–—-]+$/, '')} …`;
  }
  return out;
}

/** Flags an agent's command may name its input with. */
const INPUT_FLAGS = new Set(['--batch', '--input', '--inputs', '--inbox', '--file', '--data', '--dataset', '-i']);
/** Files an agent reads its input from. */
const DATA_FILE = /\.(?:jsonl|ndjson|json|csv|tsv|txt|ya?ml|xml|md|parquet)$/i;

/**
 * The input a batch ran on, from its command, in words: `--batch inbox/2026-09-30.jsonl` reads
 * `inbox 2026-09-30`. The value of a flag that names an input, else the command's last argument
 * that names a data file (the script it runs is no input). Null when the command names none.
 */
export function batchInput(argv: readonly string[]): string | null {
  let value: string | null = null;
  for (let i = 0; i < argv.length && !value; i++) {
    const a = argv[i]!;
    const eq = a.indexOf('=');
    if (eq > 0 && INPUT_FLAGS.has(a.slice(0, eq))) value = a.slice(eq + 1);
    else if (INPUT_FLAGS.has(a) && i + 1 < argv.length) value = argv[i + 1]!;
  }
  if (!value) {
    for (let i = argv.length - 1; i >= 2 && !value; i--) {
      const a = argv[i]!;
      if (!a.startsWith('-') && DATA_FILE.test(a)) value = a;
    }
  }
  if (!value) return null;
  const words = value
    .replace(/^\.\//, '')
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[/\\_]+/g, ' ')
    .trim();
  return words || null;
}

/**
 * Where an import came from, in words: its file, or the trace it was read from (`langfuse:7f3a9c2e`
 * reads `Langfuse trace 7f3a9c2e`). A path keeps its last part: the folder it sat in on someone's
 * machine says nothing of the run.
 */
export function sourceWords(from: string): string {
  const s = oneLine(from);
  const trace = /^(langfuse|langsmith):(.+)$/i.exec(s);
  if (trace) return `${trace[1]!.toLowerCase() === 'langfuse' ? 'Langfuse' : 'LangSmith'} trace ${trace[2]!.trim()}`;
  return s
    .split(/,\s*/)
    .map((part) => part.split(/[\\/]/).filter(Boolean).pop() ?? part)
    .join(', ');
}

/** A golden by its name: the pack's folder without the goldens folder (`goldens/refund-in-limit` is `refund-in-limit`). */
export function goldenWords(path: string): string {
  return path.replace(/^\.\//, '').replace(/^goldens\//, '');
}

/** What follows the flag in its short form (`--fail-at 19=529` is `19=529`), else null. */
function flagValue(flag: string): string | null {
  const space = flag.indexOf(' ');
  return space < 0 ? null : flag.slice(space + 1).trim() || null;
}

/** What follows a call number in a flag's value: `529` in `19=529`, `claude-opus-5` in `17:claude-opus-5`. */
const afterCall = (value: string | null): string => (value ?? '').replace(/^\d+[=:]/, '').trim();

/** The flags that fence what a replay may do, rather than change what it was given: never what it changed. */
const FENCES = new Set(['writes', 'reads']);

/**
 * What a replay's flag changed, in a few words, the call it changed written with #: `HTTP 529 #19`,
 * `timeout #4`, `override #16`, `answer #5` (a person's answer), `planted #6`, `inject #17`,
 * `claude-haiku-4-5 #17`, `temperature=1 #17`, `prompt #17`, `diverge #5`, `lookup_policy live #4`,
 * `command changed`. Null for a flag that changes nothing a replay is given.
 */
export function changeWords(iv: AboutIntervention, o: { forkAt?: number | null; answered?: boolean } = {}): string | null {
  const kind = typeof iv.kind === 'string' ? iv.kind : null;
  const flag = typeof iv.flag === 'string' ? oneLine(iv.flag) : '';
  if (!kind || FENCES.has(kind)) return null;
  const at = int(iv.at) ?? int(Number(/^(\d+)[=:]/.exec(flagValue(flag) ?? '')?.[1]));
  const n = at ?? o.forkAt ?? null;
  const call = (words: string) => (n === null ? words : `${words} #${n}`);
  const value = afterCall(flagValue(flag));
  switch (kind) {
    case 'fail':
      return call(/^\d{3}$/.test(value) ? `HTTP ${value}` : /^timeout$/i.test(value) ? 'timeout' : 'error');
    case 'override':
      return call(o.answered ? 'answer' : 'override');
    case 'plant':
      return call('planted');
    case 'inject':
      return call('inject');
    case 'model':
      return call(value && !value.includes(' ') ? value : 'model');
    case 'set':
      return call(value && value.length <= 60 ? value : 'set');
    case 'prompt-from':
      return call('prompt');
    case 'diverge':
      return call('diverge');
    case 'live-tool': {
      const tool = flagValue(flag);
      return `${tool && !tool.includes(' ') ? tool : 'tool'} live${o.forkAt ? ` #${o.forkAt}` : ''}`;
    }
    case 'command':
      return 'command changed';
    default:
      return null;
  }
}

/** The flag's own name: `--override` in `--override 16=@policy.json`. */
const flagName = (iv: AboutIntervention): string => (typeof iv.flag === 'string' ? (oneLine(iv.flag).split(' ')[0] ?? '') : '') || `--${String(iv.kind)}`;

const VERIFY_ROLE: Readonly<Record<string, string>> = { target: 'target', holdout: 'held-out', good: 'good' };

/** What an attempt asked again, and which attempt it was: `resampled #5, attempt 2`, `verify · target, attempt 4`. */
function attemptWords(f: AboutFacts): string | null {
  const m = f.meta ?? {};
  const k = f.attempt?.index ?? null;
  const nth = (n: number | null) => (n ? `, attempt ${n}` : '');
  switch (f.attempt?.kind) {
    case 'probe': {
      const callNo = isObject(m.probe) ? int(m.probe.callNo) : null;
      return `resampled${callNo ? ` #${callNo}` : ''}${nth(k)}`;
    }
    case 'verify': {
      const role = isObject(m.verify) && typeof m.verify.role === 'string' ? (VERIFY_ROLE[m.verify.role] ?? null) : null;
      return `verify${role ? ` · ${role}` : ''}${nth(k)}`;
    }
    case 'test': {
      const t = isObject(m.test) ? m.test : {};
      const golden = str(t.golden);
      return `${golden ? goldenWords(golden) : 'test'}${nth(int(t.attempt) ?? k)}`;
    }
    case 'repeat': {
      const r = isObject(m.repeat) ? m.repeat : {};
      const of = int(r.of);
      const n = int(r.attempt) ?? k;
      return `repeat${n ? `, attempt ${n}${of ? ` of ${of}` : ''}` : ''}`;
    }
    case 'chaos': {
      const c = isObject(m.chaos) ? m.chaos : {};
      const preset = typeof c.preset === 'string' && isChaosPreset(c.preset) ? PRESET_LABELS[c.preset] : (str(c.preset) ?? 'error-path preset');
      const callNo = int(c.callNo);
      const n = int(c.attempt);
      return `${preset}${callNo ? ` #${callNo}` : ''}${n && n > 1 ? `, attempt ${n}` : ''}`;
    }
    default:
      return null;
  }
}

/** A replay `shadowlap injection` made: what it planted, or left out, at which read, and which attempt it was. */
function injectionWords(mark: unknown): string | null {
  if (!isObject(mark)) return null;
  const read = int(mark.read);
  const at = read ? ` #${read}` : '';
  const n = int(mark.attempt);
  const of = int(mark.of);
  const nth = n ? `, attempt ${n}${of ? ` of ${of}` : ''}` : '';
  if (mark.role === 'attempt') return `planted${at}${nth}`;
  if (mark.role === 'baseline') return `baseline from${at}${nth}`;
  if (mark.role === 'clean') return `clean read${at}${nth}`;
  return null;
}

/** A model taking over a golden (`tasks score`): which model, from which call, and which attempt. */
function taskWords(task: unknown): string | null {
  if (!isObject(task)) return null;
  const model = str(task.model);
  const takeover = int(task.takeover);
  const n = int(task.attempt);
  const of = int(task.of);
  if (!model) return null;
  return `${model}${takeover ? ` #${takeover}` : ''}${n ? `, attempt ${n}${of ? ` of ${of}` : ''}` : ''}`;
}

/** What a replay or a fork changed: its first flag that changes what it is given, else its code, else a request, else nothing. */
function changeOf(f: AboutFacts): RunAbout {
  const m = f.meta ?? {};
  const forkAt = f.divergence?.callNo ?? null;
  if (f.rescued) {
    const callNo = isObject(m.probe) ? int(m.probe.callNo) : null;
    return { text: `rescued${callNo ? ` #${callNo}` : ''}`, from: 'change', change: { flag: '--diverge-at', callNo, forkAt } };
  }
  const injection = injectionWords(m.injection);
  if (injection) return { text: injection, from: 'change', change: null };
  const task = taskWords(m.task);
  if (task) return { text: task, from: 'change', change: null };
  const list = Array.isArray(m.interventions) ? (m.interventions as unknown[]).filter(isObject) : [];
  for (const iv of list) {
    const words = changeWords(iv, { forkAt, answered: f.answered === true });
    if (words) return { text: words, from: 'change', change: { flag: flagName(iv), callNo: int(iv.at), forkAt } };
  }
  if (f.kind === 'clean') return { text: 'clean replay', from: 'nothing', change: null };
  const codeChanged = !!f.parent && !!f.codeVersion && !!f.parent.codeVersion && f.codeVersion !== f.parent.codeVersion;
  if (codeChanged) return { text: 'code changed', from: 'change', change: null };
  if (f.kind === 'fork') return { text: f.divergence?.type === 'ended_early' ? 'ended early' : 'request changed', from: 'change', change: null };
  return { text: 'replay', from: 'nothing', change: null };
}

/** The command as one line, or null for a run with none (an import). */
function commandWords(argv: readonly string[]): string | null {
  if (!argv.length || argv[0] === '<no-recorded-command>') return null;
  return oneLine(argv.join(' ')) || null;
}

/** A run's about line: the first rule above that applies. */
export function aboutOf(f: AboutFacts): RunAbout {
  const m = f.meta ?? {};
  const command = commandWords(f.argv);
  if (f.attempt) {
    const words = attemptWords(f);
    if (words) return { text: words, from: f.attempt.kind === 'test' ? 'golden' : 'change', change: null };
  }
  if (f.kind === 'test') {
    const golden = isObject(m.test) ? str(m.test.golden) : null;
    if (golden) return { text: goldenWords(golden), from: 'golden' };
  }
  if (f.kind === 'fork' || f.kind === 'clean' || f.kind === 'replay' || f.kind === 'test') return changeOf(f);
  if (f.kind === 'capture') {
    const from = isObject(m.imported) ? str(m.imported.from) : null;
    if (from) return { text: sourceWords(from), from: 'source' };
  }
  const ask = f.ask ?? null;
  if (ask?.batch) {
    const input = batchInput(f.argv);
    if (input) return { text: input, from: 'input' };
  } else if (ask?.text) return { text: ask.text, from: ask.agent ? 'agent' : 'user' };
  if (command) return { text: command, from: 'command' };
  const from = isObject(m.imported) ? str(m.imported.from) : null;
  return from ? { text: sourceWords(from), from: 'source' } : { text: f.kind === 'capture' ? 'a capture' : 'a recording', from: 'command' };
}
