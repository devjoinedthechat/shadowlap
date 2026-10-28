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
}

/** Actions with a place of their own: Replay in the header, Pack in Share, the normalizer in the divergence banner. */
export const OWN_PLACE = new Set(['r', 'p', 'n']);
/** Today's run-wide keys, for a server that does not send `group`. */
const RUN_KEYS = new Set(['r', 's', 'e', 'n', 'p']);

/** The mock's words for today's actions, used while the server does not send its own flags. */
const KNOWN: Record<string, { label: string; flag: string }> = {
  i: { label: 'Inject an instruction', flag: '--inject' },
  m: { label: 'Switch the model from here', flag: '--model' },
  g: { label: 'Fork with your changed prompt', flag: '--prompt-from' },
  f: { label: 'Answer with an HTTP failure', flag: '--fail-at' },
  o: { label: 'Override this tool’s result', flag: '--override' },
  a: { label: 'Diverge here', flag: '--diverge-at' },
  e: { label: 'Repeat the replay and compare', flag: '--repeat' },
  s: { label: 'Stub the writes', flag: '--writes stub' },
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
    if (a.key === 'l' && toolName) return `Force ${toolName} live`;
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

/** The menu's header: the call and its kind. */
export function forkMenuTitle(call: { callNo: number; kind: string; name: string; effect: string | null; input?: boolean }, shortName: string): string {
  const kind =
    call.kind === 'api' ? 'model call' : call.kind === 'clock' ? 'clock read' : call.kind === 'random' ? 'random value' : call.input ? 'recorded input' : call.effect ? `${call.effect} tool` : 'tool';
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

/**
 * The recorded result an override starts from, laid out to edit as the design shows it: an object
 * or a list indented, one value a line. Anything else (a string, a number) stays as the action gives
 * it, which is already the JSON the CLI reads.
 */
function prettyJson(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === 'object' && v !== null ? JSON.stringify(v, null, 2) : text;
  } catch {
    return text;
  }
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

/** What an action's dialog says, and what it asks. */
export interface DialogCopy {
  title: string;
  text: string;
  /** The field's label, when it needs one. */
  label?: string;
  initial: string;
  placeholder: string;
  multiline: boolean;
  ok: string;
  /** The command it runs, under the field, with … for what is typed. */
  command?: string;
  /** Answers to pick from (any other answer is accepted too). */
  choices?: readonly PromptChoice[];
}

export interface DialogContext {
  /** The run's short id. */
  id: string;
  callNo: number | null;
  /** The call's short name ("lookup_order"). */
  callName?: string;
  /** The call's recorded result, for an override that starts from it. */
  recorded?: unknown;
  /** A run imported from a capture, which has no command. */
  capture?: boolean;
}

/**
 * A run from someone else's pack, or a teammate's pulled from the team store, asks first, and says
 * what replaying it runs: that question is the field's label.
 */
const PACK_WARNING = /^This run came from (?:an imported pack|the team store|a program that sent the sidecar its command)/;

/**
 * The question a job's 409 asks before it runs someone else's command (a pack's, a pulled run's, one
 * a program sent the sidecar): its words, and the `confirm` that says yes to the lines it names,
 * sent back as the job's `yes`. Null for any other error, a 409 that asks nothing among them.
 */
export function consentAsked(err: unknown): { why: string; confirm: string } | null {
  const e = err as { status?: unknown; confirm?: unknown; message?: unknown } | null;
  return e && e.status === 409 && typeof e.confirm === 'string' && typeof e.message === 'string' ? { why: e.message, confirm: e.confirm } : null;
}

/** The title of the question a job's consent asks, after where the command came from. */
export function consentTitle(message: string): string {
  if (/came from the team store:/.test(message)) return 'Run a command from the team store?';
  return /came from a program that sent the sidecar its command:/.test(message) ? 'Run a command a program sent the sidecar?' : 'Run a command from an imported pack?';
}

/**
 * The words of the dialog an action asks its one thing in. The server's own hint, when it sends one,
 * says what the action does; the dialog says an instruction goes in as a user message only when the
 * server's flag says so (`--inject-as user`).
 */
export function dialogCopy(a: ActionLike, ctx: DialogContext): DialogCopy {
  const p = a.prompt ?? { label: '' };
  const n = ctx.callNo;
  const at = n === null ? '' : `#${n}`;
  const named = ctx.callName ? ` ${ctx.callName}` : '';
  const base = { initial: p.initial ?? '', placeholder: p.placeholder ?? '', multiline: false, ok: a.opensRun ? 'Fork' : 'Run' };
  let copy: DialogCopy;
  if (isInject(a)) {
    const asUser = injectsAsUser(a);
    const flag = a.flag ? a.flag.replace(/=…/g, '="…"') : `--inject ${n ?? 'n'}="…"`;
    copy = {
      ...base,
      title: `Inject an instruction at ${at}`,
      text:
        a.hint ??
        (asUser
          ? 'Not every model takes a system message mid-conversation, so it goes in as part of the last user message (--inject-as user) and stays in place for every later request of the fork. Calls before it replay.'
          : `The instruction is added at ${at} and stays in place for every later request of the fork. Calls before it replay.`),
      placeholder: p.placeholder ?? 'Escalate refunds above the regional limit to tier 2.',
      multiline: true,
      ok: 'Fork',
      command: `shadowlap replay ${ctx.id} ${flag}`,
    };
  } else if (isUserAnswer(a)) {
    copy = { ...base, title: `Answer ${at} differently`, text: a.hint ?? 'The agent gets this reply instead of the recorded one. Calls before it replay; from here the run goes on live, with writes fenced.', multiline: true, ok: 'Fork' };
  } else if (isOverride(a)) {
    copy = {
      ...base,
      title: `Override ${at}${named}`,
      text: a.hint ?? 'The agent gets this instead of the recorded result. Calls before it replay; from here the run goes on live, with writes fenced.',
      initial: prettyJson(p.initial) ?? (ctx.recorded === undefined ? '' : JSON.stringify(ctx.recorded, null, 2)),
      placeholder: p.placeholder ?? '{"ok": true}',
      multiline: true,
      ok: 'Fork',
    };
  } else if (a.key === 't') {
    copy = { ...base, title: `Answer ${at}${named} with an error`, text: a.hint ?? 'The tool doesn’t run: the agent gets the error instead, and its error path runs live. Calls before it replay.', label: 'Error', initial: p.initial ?? 'timeout', ok: 'Fork' };
  } else if (a.key === 'x') {
    copy = {
      ...base,
      title: `Plant an instruction in ${at}${named}`,
      text: a.hint ?? 'The text is added to what the tool returned, as an attacker would. Calls before it replay free; from here the agent runs live, with writes fenced, and the run’s checks say whether it obeyed.',
      label: 'Instruction',
      multiline: true,
      ok: 'Fork',
    };
  } else if (a.key === 'f') {
    copy = {
      ...base,
      title: `Answer ${at} with a failure`,
      text: a.hint ?? 'Nothing is sent. Every attempt fails, so the SDK’s retry policy runs and then gives up: the path worth testing.',
      label: p.choices?.length ? 'Status' : 'Status (429 rate limit, 500 or 529 overloaded, 400 bad request)',
      initial: p.initial ?? '429',
      ok: 'Fork',
    };
  } else if (a.key === 'm') {
    copy = { ...base, title: `Switch the model from ${at}`, text: a.hint ?? `Calls before ${at} replay; from here the new model answers live.`, label: 'Model', ok: 'Fork' };
  } else if (a.key === 'e') {
    copy = { ...base, title: 'Repeat the replay and compare', text: a.hint ?? p.label, label: 'Attempts', initial: p.initial ?? '5', ok: 'Run' };
  } else if (a.key === 'p') {
    copy = { ...base, title: `Pack ${ctx.id}`, text: 'A folder to commit as a golden or send to someone: run.json, calls.jsonl and one file per blob. Redaction rules apply to the copy; the store is never changed.', label: 'Folder', ok: 'Pack' };
  } else if (a.key === 'r') {
    copy = { ...base, title: ctx.capture ? 'Replay a capture' : 'Replay', text: p.label, ok: 'Replay' };
  } else {
    copy = { ...base, title: menuLabel(a), text: a.hint ?? p.label };
  }
  if (p.choices?.length) copy.choices = p.choices;
  // An imported pack's question (or a pulled run's) carries its warning: it is asked as it is.
  if (PACK_WARNING.test(p.label)) {
    copy.label = p.label;
    if (copy.text === p.label) copy.text = '';
  }
  return copy;
}
