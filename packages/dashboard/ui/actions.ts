/**
 * The fork menu, from the action list the server sends for a call: what applies to the call, each
 * with its flag on the right, then what applies to the whole run. The server builds every command
 * line; this only arranges and words the list. No DOM here: the tests import it.
 */

export interface ActionLike {
  key: string;
  label: string;
  opensRun: boolean;
  prompt: { label: string; placeholder?: string; initial?: string } | null;
  disabled: string | null;
  /** The CLI flag it adds, shown on the right ("--fail-at 19=529"). */
  flag?: string;
  /** Whether it acts on the selected call or the whole run. */
  group?: 'call' | 'run';
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

export function menuFlag(a: ActionLike): string {
  if (a.flag) return a.flag;
  const fromLabel = /\(((?:--|bisect)[^)]*)\)\s*$/.exec(a.label)?.[1];
  return fromLabel ?? KNOWN[a.key]?.flag ?? '';
}

export function isRunAction(a: ActionLike): boolean {
  return a.group ? a.group === 'run' : RUN_KEYS.has(a.key);
}

export interface ForkMenu {
  call: MenuItem[];
  run: MenuItem[];
}

/** The fork menu's two groups. */
export function forkMenu(actions: readonly ActionLike[], toolName?: string | null): ForkMenu {
  const item = (a: ActionLike): MenuItem => ({ action: a, label: menuLabel(a, toolName), flag: menuFlag(a) });
  const sorted = [...actions].map((a, i) => ({ a, i })).sort((x, y) => rank(x.a.key) - rank(y.a.key) || x.i - y.i).map((x) => x.a);
  return {
    call: sorted.filter((a) => !isRunAction(a)).map(item),
    run: sorted.filter((a) => isRunAction(a) && !OWN_PLACE.has(a.key)).map(item),
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
  return a.key === 'i' || /--inject\b/.test(a.flag ?? '') || /--inject\b/.test(a.label);
}

/** Whether an action replaces a tool result, so its prompt opens with the recorded one to edit. */
export function isOverride(a: ActionLike): boolean {
  return a.key === 'o' || /^--override\b/.test(a.flag ?? '');
}
