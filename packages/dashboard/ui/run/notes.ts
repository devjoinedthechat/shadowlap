/**
 * What a run's page says, under its banner, of what the run did that shadowlap did not record or
 * answered as it went, from what wave one's runs keep: the tools the model called that the run never
 * recorded (contract 10), which a replay runs for real and every command that replays the run
 * refuses when one writes, or may, with how to have them recorded or declare them; a run whose agent loaded no preload, so the network guard
 * never watched it; the WebSockets that went to a provider live, which no recording holds; and a
 * replay's extra reads, the clock and random reads it answered live because its recording had no
 * counterpart for them; and a process of the agent the guard could not watch, such as the Claude
 * Code CLI the Claude Agent SDK runs, with what `shadowlap doctor` says to do. A line each, in the
 * words the CLI prints them in.
 *
 * This module decides which notes a run has, each one's weight, label and whether it has more under
 * its line: what the findings bar sorts, counts and lists by (findings.ts) from its first frame. Their
 * words (note-lines.ts) and their drawing (RunNotes.tsx) are a part of their own, loaded the first
 * time a run's page draws a note, so the page's script holds neither. No DOM here: the tests import it.
 */

/** A part of a note's line: words, a name set as code, or a call that opens on a click. */
export type NotePart = string | { code: string } | { call: number };

export interface UnrecordedToolView {
  name: string;
  count: number;
  firstCallNo: number;
  effect: 'write' | 'read' | 'unknown';
  why: string;
  /** How to have it recorded, as the engine's unrecordedFix says: through the Claude Agent SDK's fence, `shadowlap mcp`, or wrapped. Absent from an older server. */
  fix?: 'fence' | 'fence-effects' | 'mcp' | 'none' | 'wrap';
}

/** A note as the page decides it, before its words (note-lines.ts reads them from `of`). */
export interface RunNote {
  kind: 'unrecorded' | 'preload' | 'websocket' | 'extra';
  /** Which of its kind's notes: a preload that never loaded or a process unguarded; WebSockets gone live or refused. */
  which?: 'missing' | 'unguarded' | 'live' | 'refused';
  /** Red for what a replay refuses or a run failed for, amber for what runs for real unseen, grey for what is only so. */
  tone: 'err' | 'warn' | 'n';
  /** Its few words in front, as a banner's: `not recorded`, `no preload`. */
  label: string;
  /** Whether it has more under its line, which a closed bar hides: the model's unrecorded tools, or what to do. */
  more: boolean;
  /** What the run kept that it tells of. */
  of: NotesInput;
}

export interface NotesInput {
  /** The run's unrecorded tools, as `GET /api/runs/:id/unrecorded` answers; null until it has. */
  unrecorded: { tools: readonly UnrecordedToolView[]; partial: boolean } | null;
  /** The run's preloads, as it keeps them (`RunMeta.preloads`). */
  preloads?: { guard: string; hellos: Readonly<Record<string, number>>; missing?: string | null; unguarded?: string | null } | null;
  websockets?: ReadonlyArray<{ target: string; count: number; action: 'tunnelled' | 'refused' }> | null;
  extraReads?: ReadonlyArray<{ callNo: number; kind: string; name: string }> | null;
  mode: 'record' | 'replay' | (string & {});
  /** This dashboard runs jobs and offers Run again, allowing on one the CLI refuses (allow-again.tsx), so a note says that rather than the flag. */
  allowsAgain?: boolean;
}

/** The unrecorded tools a replay refuses: one that writes, and one whose effect nothing tells, which may (the CLI's refusedEffect). */
export const refusedTools = <T extends Pick<UnrecordedToolView, 'effect'>>(tools: readonly T[]): T[] => tools.filter((t) => t.effect !== 'read');

/** The tools the model called that the run never recorded: grey where it holds its model calls alone, as a capture or a trace does; red where a replay refuses one; else amber. */
function unrecordedNotes(i: NotesInput): RunNote[] {
  const u = i.unrecorded;
  if (!u?.tools.length) return [];
  return [{ kind: 'unrecorded', tone: u.partial ? 'n' : refusedTools(u.tools).length ? 'err' : 'warn', label: 'not recorded', more: true, of: i }];
}

/**
 * The run's preloads: none loaded, so the guard never watched the run; or a process of the agent said
 * it runs with no guard (`unguarded`), as the Claude Code CLI does, with what to do. Under --guard
 * block the run failed for either; under warn it only went unwatched.
 */
function preloadNotes(i: NotesInput): RunNote[] {
  const p = i.preloads;
  if (!p) return [];
  const tone: RunNote['tone'] = p.guard === 'block' ? 'err' : 'warn';
  return [
    ...(p.missing ? [{ kind: 'preload' as const, which: 'missing' as const, tone, label: 'no preload', more: false, of: i }] : []),
    ...(p.unguarded ? [{ kind: 'preload' as const, which: 'unguarded' as const, tone, label: 'unguarded', more: true, of: i }] : []),
  ];
}

/** The WebSockets that went to a provider live, amber, and those an offline replay refused, grey. */
function webSocketNotes(i: NotesInput): RunNote[] {
  const used = i.websockets ?? [];
  const note = (which: 'live' | 'refused', tone: RunNote['tone']): RunNote => ({ kind: 'websocket', which, tone, label: 'websocket', more: false, of: i });
  return [...(used.some((u) => u.action === 'tunnelled') ? [note('live', 'warn')] : []), ...(used.some((u) => u.action === 'refused') ? [note('refused', 'n')] : [])];
}

/** The run's notes, most pressing first: a replay's refusal, a run the guard never watched, what ran live unseen, then what is only so. */
export function runNotes(i: NotesInput): RunNote[] {
  const extra: RunNote[] = i.extraReads?.length ? [{ kind: 'extra', tone: 'n', label: 'extra reads', more: false, of: i }] : [];
  const notes = [...unrecordedNotes(i), ...preloadNotes(i), ...webSocketNotes(i), ...extra];
  const rank = { err: 0, warn: 1, n: 2 } as const;
  return notes.map((n, at) => ({ n, at })).sort((a, b) => rank[a.n.tone] - rank[b.n.tone] || a.at - b.at).map((x) => x.n);
}

/** The host a model call went to (`meta.via`), in words: a host the config declares, in its format, or one built in by name. */
export function viaWords(via: string, provider: string | null): string {
  if (via === 'foundry') return 'Claude on Microsoft Foundry';
  if (via === 'bedrock-mantle') return 'OpenAI’s API on Amazon Bedrock';
  const format = provider === 'openai' ? 'OpenAI' : provider === 'anthropic' ? 'Anthropic' : provider === 'gemini' ? 'Gemini' : provider;
  return format ? `${via}, a host your config declares, in ${format}’s format` : `${via}, a host your config declares`;
}
