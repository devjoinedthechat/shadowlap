import { num } from '../format.js';

/**
 * What a run's page says, under its banner, of what the run did that Shadowlap did not record or
 * answered as it went, from what wave one's runs keep: the tools the model called that the run never
 * recorded (contract 10), which a replay runs for real and `replay` and `test` refuse when one
 * writes, with how to wrap or declare them; a run whose agent loaded no preload, so the network guard
 * never watched it; the WebSockets that went to a provider live, which no recording holds; and a
 * replay's extra reads, the clock and random reads it answered live because its recording had no
 * counterpart for them. A line each, in the words the CLI prints them in. No DOM here: the tests
 * import it, and `RunNotes.tsx` draws it.
 */

/** A part of a note's line: words, a name set as code, or a call that opens on a click. */
export type NotePart = string | { code: string } | { call: number };

export interface UnrecordedToolView {
  name: string;
  count: number;
  firstCallNo: number;
  effect: 'write' | 'read' | 'unknown';
  why: string;
}

export interface RunNote {
  kind: 'unrecorded' | 'preload' | 'websocket' | 'extra';
  /** Red for what a replay refuses or a run failed for, amber for what runs for real unseen, grey for what is only so. */
  tone: 'err' | 'warn' | 'n';
  /** Its few words in front, as a banner's: `not recorded`, `no preload`. */
  label: string;
  parts: NotePart[];
  /** The model's unrecorded tools, a row each. */
  tools?: UnrecordedToolView[];
  /** How to have them recorded, with the config's lines to copy. */
  hint?: { parts: NotePart[]; copy: string };
}

export interface NotesInput {
  /** The run's unrecorded tools, as `GET /api/runs/:id/unrecorded` answers; null until it has. */
  unrecorded: { tools: readonly UnrecordedToolView[]; partial: boolean } | null;
  /** The run's preloads, as it keeps them (`RunMeta.preloads`). */
  preloads?: { guard: string; hellos: Readonly<Record<string, number>>; missing?: string | null } | null;
  websockets?: ReadonlyArray<{ target: string; count: number; action: 'tunnelled' | 'refused' }> | null;
  extraReads?: ReadonlyArray<{ callNo: number; kind: string; name: string }> | null;
  mode: 'record' | 'replay' | string;
}

const plural = (n: number, one: string, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;
/** `Bash`, `Bash and Write`, `Bash, Write and Edit`: each set as code. */
function names(list: readonly string[]): NotePart[] {
  const out: NotePart[] = [];
  list.forEach((n, i) => {
    if (i) out.push(i === list.length - 1 ? ' and ' : ', ');
    out.push({ code: n });
  });
  return out;
}

/** A tool's name as a JavaScript string, in the single quotes the SDK's examples use. */
const literal = (name: string) => `'${name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/**
 * The lines of `shadowlap.config.json` that declare what each tool does, to copy: a write as a write
 * and a read as a read; one whose effect nothing says as a write, the safe guess, to change if it
 * only reads.
 */
export function declareSnippet(tools: readonly Pick<UnrecordedToolView, 'name' | 'effect'>[]): string {
  const pairs = tools.map((t) => `${JSON.stringify(t.name)}: "${t.effect === 'read' ? 'read' : 'write'}"`);
  return `"tools": { "unrecorded": { ${pairs.join(', ')} } }`;
}

function unrecordedNote(u: NonNullable<NotesInput['unrecorded']>, mode: string): RunNote | null {
  const tools = u.tools;
  if (!tools.length) return null;
  const n = tools.length;
  const them = n === 1 ? 'it' : 'them';
  if (u.partial)
    return {
      kind: 'unrecorded',
      tone: 'n',
      label: 'not recorded',
      parts: [`This run holds its model calls alone, as a capture or a trace does: a replay runs ${n === 1 ? 'the tool' : `the ${num(n)} tools`} they asked for live, `, ...names(tools.map((t) => t.name)), '.'],
      tools: [...tools],
    };
  const writes = tools.filter((t) => t.effect === 'write');
  const parts: NotePart[] = [`The model called ${n === 1 ? 'a tool' : `${num(n)} tools`} Shadowlap did not record: ${mode === 'replay' ? `this replay ran ${them} for real` : `${n === 1 ? 'it' : 'they'} ran in your agent unseen, and a replay runs ${them} for real`}.`];
  if (writes.length) {
    const w = writes.length === 1;
    parts.push(' ', ...names(writes.map((t) => t.name)), ` ${w ? 'writes' : 'write'}, so shadowlap replay and test refuse to run ${w ? 'it' : 'them'} again until ${w ? 'it is' : 'they are'} recorded, declared a read, or allowed with `, { code: '--allow-unrecorded' }, '.');
  }
  // As the CLI shows it: the first that writes, else the first named, wrapped with its effect.
  const shown = writes[0] ?? tools[0]!;
  const copy = declareSnippet(tools);
  return {
    kind: 'unrecorded',
    tone: writes.length ? 'err' : 'warn',
    label: 'not recorded',
    parts,
    tools: [...tools],
    hint: { parts: [`Wrap each where your agent runs it, so it is recorded and replayed: `, { code: `tool(${literal(shown.name)}, { effect: '${shown.effect === 'read' ? 'read' : 'write'}' }, fn)` }, ' with ', { code: '@shadowlap/sdk' }, '. Or declare what each does in ', { code: 'shadowlap.config.json' }, ': '], copy },
  };
}

function preloadNote(p: NonNullable<NotesInput['preloads']>): RunNote | null {
  if (!p.missing) return null;
  // Under --guard block the run failed for it; under warn it only went unwatched.
  return { kind: 'preload', tone: p.guard === 'block' ? 'err' : 'warn', label: 'no preload', parts: [p.missing] };
}

function webSocketNotes(used: NonNullable<NotesInput['websockets']>, mode: string): RunNote[] {
  const out: RunNote[] = [];
  const list = (us: typeof used) => {
    const parts: NotePart[] = [];
    us.forEach((u, i) => {
      if (i) parts.push(', ');
      parts.push({ code: u.target }, ` (${num(u.count)})`);
    });
    return parts;
  };
  const total = (us: typeof used) => us.reduce((n, u) => n + u.count, 0);
  const live = used.filter((u) => u.action === 'tunnelled');
  if (live.length) {
    const n = total(live);
    const one = n === 1;
    const after = mode === 'replay' ? `${one ? 'It' : 'They'} ran for real during the replay, as ${one ? 'it does' : 'they do'} on every replay` : 'A replay connects again for real';
    out.push({ kind: 'websocket', tone: 'warn', label: 'websocket', parts: [`${plural(n, 'WebSocket connection')} went to the provider live and ${one ? 'was' : 'were'} not recorded: `, ...list(live), `. ${after}; an offline replay (`, { code: 'shadowlap test' }, `) refuses ${one ? 'it' : 'them'}.`] });
  }
  const refused = used.filter((u) => u.action === 'refused');
  if (refused.length) {
    const n = total(refused);
    out.push({ kind: 'websocket', tone: 'n', label: 'websocket', parts: [`${plural(n, 'WebSocket connection')} ${n === 1 ? 'was' : 'were'} refused: the replay is offline, and a recording holds no WebSocket to answer from: `, ...list(refused), '.'] });
  }
  return out;
}

function extraNote(extra: NonNullable<NotesInput['extraReads']>): RunNote | null {
  if (!extra.length) return null;
  const parts: NotePart[] = [`${plural(extra.length, 'extra read')} answered live, with no recorded counterpart: `];
  extra.slice(0, 3).forEach((e, i) => {
    if (i) parts.push(', ');
    parts.push({ call: e.callNo }, ` ${e.kind} ${e.name}`);
  });
  if (extra.length > 3) parts.push(', …');
  parts.push('. The replay went on replaying: a value one of them gave may be what changed a request after it.');
  return { kind: 'extra', tone: 'n', label: 'extra reads', parts };
}

/** The run's notes, most pressing first: a replay's refusal, a run the guard never watched, what ran live unseen, then what is only so. */
export function runNotes(i: NotesInput): RunNote[] {
  const notes = [i.unrecorded ? unrecordedNote(i.unrecorded, i.mode) : null, i.preloads ? preloadNote(i.preloads) : null, ...(i.websockets ? webSocketNotes(i.websockets, i.mode) : []), i.extraReads ? extraNote(i.extraReads) : null].filter((n): n is RunNote => n !== null);
  const rank = { err: 0, warn: 1, n: 2 } as const;
  return notes.map((n, at) => ({ n, at })).sort((a, b) => rank[a.n.tone] - rank[b.n.tone] || a.at - b.at).map((x) => x.n);
}

/** A note's words alone, as a screen reader and a test read them. */
export function noteText(parts: readonly NotePart[]): string {
  return parts.map((p) => (typeof p === 'string' ? p : 'code' in p ? p.code : `#${p.call}`)).join('');
}

/** The host a model call went to (`meta.via`), in words: a host the config declares, in its format, or one built in by name. */
export function viaWords(via: string, provider: string | null): string {
  if (via === 'foundry') return 'Claude on Microsoft Foundry';
  if (via === 'bedrock-mantle') return 'OpenAI’s API on Amazon Bedrock';
  const format = provider === 'openai' ? 'OpenAI' : provider === 'anthropic' ? 'Anthropic' : provider === 'gemini' ? 'Gemini' : provider;
  return format ? `${via}, a host your config declares, in ${format}’s format` : `${via}, a host your config declares`;
}

/** A runtime as the guard row names it: Node, Python, else the name it said. */
const runtimeName = (r: string) => (r === 'node' ? 'Node' : r === 'python' ? 'Python' : r);

/**
 * The preloads of a run, for Provenance's Guard row: the guard it ran, then the processes whose
 * preload said it loaded, by runtime (`block · loaded in 2 Node processes and 1 Python process`), or
 * that none did (`warn · no preload loaded`).
 */
export function preloadWords(p: { guard: string; hellos: Readonly<Record<string, number>>; missing?: string | null }): string {
  const loaded = Object.entries(p.hellos)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([r, n]) => `${num(n)} ${runtimeName(r)} ${n === 1 ? 'process' : 'processes'}`);
  const said = loaded.length ? `loaded in ${loaded.length > 1 ? `${loaded.slice(0, -1).join(', ')} and ${loaded.at(-1)}` : loaded[0]}` : p.guard === 'off' ? 'no guard' : 'no preload loaded';
  return `${p.guard} · ${said}`;
}

/** A run's preloads as it keeps them (`meta.preloads`), checked: a run can come from someone else's pack. Null for none. */
export function preloadsOf(meta: { preloads?: unknown } | null | undefined): { guard: 'warn' | 'block' | 'off'; hellos: Record<string, number>; missing: string | null } | null {
  const v = meta?.preloads;
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const guard = o.guard === 'warn' || o.guard === 'block' || o.guard === 'off' ? o.guard : null;
  if (!guard) return null;
  const hellos: Record<string, number> = {};
  if (o.hellos && typeof o.hellos === 'object') for (const [r, n] of Object.entries(o.hellos as Record<string, unknown>)) if (/^[a-z][a-z0-9-]{0,19}$/.test(r) && Number.isInteger(n) && (n as number) > 0) hellos[r] = n as number;
  return { guard, hellos, missing: typeof o.missing === 'string' && o.missing ? o.missing : null };
}
