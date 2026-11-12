import { ACTIONS, forceLiveLabel } from './labels.js';
import type { PromptChoice } from './types.js';

/**
 * The fork menu, from the action list the server sends for a call: what applies to the call, each
 * with its flag on the right, then what applies to the whole run, and the words of the dialog an
 * action asks its one thing in. The server builds every command line; this only arranges and words
 * the list. No DOM here: the tests import it.
 */

export interface ActionLike {
  key: string;
  label: string;
  opensRun: boolean;
  prompt: { label: string; placeholder?: string; initial?: string; choices?: readonly PromptChoice[] } | null;
  disabled: string | null;
  /** The CLI flag it adds, shown on the right ("--fail-at 19=529"). */
  flag?: string;
  /** Whether it acts on the selected call or the whole run; null when it has a place of its own (Replay, Pack, a normalizer). */
  group?: 'call' | 'run' | null;
  /** One line on what it does and why, from the server. */
  hint?: string;
  /** It asks before it starts, with nothing to fill in: a fork's Repeat 5 times, whose attempts run live. */
  asksFirst?: true;
  /** The command it runs, from the server, for an action with nothing to fill in. */
  command?: string;
  /** The model at this call, where it takes no system message mid-conversation: an instruction's As row names it. */
  noSystemMessage?: string;
  /** What it does for real, as its dialog's red line: a write forced live. */
  warns?: string;
}

/** Actions with a place of their own: Replay in the header, Pack in Share, the normalizer in the divergence banner. */
export const OWN_PLACE = new Set(['r', 'p', 'n']);
/** Today's run-wide keys, for a server that does not send `group`. */
const RUN_KEYS = new Set(['r', 's', 'e', 'n', 'p']);

/**
 * The fork menu's words for an action a server sends without its flag (one older than the flags):
 * the engine's, in the CLI's verbs, an ellipsis on each that asks for something first.
 */
const KNOWN: Record<string, { label: string; flag: string }> = {
  i: { label: ACTIONS.injectInstruction.label, flag: '--inject' },
  m: { label: ACTIONS.switchModel.label, flag: '--model' },
  g: { label: ACTIONS.useChangedPrompt.label, flag: '--prompt-from' },
  f: { label: ACTIONS.failWithStatus.label, flag: '--fail-at' },
  o: { label: ACTIONS.overrideResult.label, flag: '--override' },
  a: { label: ACTIONS.runLive.label, flag: '--diverge-at' },
  e: { label: ACTIONS.repeat.label, flag: '--repeat' },
  s: { label: ACTIONS.replayStubbed.label, flag: '--writes stub' },
};

/** Most used first, as the mock lists them; keys it does not know sit before force-live and diverge. */
const ORDER = ['i', 'm', 'g', 'f', 'o', '*', 'l', 'a', 'e', 's'];
const rank = (key: string) => {
  const i = ORDER.indexOf(key);
  return i < 0 ? ORDER.indexOf('*') : i;
};

export interface MenuItem {
  action: ActionLike;
  label: string;
  flag: string;
}

function capitalize(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

/** An action's words for the menu: the server's label without "Fork:" and its trailing flag. */
export function menuLabel(a: ActionLike, toolName?: string | null): string {
  if (!a.flag) {
    if (a.key === 'l' && toolName) return forceLiveLabel(toolName);
    const known = KNOWN[a.key];
    if (known) return known.label;
  }
  return capitalize(a.label.replace(/^Fork:\s*/i, '').replace(/\s*\((--[^)]*|bisect[^)]*)\)\s*$/, '').trim());
}

/**
 * The flag on the right of an action's line, as a menu shows a shortcut: at a call, the option alone
 * (`--fail-at`), since the line is about that call already; for the whole run, the option and its
 * value (`--repeat 5`, `--writes stub`). The full flag is on the line's hover, and in its dialog.
 */
export function menuFlag(a: ActionLike): string {
  if (a.flag && a.group === 'call') return a.flag.trim().split(/\s+/)[0] ?? '';
  if (a.flag) return shortFlag(a.flag);
  const fromLabel = /\(((?:--|bisect)[^)]*)\)\s*$/.exec(a.label)?.[1];
  return fromLabel ?? KNOWN[a.key]?.flag ?? '';
}

/** The flag as the menu shows it on the right: the first option and its value (`--inject 17=…`); the dialog shows the rest. */
export function shortFlag(flag: string): string {
  const [first, second] = flag.trim().split(/\s+/);
  if (!first) return '';
  return second && !second.startsWith('--') ? `${first} ${second}` : first;
}

export function isRunAction(a: ActionLike): boolean {
  return a.group ? a.group === 'run' : RUN_KEYS.has(a.key);
}

export interface ForkMenu {
  call: MenuItem[];
  run: MenuItem[];
}

/**
 * The fork menu's two groups. A server that groups its actions has them in the menu's order already,
 * and leaves out (`group: null`) what has a place of its own; for one that does not, the actions are
 * sorted by key into the mock's order, and Replay, Pack and the normalizer are left out by key.
 */
export function forkMenu(actions: readonly ActionLike[], toolName?: string | null): ForkMenu {
  const item = (a: ActionLike): MenuItem => ({ action: a, label: menuLabel(a, toolName), flag: menuFlag(a) });
  const grouped = actions.length > 0 && actions.every((a) => a.group !== undefined);
  const sorted = grouped ? [...actions] : [...actions].map((a, i) => ({ a, i })).sort((x, y) => rank(x.a.key) - rank(y.a.key) || x.i - y.i).map((x) => x.a);
  const listed = sorted.filter((a) => a.group !== null);
  return {
    call: listed.filter((a) => !isRunAction(a)).map(item),
    run: listed.filter((a) => isRunAction(a) && (grouped || !OWN_PLACE.has(a.key))).map(item),
  };
}

/** What each fork is for, as a card says it in a short line; its dialog says the rest (the server's hint). */
const ROW_LINE: Readonly<Record<string, string>> = {
  i: 'Adds the instruction at this call, kept for every later request of the fork',
  m: 'From this call on, the new model answers live',
  g: 'From this call on, the model sees your code’s system prompt and tools',
  f: 'Every attempt fails, so the SDK’s retry policy runs and then gives up',
  u: 'The agent gets this reply instead of the recorded one',
  o: 'The agent gets this instead of the recorded result',
  t: 'The tool doesn’t run: the agent gets the error instead',
  x: 'Added to what the tool returned, as an attacker would',
  l: 'Runs its first call for real, instead of serving its recorded result',
  a: 'This call and everything after it run live, with writes fenced',
  e: 'The attempts show whether the path after a fork holds or was luck',
  s: 'Write tools after the fork return their stub instead of being blocked',
  c: 'Each preset fails the call it hits, and its attempts show how the agent copes',
};

/** A fork menu's row on its hover card: what it is for in a short line, the server's hint for an action this page has none for. */
export const forkRowLine = (a: Pick<ActionLike, 'key' | 'hint'>): string | null => ROW_LINE[a.key] ?? a.hint ?? null;

/** The menu's header: the call and its kind, `untrusted read` for a read injection tests plant in, as the engine's forkMenuTitle says it where the server gives none. */
export function forkMenuTitle(call: { callNo: number; kind: string; name: string; effect: string | null; input?: boolean }, shortName: string, o: { untrusted?: boolean } = {}): string {
  const kind =
    call.kind === 'api' ? 'model call' : call.kind === 'clock' ? 'clock read' : call.kind === 'random' ? 'random value' : call.input ? 'recorded input' : o.untrusted && call.effect === 'read' ? 'untrusted read' : call.effect ? `${call.effect} tool` : 'tool';
  return `At #${call.callNo}${call.kind === 'api' ? '' : ` · ${shortName}`} · ${kind}`;
}

/** Whether an action is the inject one, whose dialog explains how the instruction is sent. */
export function isInject(a: ActionLike): boolean {
  return a.key === 'i' || /--inject(?![-\w])/.test(a.flag ?? '') || /--inject(?![-\w])/.test(a.label);
}

/** Whether an action answers a recorded user input differently: an override that starts from the recorded reply. */
export function isUserAnswer(a: ActionLike): boolean {
  return a.key === 'u';
}

/** Whether an action replaces a tool result, so its prompt opens with the recorded one to edit. */
export function isOverride(a: ActionLike): boolean {
  return !isUserAnswer(a) && (a.key === 'o' || /^--override\b/.test(a.flag ?? ''));
}

/** Whether the server sends an injected instruction as part of the last user message. */
export function injectsAsUser(a: ActionLike): boolean {
  return /--inject-as\s+user\b/.test(a.flag ?? '');
}

/**
 * What a dialog sends for an answer picked from its list: the choice's value, followed by the few
 * words a choice with a field of its own asks for (`error:` and `connection reset`).
 */
export function choiceAnswer(choice: PromptChoice, words: string): string {
  return choice.text ? `${choice.value}${words.trim()}` : choice.value;
}

/** A row of a dialog's facts, in words. */
export interface FactWords {
  label: string;
  /** Its words, a name in code between backticks. */
  value: string;
  quiet?: string;
}

/** What a dialog bills: until a price is known, who bills it, then what runs live. */
export interface CostWords {
  price: string;
  parts?: readonly string[];
}

/** A golden a Tests job would run live, and why, as its 409 lists them (src/tests-live.ts). */
export interface LiveGolden {
  path: string;
  why: ReadonlyArray<{ kind: 'fork' } | { kind: 'judges'; models: readonly string[] } | { kind: 'injection' }>;
}

/**
 * The question a job's 409 asks before it runs someone else's command (a pack's, a pulled run's, one
 * a program sent the sidecar): its words, and the `confirm` that says yes to the lines it names,
 * sent back as the job's `yes`. Null for any other error, a 409 that asks nothing among them.
 */
export function consentAsked(err: unknown): { why: string; confirm: string; live?: readonly LiveGolden[] } | null {
  const e = err as { status?: unknown; confirm?: unknown; message?: unknown; live?: unknown } | null;
  if (!e || e.status !== 409 || typeof e.confirm !== 'string' || typeof e.message !== 'string') return null;
  return { why: e.message, confirm: e.confirm, ...(Array.isArray(e.live) ? { live: e.live as LiveGolden[] } : {}) };
}

/** The title of the question a job's consent asks, after where the command came from. */
export function consentTitle(message: string): string {
  if (/came from the team store:/.test(message)) return 'Run command from team store';
  return /came from a program that sent the sidecar its command:/.test(message) ? 'Run command a program sent' : 'Run command from imported pack';
}
