import { num } from '../format.js';
import { jsString as literal } from '../../../engine/src/text.js';
import { UNGUARDED_FIX } from './note-words.js';
import { refusedTools, runNotes, type NotePart, type NotesInput, type RunNote, type UnrecordedToolView } from './notes.js';

/**
 * A run's notes in words, as notes.ts decided them: each one's line, the model's unrecorded tools a
 * row each, and what to do, in the words the CLI prints them in. Loaded with RunNotes.tsx, which
 * draws them, the first time a run's page draws a note. No DOM here: the tests import it.
 */

export { noteText } from './note-words.js';

/** A note's words: its line, the tools the model called that the run never recorded, and what to do (how to have them recorded, with the config's lines to copy, `copy`). */
export interface NoteLines {
  parts: NotePart[];
  tools?: UnrecordedToolView[];
  hint?: { parts: NotePart[]; copy?: string };
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

/**
 * The lines of `shadowlap.config.json` that declare what each tool does, to copy: a write as a write
 * and a read as a read; one whose effect nothing says as a write, the safe guess, to change if it
 * only reads.
 */
export function declareSnippet(tools: readonly Pick<UnrecordedToolView, 'name' | 'effect'>[]): string {
  const pairs = tools.map((t) => `${JSON.stringify(t.name)}: "${t.effect === 'read' ? 'read' : 'write'}"`);
  return `"tools": { "unrecorded": { ${pairs.join(', ')} } }`;
}

/**
 * What refused tools do, as the CLI says it: one `writes` or `may write` (its effect unknown), several
 * `write`, `may write`, or `write, or may`.
 */
function acts(tools: readonly Pick<UnrecordedToolView, 'effect'>[]): string {
  const unknown = tools.some((t) => t.effect === 'unknown');
  const writes = tools.some((t) => t.effect === 'write');
  if (tools.length === 1) return unknown ? 'may write' : 'writes';
  return unknown && writes ? 'write, or may' : unknown ? 'may write' : 'write';
}

function unrecordedLines(u: NonNullable<NotesInput['unrecorded']>, mode: string): NoteLines {
  const tools = u.tools;
  const n = tools.length;
  const them = n === 1 ? 'it' : 'them';
  if (u.partial)
    return {
      parts: [`This run holds its model calls alone, as a capture or a trace does: a replay runs ${n === 1 ? 'the tool' : `the ${num(n)} tools`} they asked for live, `, ...names(tools.map((t) => t.name)), '.'],
      tools: [...tools],
    };
  // A replay refuses one that writes, and one whose effect nothing tells, which may: the CLI's refusedEffect.
  const refused = refusedTools(tools);
  const parts: NotePart[] = [`The model called ${n === 1 ? 'a tool' : `${num(n)} tools`} Shadowlap did not record: ${mode === 'replay' ? `this replay ran ${them} for real` : `${n === 1 ? 'it' : 'they'} ran in your agent unseen, and a replay runs ${them} for real`}.`];
  if (refused.length) {
    const w = refused.length === 1;
    parts.push(' ', ...names(refused.map((t) => t.name)), ` ${acts(refused)}, so every command that replays the run refuses to run ${w ? 'it' : 'them'} again until ${w ? 'it is' : 'they are'} recorded, declared a read, or allowed with `, { code: '--allow-unrecorded' }, '.');
  }
  // As the CLI shows it: the first refused, else the first that leaves Claude Code's session, and how to have it recorded.
  const shown = refused[0] ?? tools.find((t) => t.fix !== 'none');
  const how = shown ? howToRecord(shown) : null;
  const copy = declareSnippet(tools);
  return {
    parts,
    tools: [...tools],
    ...(how ? { hint: { parts: [...how, '. Or declare what each does in ', { code: 'shadowlap.config.json' }, ': '], copy } } : {}),
  };
}

/**
 * How to have a tool recorded, in the CLI's words (its howToRecord): a Claude Code built-in (in a run
 * from Claude Code only, which the tool's `fix` says) through the Claude Agent SDK's fence, an MCP
 * server's tool through `shadowlap mcp`, anything else wrapped where the agent runs it, in Node or
 * Python. Null for a built-in that keeps to Claude Code's session.
 */
function howToRecord(t: UnrecordedToolView): NotePart[] | null {
  switch (t.fix) {
    case 'fence':
      return ['To have it recorded and replayed, run the query through ', { code: 'withFence' }, ' from ', { code: '@shadowlap/adapters/claude-agent-sdk' }, ` (`, { code: 'with_fence' }, ` in Python), which records ${t.name} and fences it on replay`];
    case 'fence-effects':
      return ['To have it recorded, name it in ', { code: 'withFence' }, '’s effects, ', { code: `withFence(options, { effects: { ${literal(t.name)}: 'write' } })` }, ', which records it and refuses to run it again on replay'];
    case 'mcp':
      return ['To have it recorded and replayed, connect your agent to its MCP server through ', { code: 'shadowlap mcp' }, ', which records and fences its calls'];
    case 'none':
      return null;
    default: {
      const effect = t.effect === 'read' ? 'read' : 'write';
      return ['Wrap each where your agent runs it, so it is recorded and replayed: ', { code: `tool(${literal(t.name)}, { effect: '${effect}' }, fn)` }, ' with ', { code: '@shadowlap/sdk' }, ' (', { code: `@tool(${JSON.stringify(t.name)}, effect="${effect}")` }, ' from ', { code: 'shadowlap' }, ' in Python)'];
    }
  }
}

function webSocketLines(used: NonNullable<NotesInput['websockets']>, which: 'live' | 'refused', mode: string): NoteLines {
  const list = (us: typeof used) => {
    const parts: NotePart[] = [];
    us.forEach((u, i) => {
      if (i) parts.push(', ');
      parts.push({ code: u.target }, ` (${num(u.count)})`);
    });
    return parts;
  };
  const total = (us: typeof used) => us.reduce((n, u) => n + u.count, 0);
  if (which === 'live') {
    const live = used.filter((u) => u.action === 'tunnelled');
    const n = total(live);
    const one = n === 1;
    const after = mode === 'replay' ? `${one ? 'It' : 'They'} ran for real during the replay, as ${one ? 'it does' : 'they do'} on every replay` : 'A replay connects again for real';
    return { parts: [`${plural(n, 'WebSocket connection')} went to the provider live and ${one ? 'was' : 'were'} not recorded: `, ...list(live), `. ${after}; an offline replay (`, { code: 'shadowlap test' }, `) refuses ${one ? 'it' : 'them'}.`] };
  }
  const refused = used.filter((u) => u.action === 'refused');
  const n = total(refused);
  return { parts: [`${plural(n, 'WebSocket connection')} ${n === 1 ? 'was' : 'were'} refused: the replay is offline, and a recording holds no WebSocket to answer from: `, ...list(refused), '.'] };
}

function extraLines(extra: NonNullable<NotesInput['extraReads']>): NoteLines {
  const parts: NotePart[] = [`${plural(extra.length, 'extra read')} answered live, with no recorded counterpart: `];
  extra.slice(0, 3).forEach((e, i) => {
    if (i) parts.push(', ');
    parts.push({ call: e.callNo }, ` ${e.kind} ${e.name}`);
  });
  if (extra.length > 3) parts.push(', …');
  parts.push('. The replay went on replaying: a value one of them gave may be what changed a request after it.');
  return { parts };
}

/** A note's words, as notes.ts decided it, from what the run kept (`of`). */
export function noteLines(n: RunNote): NoteLines {
  const i = n.of;
  switch (n.kind) {
    case 'unrecorded':
      return unrecordedLines(i.unrecorded!, i.mode);
    case 'preload':
      return n.which === 'unguarded' ? { parts: [i.preloads!.unguarded!], hint: { parts: [...UNGUARDED_FIX] } } : { parts: [i.preloads!.missing!] };
    case 'websocket':
      return webSocketLines(i.websockets!, n.which === 'refused' ? 'refused' : 'live', i.mode);
    case 'extra':
      return extraLines(i.extraReads!);
  }
}

/** A run's notes with their words, as its findings bar draws them: for tests. */
export function notesSaid(i: NotesInput): Array<RunNote & NoteLines> {
  return runNotes(i).map((n) => ({ ...n, ...noteLines(n) }));
}
