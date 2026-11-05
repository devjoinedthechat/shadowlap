import { ACTIONS, confirmWords, dialogName } from '../labels.js';
import type { DocKey } from '../docs-links.js';
import type { PromptChoice } from '../types.js';
import { injectsAsUser, isInject, isOverride, isUserAnswer, menuLabel, type ActionLike, type CostWords, type FactWords } from '../actions.js';

/**
 * The words of the dialog each fork asks in: its page's, so the first look doesn't load them. The
 * server builds every command line it runs; these only word what the dialog says and shows.
 */

/**
 * A run from someone else's pack, or a teammate's pulled from the team store, asks first, and says
 * what replaying it runs: that question is the field's label.
 */
const PACK_WARNING = /^This run came from (?:an imported pack|the team store|a program that sent the sidecar its command)/;

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

/** What an action's dialog says, and what it asks. */
export interface DialogCopy {
  title: string;
  lead: string;
  doc?: DocKey;
  /** One line: this run runs someone else's command, or the action acts for real. */
  warn?: { text: string; tone?: 'amber' | 'red' };
  /** The field's label, when it shows one. */
  label?: string;
  /** The field's name for a screen reader, where no label shows. */
  fieldName?: string;
  /** A list that fills the field, which can then be edited or replaced: Plant's Start from. */
  startFrom?: { label: string; choices: readonly PromptChoice[]; note: string };
  initial: string;
  placeholder: string;
  multiline: boolean;
  /** Its confirm: the opener's name without the ellipsis. */
  ok: string;
  /** Rows above the fields. */
  facts?: readonly FactWords[];
  /** A row that says what the field does, under it. */
  factsUnder?: readonly FactWords[];
  /** The command it runs, from the answer so far. */
  command?: (answer: string) => string;
  cost?: CostWords;
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
  /** Where this fork forks, for its Repeat 5 times: null where the run doesn't say. */
  forkAt?: number | null;
}

/** Billed by your provider, until the estimates name a price: then what runs live. */
const billed = (...parts: string[]): CostWords => ({ price: 'Billed by your provider', parts });
const NEXT_CALL_LIVE = 'live from the next model call, writes fenced';

/** What a field's answer reads as in a command: whole, quoted where a shell would split it, … while it is empty. */
function shellValue(answer: string, quote = false): string {
  if (!answer) return quote ? '"…"' : '…';
  return !quote && /^[\w@%+=:,./-]+$/.test(answer) ? answer : `"${answer.replace(/(["\\$`])/g, '\\$1')}"`;
}

/** A fork's `$` row: its flag with the answer in the place of what it asks, as the answer changes. */
function forkLine(id: string, flag: string | undefined, quote = false): ((answer: string) => string) | undefined {
  if (!flag) return undefined;
  return (answer) => {
    const v = shellValue(answer, quote);
    return `shadowlap replay ${id} ${flag.includes('…') ? flag.replace('…', v) : flag.replace(/=\S*/, `=${v}`)}`;
  };
}

/** The last words of an action's question, without the warning before them. */
const afterWarning = (label: string) => label.slice(label.lastIndexOf('. ') + 1).trim();

/** What is left of a fork's words once its call's number and name are known. */
interface ForkContext {
  a: ActionLike;
  ctx: DialogContext;
  /** `#17`, or nothing for the whole run. */
  at: string;
  /** ` lookup_order`, or nothing. */
  named: string;
  p: NonNullable<ActionLike['prompt']>;
}

/**
 * Each action's dialog, by its key: its title, one sentence and the docs page that says how, what it
 * does that the sentence doesn't, its command as the field changes, and what runs live. The server's
 * hint stays on the fork menu's hover and in the terminal UI; these say what the dialog asks.
 */
const FORKS: Record<string, (c: ForkContext) => Partial<DialogCopy>> = {
  i: ({ a, ctx, at, p }) => ({
    title: `Inject instruction at ${at}`,
    lead: `Adds the instruction at ${at}, kept for every later request of the fork.`,
    doc: 'injectInstruction',
    fieldName: 'The instruction',
    placeholder: p.placeholder ?? '',
    multiline: true,
    ok: confirmWords(ACTIONS.injectInstruction.label),
    ...(injectsAsUser(a) ? { factsUnder: [{ label: 'As', value: 'part of the last user turn', ...(a.noSystemMessage ? { quiet: `${a.noSystemMessage} · no system message mid-session` } : {}) }] } : {}),
    ...withCommand(forkLine(ctx.id, a.flag ?? (ctx.callNo === null ? undefined : `--inject ${ctx.callNo}=…`), true)),
    cost: billed(`live from ${at}, writes fenced`),
  }),
  u: ({ ctx, at, p }) => ({
    title: `Override user reply at ${at}`,
    lead: 'The agent gets this reply instead of the recorded one.',
    doc: 'overrideResult',
    fieldName: 'The reply',
    multiline: true,
    initial: p.initial ?? '',
    ok: confirmWords(ACTIONS.overrideUserReply.label),
    command: () => `shadowlap replay ${ctx.id} --override ${ctx.callNo ?? 'n'}=…`,
    cost: billed(NEXT_CALL_LIVE),
  }),
  o: ({ ctx, at, named, p }) => ({
    title: `Override ${at}${named}`,
    lead: 'The agent gets this result instead of the recorded one.',
    doc: 'overrideResult',
    fieldName: 'The result',
    initial: prettyJson(p.initial) ?? (ctx.recorded === undefined ? '' : JSON.stringify(ctx.recorded, null, 2)),
    placeholder: p.placeholder ?? '{"ok": true}',
    multiline: true,
    ok: confirmWords(ACTIONS.overrideResult.label),
    command: () => `shadowlap replay ${ctx.id} --override ${ctx.callNo ?? 'n'}=…`,
    cost: billed(NEXT_CALL_LIVE),
  }),
  t: ({ a, ctx, at, named, p }) => ({
    title: `Fail ${at}${named} with tool error`,
    lead: 'The tool doesn’t run: the agent gets the error instead.',
    doc: 'failWithToolError',
    label: 'Error',
    fieldName: 'The error',
    initial: p.initial ?? 'timeout',
    ok: confirmWords(ACTIONS.failWithToolError.label),
    ...withCommand(forkLine(ctx.id, a.flag)),
    cost: billed(NEXT_CALL_LIVE),
  }),
  x: ({ a, ctx, at, named, p }) => ({
    title: `Plant instruction in ${at}${named}`,
    lead: 'Adds the text after what the tool returned, and runs the agent on from there three times.',
    doc: 'plantInstruction',
    fieldName: 'The instruction to plant',
    multiline: true,
    ok: confirmWords(ACTIONS.plantInstruction.label),
    ...(p.choices?.length ? { startFrom: { label: 'Start from', choices: p.choices, note: 'Or paste your own, or a red-teaming tool’s payload.' }, initial: p.choices[0]!.value } : {}),
    ...withCommand(forkLine(ctx.id, a.flag, true)),
    cost: billed('3 attempts, live from the next model call, writes fenced'),
  }),
  f: ({ a, ctx, at, p }) => ({
    title: `Fail ${at} with HTTP status`,
    lead: `Answers ${at} with this status at every attempt, so the SDK’s retry policy runs and gives up.`,
    doc: 'failWithStatus',
    label: p.choices?.length ? 'Status' : 'Status (429 rate limit, 500 or 529 overloaded, 400 bad request)',
    fieldName: 'The status',
    initial: p.initial ?? '429',
    ok: confirmWords(ACTIONS.failWithStatus.label),
    ...withCommand(forkLine(ctx.id, a.flag)),
    // A model call's failure makes no request for that call, but the calls after it may go live.
    cost: billed(`nothing upstream at ${at}`, 'later model calls live, writes fenced'),
  }),
  m: ({ a, ctx, at }) => ({
    title: `Switch model from ${at}`,
    lead: `The new model answers from ${at} on; the calls before it replay.`,
    doc: 'switchModel',
    label: 'Model',
    ...withCommand(forkLine(ctx.id, a.flag)),
    cost: billed(`live from ${at}, writes fenced`),
  }),
  e: ({ a, ctx }) => ({
    title: ACTIONS.repeat.title,
    lead: typeof ctx.forkAt === 'number' ? `Runs this fork’s change five times from #${ctx.forkAt} and compares the paths they take.` : 'Runs this fork’s change five times and compares the paths they take.',
    doc: 'repeatFork',
    ok: confirmWords(ACTIONS.repeat.label),
    ...(a.command ? { command: () => a.command! } : {}),
    cost: billed(`5 attempts, live from ${typeof ctx.forkAt === 'number' ? `#${ctx.forkAt}` : 'the fork'}, writes fenced`),
  }),
  l: ({ a, ctx, named }) => ({
    lead: `Runs${named} for real at its first call and at every call of it after.`,
    doc: 'forceLive',
    ...(a.warns ? { warn: { text: a.warns, tone: 'red' as const } } : {}),
    ...(a.flag ? { command: () => `shadowlap replay ${ctx.id} ${a.flag!}` } : {}),
    cost: billed('live from its first call, other writes fenced'),
  }),
  p: ({ ctx }) => ({
    title: `Pack ${ctx.id}`,
    lead: 'Packs the run into a folder to commit as a golden or send to someone.',
    doc: 'packs',
    label: 'Folder',
    ok: 'Pack run',
    facts: [{ label: 'Holds', value: 'run.json, calls.jsonl and one file per blob' }],
    command: (dir) => `shadowlap pack ${ctx.id} ${shellValue(dir)}`,
  }),
  r: ({ ctx }) => ({
    title: confirmWords(ACTIONS.replayWithCommand.label),
    lead: 'Replays the capture with the command that runs your agent.',
    doc: 'imports',
    label: 'Command',
    ok: confirmWords(ACTIONS.replayWithCommand.label),
    factsUnder: [{ label: 'On replay', value: 'what the capture doesn’t hold runs live, writes fenced' }],
    command: (cmd) => `shadowlap replay ${ctx.id} -- ${cmd || '…'}`,
    cost: billed('only what runs live'),
  }),
};

function withCommand(command: ((answer: string) => string) | undefined): { command?: (answer: string) => string } {
  return command ? { command } : {};
}

/** The words a server's key doesn't say: a flag or a label names an inject, an override and the rest. */
function forkKey(a: ActionLike): string {
  if (isInject(a)) return 'i';
  if (isUserAnswer(a)) return 'u';
  return isOverride(a) ? 'o' : a.key;
}

/**
 * The words of the dialog an action asks its one thing in, each titled and confirmed with the name
 * its menu item has, as one action is named everywhere. A run from someone else's pack carries its
 * warning at the front of the question: that is the dialog's amber line, and the field keeps its name.
 */
export function dialogCopy(a: ActionLike, ctx: DialogContext): DialogCopy {
  const p = a.prompt ?? { label: '' };
  const at = ctx.callNo === null ? '' : `#${ctx.callNo}`;
  const named = ctx.callName ? ` ${ctx.callName}` : '';
  const opener = dialogName(menuLabel(a, ctx.callName), ctx.callNo);
  const copy: DialogCopy = {
    title: opener,
    lead: a.hint ?? '',
    initial: p.initial ?? '',
    placeholder: p.placeholder ?? '',
    multiline: false,
    ok: opener,
    ...FORKS[forkKey(a)]?.({ a, ctx, at, named, p }),
  };
  if (p.choices?.length && !copy.startFrom) copy.choices = p.choices;
  if (PACK_WARNING.test(p.label)) {
    copy.warn = { text: p.label.slice(0, p.label.lastIndexOf('. ')) };
    // A question with nothing else to name its field keeps its own last words.
    if (!copy.label && !copy.fieldName) copy.label = afterWarning(p.label);
  } else if (!copy.lead) copy.lead = p.label;
  return copy;
}
