import { commandIsImported, hasRecordedCommand, type CallRecord, type RunRecord } from '@shadowlap/engine';

/**
 * The actions palette: everything the CLI can do from the selected call, as a menu. Each action
 * is a CLI invocation; some ask for one line of input first. The TUI never reimplements the
 * engine: it spawns the CLI and shows its output.
 */

export interface Action {
  key: string;
  label: string;
  /** CLI arguments to run, or a prompt whose answer builds them. */
  args?: string[];
  prompt?: { label: string; placeholder?: string; initial?: string; build: (value: string) => string[] };
  /** Whether the action creates a run that should be opened when it finishes. */
  opensRun: boolean;
  disabled?: string;
}

export function buildActions(run: RunRecord, call: CallRecord | undefined): Action[] {
  if (!hasRecordedCommand(run)) return withoutCommand(run, baseActions(run, call));
  return guardImported(run, baseActions(run, call));
}

/** Why a prompt's answer ran nothing: the only answers that do are a command, or a yes. */
export function notRun(run: RunRecord): string {
  return hasRecordedCommand(run) ? 'Not run: type yes to confirm' : 'Not run: give the command that starts your agent';
}

/**
 * Splits a command line typed into a prompt into arguments, honouring single and double quotes. The
 * browser still never sends an argument list: the server rebuilds every action from the run, and a
 * command typed here only ever becomes what follows `--`.
 */
export function splitCommand(line: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: string | null = null;
  let started = false;
  for (const ch of line.trim()) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) {
        out.push(current);
        current = '';
        started = false;
      }
    } else {
      current += ch;
      started = true;
    }
  }
  if (started) out.push(current);
  return out;
}

/** True when an action's CLI invocation is a replay, whether it runs directly or after a prompt. */
function replays(a: Action): boolean {
  return (a.args?.[0] ?? '') === 'replay' || (!!a.prompt && a.prompt.build('1')[0] === 'replay');
}

/**
 * A run built from a capture has no command: it records what was sent, not what sent it. Its
 * replays ask for the agent's command, which becomes what follows `--` — the user's own command, so
 * it runs without the consent an imported pack's command needs.
 *
 * Only actions that need nothing else can ask for it; the prompt is one line. The rest are shown
 * disabled with the way forward, which is also the documented workflow: that first replay records
 * every kind of call, so it has a command of its own and every fork works on it.
 */
function withoutCommand(run: RunRecord, actions: Action[]): Action[] {
  const firstReplay = 'Replay it with your command first';
  return actions.map((a): Action => {
    if (!replays(a)) return a;
    if (!a.args) return { ...a, disabled: firstReplay };
    const args = a.args;
    const { args: _args, ...rest } = a;
    return {
      ...rest,
      label: a.key === 'r' ? 'Replay with your agent\'s command' : `${a.label}, with your agent's command`,
      prompt: {
        label: `${run.runId.slice(0, 10)} came from a capture and has no command. What starts your agent?`,
        placeholder: 'python agent.py',
        build: (v) => {
          const command = splitCommand(v);
          return command[0] ? [...args, '--', ...command] : [];
        },
      },
    };
  });
}

function baseActions(run: RunRecord, call: CallRecord | undefined): Action[] {
  const id = run.runId;
  const actions: Action[] = [
    { key: 'r', label: 'Replay this run (clean if nothing changed)', args: ['replay', id], opensRun: true },
    { key: 's', label: 'Replay with writes stubbed (--writes stub)', args: ['replay', id, '--writes', 'stub'], opensRun: true },
    {
      key: 'e',
      label: 'Replay several times and compare the attempts (--repeat)',
      prompt: {
        label: 'How many attempts? After a code change, they show whether the path past the fork holds or was luck:',
        initial: '5',
        build: (v) => ['replay', id, '--repeat', v.trim()],
      },
      opensRun: false,
    },
  ];
  if (call?.kind === 'tool') {
    actions.push({ key: 'l', label: `Fork: force ${call.name} live (--live-tool)`, args: ['replay', id, '--live-tool', call.name], opensRun: true });
    actions.push({
      key: 'o',
      label: `Fork: override the result of #${call.callNo} ${call.name} (--override)`,
      prompt: { label: `JSON result for #${call.callNo}:`, placeholder: '{"ok": true}', build: (v) => ['replay', id, '--override', `${call.callNo}=${v}`] },
      opensRun: true,
    });
  }
  if (call?.kind === 'api') {
    actions.push({
      key: 'i',
      label: `Fork: inject an instruction at #${call.callNo} (--inject)`,
      prompt: { label: `Instruction to append at #${call.callNo}:`, placeholder: 'Prefer sources from 2026.', build: (v) => ['replay', id, '--inject', `${call.callNo}=${v}`] },
      opensRun: true,
    });
    actions.push({ key: 'g', label: `Fork: my changed prompt from #${call.callNo} on (--prompt-from)`, args: ['replay', id, '--prompt-from', String(call.callNo)], opensRun: true });
    actions.push({
      key: 'f',
      label: `Fork: answer #${call.callNo} with an HTTP failure (--fail-at)`,
      prompt: {
        label: `Status to answer #${call.callNo} with (429 rate limit, 500 or 529 overloaded, 400 bad request):`,
        initial: '429',
        build: (v) => ['replay', id, '--fail-at', `${call.callNo}=${v.trim()}`],
      },
      opensRun: true,
    });
    actions.push({
      key: 'm',
      label: `Fork: switch the model from #${call.callNo} on (--model)`,
      prompt: { label: `Model from #${call.callNo} on:`, placeholder: 'claude-opus-5', build: (v) => ['replay', id, '--model', `${call.callNo}:${v}`] },
      opensRun: true,
    });
  }
  if (call) actions.push({ key: 'a', label: `Fork: diverge at #${call.callNo} (--diverge-at)`, args: ['replay', id, '--diverge-at', String(call.callNo)], opensRun: true });
  const hint = run.divergence?.hints?.find((h) => h.normalizer);
  if (hint?.normalizer) {
    const n = hint.normalizer;
    const args = ['normalize', 'add', '--path', n.path ?? '$', '--replace', n.replace];
    if (n.pattern) args.push('--pattern', n.pattern);
    if (n.kind) args.push('--kind', n.kind);
    if (n.name) args.push('--name', n.name);
    actions.push({ key: 'n', label: `Add the suggested normalizer (${n.pattern ?? 'whole value'} at ${n.path ?? '*'})`, args, opensRun: false });
  }
  actions.push({
    key: 'p',
    label: 'Pack this run to a directory (redaction rules applied)',
    prompt: { label: 'Directory:', initial: `./shadowlap-${id.slice(0, 10).toLowerCase()}`, build: (v) => ['pack', id, v] },
    opensRun: false,
  });
  return actions;
}

/**
 * A run imported from a pack replays a command someone else recorded. Replay actions on it ask for
 * an explicit "yes" (or carry a warning into their prompt) and pass --yes to the CLI only then.
 */
function guardImported(run: RunRecord, actions: Action[]): Action[] {
  if (!commandIsImported(run)) return actions;
  // Only a pack carries someone else's command; a capture has none, and is handled above.
  const cmd = run.command.argv.join(' ');
  const warning = `This run came from an imported pack; replaying it runs: ${cmd}`;
  return actions.map((a): Action => {
    const replays = (a.args?.[0] ?? '') === 'replay' || (a.prompt && a.prompt.build('x')[0] === 'replay');
    if (!replays) return a;
    if (a.args) {
      const args = a.args;
      const { args: _args, ...rest } = a;
      return { ...rest, prompt: { label: `${warning}. Type yes to run it:`, placeholder: 'yes', build: (v) => (/^y(es)?$/i.test(v.trim()) ? [...args, '--yes'] : []) } };
    }
    const prompt = a.prompt!;
    return { ...a, prompt: { ...prompt, label: `${warning}. ${prompt.label}`, build: (v) => [...prompt.build(v), '--yes'] } };
  });
}
