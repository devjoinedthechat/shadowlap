import { tildePath } from './format.js';
import type { Route } from './route.js';
import { isAttempt, type RunLike } from './runs.js';
import type { LiveRun, Meta } from './types.js';

/**
 * What the projects screens decide without the DOM: where the setup shows instead of a page, when a
 * typed name confirms deleting recordings, and how a step's words put names and paths in code. The
 * tests import it.
 */

/**
 * Whether the current project's setup shows in place of the page the route names: on every page but
 * Settings (and Add a project) while the project has no runs, on the Overview while its setup isn't
 * finished, and always at `#/setup`. Null while that can't be told yet (neither the run list nor
 * the meta has arrived): the page waits rather than flashing. An exported copy never shows it.
 */
export function setupShowsOn(route: Route, s: { exported: boolean; meta: Meta | null; runs: readonly RunLike[] | null }): boolean | null {
  if (s.exported || s.meta?.static) return false;
  if (route.page === 'setup') return true;
  if (route.page === 'new' || route.page === 'settings' || route.page === 'notfound') return false;
  const noRuns = s.runs ? !s.runs.some((r) => !isAttempt(r)) : s.meta?.counts ? s.meta.counts.runs === 0 : null;
  // A run page opens on its own: a project with runs is the likely case, and an unknown run says so.
  if (noRuns === null) return route.page === 'run' ? false : null;
  if (noRuns) return true;
  return route.page === 'overview' && s.meta?.project?.settingUp === true;
}

/** The typed name confirms deleting a project's recordings: trimmed and composed, as the server compares it. */
export function nameMatches(typed: string, name: string): boolean {
  return typed.trim().normalize('NFC') === name.normalize('NFC');
}

/** A setup step's class in the mock's list: done, the current one, or one still to do (or skipped). */
export function stepClass(state: 'done' | 'current' | 'todo' | 'skipped'): 'done' | 'cur' | 'todo' {
  return state === 'done' ? 'done' : state === 'current' ? 'cur' : 'todo';
}

export interface TextPart {
  text: string;
  code: boolean;
}

/**
 * Splits a sentence so the names in it (tools, paths, a golden) can show as code, as the mock writes
 * them: `save_report and notify_slack would act again`. Longer names first, so one that holds another
 * stays whole; each name is matched where it stands as a word.
 */
export function codeParts(text: string, names: readonly string[]): TextPart[] {
  const wanted = [...new Set(names.filter((n) => n.length > 0))].sort((a, b) => b.length - a.length);
  if (!wanted.length) return [{ text, code: false }];
  const escaped = wanted.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`(?<![\\w$.-])(${escaped.join('|')})(?![\\w-])`, 'g');
  const parts: TextPart[] = [];
  let at = 0;
  for (const m of text.matchAll(re)) {
    const i = m.index ?? 0;
    if (i > at) parts.push({ text: text.slice(at, i), code: false });
    parts.push({ text: m[0], code: true });
    at = i + m[0].length;
  }
  if (at < text.length) parts.push({ text: text.slice(at), code: false });
  return parts.length ? parts : [{ text, code: false }];
}

/** "Recorded 01K5CQ7A3M · 10 calls · ≈$0.019 · 19.0 s": the words before the run's id, and after it, so the id can be a link. */
export function aroundRunId(text: string, runId: string): { before: string; id: string; after: string } {
  const short = runId.slice(0, 10);
  const i = text.indexOf(short);
  if (i < 0) return { before: text, id: '', after: '' };
  return { before: text.slice(0, i), id: short, after: text.slice(i + short.length) };
}

/** The calls a recording holds so far: the live count when the dashboard follows it, else what the setup said. */
export function liveCalls(runId: string, said: number, live: readonly LiveRun[]): number {
  return Math.max(said, live.find((l) => l.runId === runId)?.calls ?? 0);
}

/** "Recording 01K5CQ7A3M · 3 calls so far": the words with the live count. */
export function recordingLine(runId: string, calls: number): { id: string; rest: string } {
  return { id: runId.slice(0, 10), rest: ` · ${calls.toLocaleString('en-US')} ${calls === 1 ? 'call' : 'calls'} so far` };
}

/** What the record step's terminal line says until a command is found or typed (`setupCommands`). */
export const RECORD_PLACEHOLDER = '<the command that starts your agent>';

/**
 * The record step's "or in a terminal" line with the command as typed in the field, in place of
 * the one the setup found (or the placeholder when it found none): what Record would run.
 */
export function terminalLine(cli: readonly string[], found: string, typed: string | null): readonly string[] {
  const now = typed?.trim();
  if (!now || now === found) return cli;
  return cli.map((line) => line.replace(found || RECORD_PLACEHOLDER, now));
}

/**
 * Where the golden's sentence sends people for redaction rules: the text around the word Settings,
 * so it can be the link the mock makes it.
 */
export function aroundWord(text: string, word: string): { before: string; word: string; after: string } | null {
  const i = text.indexOf(word);
  if (i < 0) return null;
  return { before: text.slice(0, i), word, after: text.slice(i + word.length) };
}

/**
 * The store's path as the status bar shows it: under the project's folder as the server names it
 * (`~/support-agent/.shadowlap/shadowlap.db`, from the real home folder), else with ~ for a home
 * folder the path itself shows.
 */
export function storePath(meta: Pick<Meta, 'dbPath' | 'project'>): string {
  const dbPath = meta.dbPath ?? '';
  const p = meta.project;
  const rest = p?.display && dbPath.startsWith(p.path) ? dbPath.slice(p.path.length) : null;
  return rest !== null && /^[\\/]/.test(rest) ? p!.display + rest : tildePath(dbPath);
}
