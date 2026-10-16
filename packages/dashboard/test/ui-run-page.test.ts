import { describe, expect, it } from 'vitest';
import { choiceAnswer, dialogCopy, forkMenu, injectsAsUser, isInject, isOverride, isUserAnswer, menuFlag, shortFlag, type ActionLike } from '../ui/actions.js';
import { normalizeActions } from '../ui/normalize.js';
import { placePop } from '../ui/place.js';
import { conversationLink } from '../ui/run/calls.js';
import { forkMarkOf, modelLabel, withModelNames } from '../ui/run/model.js';
import type { CallRow } from '../ui/types.js';

// The fork menu and the dialog each action asks in: the server's action list arranged and worded,
// and an instruction said to go in as a user message only when the server's flag says so.

describe('the fork menu from the newer action list', () => {
  const a = (key: string, label: string, extra: Partial<ActionLike> = {}): ActionLike => ({ key, label, opensRun: true, prompt: null, disabled: null, ...extra });
  const grouped = [
    a('r', 'Replay this run (clean if nothing changed)', { flag: 'replay', group: null }),
    a('o', 'Override this tool’s result', { flag: '--override 16=…', group: 'call' }),
    a('t', 'Answer with a tool error', { flag: '--fail-at 16=timeout', group: 'call' }),
    a('x', 'Plant a prompt injection here', { flag: '--inject-result 16=… --repeat 3', group: 'call', opensRun: false }),
    a('l', 'Force lookup_order live', { flag: '--live-tool lookup_order', group: 'call' }),
    a('a', 'Diverge here', { flag: '--diverge-at 16', group: 'call' }),
    a('e', 'Repeat the replay and compare', { flag: '--repeat 5', group: 'run', opensRun: false }),
    a('s', 'Stub the writes', { flag: '--writes stub', group: 'run' }),
    a('n', 'Add the suggested normalizer', { flag: 'normalize add', group: null, opensRun: false }),
    a('p', 'Pack this run to a directory', { flag: 'pack', group: null, opensRun: false }),
  ];

  it('keeps the server’s order, and leaves out what has a place of its own', () => {
    const menu = forkMenu(grouped, 'lookup_order');
    // At a call, the option alone, as a menu shows a shortcut; the whole flag is on the line's hover and in its dialog.
    expect(menu.call.map((m) => [m.label, m.flag])).toEqual([
      ['Override this tool’s result', '--override'],
      ['Answer with a tool error', '--fail-at'],
      ['Plant a prompt injection here', '--inject-result'],
      ['Force lookup_order live', '--live-tool'],
      ['Diverge here', '--diverge-at'],
    ]);
    expect(menu.run.map((m) => [m.label, m.flag])).toEqual([
      ['Repeat the replay and compare', '--repeat 5'],
      ['Stub the writes', '--writes stub'],
    ]);
  });

  it('shows the first option and its value on the right, and the whole command in the dialog', () => {
    expect(shortFlag('--inject 17=… --inject-as user')).toBe('--inject 17=…');
    expect(shortFlag('--writes stub')).toBe('--writes stub');
    expect(shortFlag('replay')).toBe('replay');
    expect(menuFlag(a('i', 'Inject an instruction', { flag: '--inject 17=… --inject-as user' }))).toBe('--inject 17=…');
  });

  it('tells inject, override and a user’s answer apart', () => {
    expect(isInject(a('i', 'Fork: inject an instruction at #17 (--inject)'))).toBe(true);
    expect(isInject(a('x', 'Plant a prompt injection here', { flag: '--inject-result 16=… --repeat 3' }))).toBe(false);
    expect(isOverride(a('o', 'Fork: override the result of #16 lookup_order (--override)'))).toBe(true);
    expect(isOverride(a('u', 'Answer differently as the user…', { flag: '--override 9=…' }))).toBe(false);
    expect(isUserAnswer(a('u', 'Answer differently as the user…'))).toBe(true);
    expect(injectsAsUser(a('i', 'Inject an instruction', { flag: '--inject 17=… --inject-as user' }))).toBe(true);
    expect(injectsAsUser(a('i', 'Fork: inject an instruction at #17 (--inject)'))).toBe(false);
  });
});

describe('an action’s dialog', () => {
  const a = (key: string, label: string, extra: Partial<ActionLike> = {}): ActionLike => ({ key, label, opensRun: true, prompt: { label: 'Answer:' }, disabled: null, ...extra });
  const ctx = { id: '01K5CQ4N7G', callNo: 17 };

  it('says an instruction goes in as a user message only when the server’s flag says so', () => {
    const today = dialogCopy(a('i', 'Fork: inject an instruction at #17 (--inject)', { prompt: { label: 'Instruction to append at #17:', placeholder: 'Prefer sources from 2026.' } }), ctx);
    expect(today.text).not.toMatch(/user message/);
    expect(today.text).toBe('The instruction is added at #17 and stays in place for every later request of the fork. Calls before it replay.');
    expect(today.command).toBe('shadowlap replay 01K5CQ4N7G --inject 17="…"');
    expect(today).toMatchObject({ title: 'Inject an instruction at #17', multiline: true, ok: 'Fork', placeholder: 'Prefer sources from 2026.' });

    const asUser = dialogCopy(a('i', 'Inject an instruction', { flag: '--inject 17=… --inject-as user' }), ctx);
    expect(asUser.text).toMatch(/part of the last user message \(--inject-as user\)/);
    expect(asUser.command).toBe('shadowlap replay 01K5CQ4N7G --inject 17="…" --inject-as user');

    // The server's own words win when it sends them.
    expect(dialogCopy(a('i', 'Inject an instruction', { flag: '--inject 17=… --inject-as user', hint: 'Goes in as part of the user turn.' }), ctx).text).toBe('Goes in as part of the user turn.');
  });

  it('opens an override on the server’s starting value, else the recorded result', () => {
    expect(dialogCopy(a('o', 'Fork: override (--override)'), { ...ctx, callNo: 16, callName: 'lookup_order', recorded: { status: 'held' } })).toMatchObject({ title: 'Override #16 lookup_order', initial: '{\n  "status": "held"\n}', multiline: true });
    // The server's starting value, laid out to edit as the design shows it; a string stays the JSON the CLI reads.
    expect(dialogCopy(a('o', 'Override this tool’s result', { flag: '--override 16=…', prompt: { label: 'Result:', initial: '{"status":"held"}' } }), { ...ctx, recorded: { other: 1 } }).initial).toBe('{\n  "status": "held"\n}');
    expect(dialogCopy(a('o', 'Override this tool’s result', { flag: '--override 16=…', prompt: { label: 'Result:', initial: '"sent"' } }), { ...ctx, recorded: 'sent' }).initial).toBe('"sent"');
    expect(dialogCopy(a('o', 'Fork: override (--override)'), { ...ctx, callNo: 16, recorded: 'sent' }).initial).toBe('"sent"');
    expect(dialogCopy(a('u', 'Answer differently as the user…', { flag: '--override 9=…', prompt: { label: 'Reply:', initial: 'Yes please' } }), { ...ctx, callNo: 9, recorded: { text: 'Yes please' } })).toMatchObject({ title: 'Answer #9 differently', initial: 'Yes please' });
  });

  it('offers a tool error’s kinds and an HTTP failure’s statuses to pick from', () => {
    const choices = [
      { value: 'timeout', label: 'timeout' },
      { value: '500', label: 'HTTP 500' },
    ];
    expect(dialogCopy(a('t', 'Answer with a tool error', { prompt: { label: 'How it fails:', initial: 'timeout', choices } }), { ...ctx, callNo: 16, callName: 'lookup_order' })).toMatchObject({ title: 'Answer #16 lookup_order with an error', label: 'Error', initial: 'timeout', choices });
    expect(dialogCopy(a('f', 'Fork: answer #17 with an HTTP failure (--fail-at)', { prompt: { label: 'Status:', initial: '429' } }), ctx)).toMatchObject({ title: 'Answer #17 with a failure', label: 'Status (429 rate limit, 500 or 529 overloaded, 400 bad request)', initial: '429' });
  });

  it('asks for the message of "error, with a message", and sends it after the choice’s value', () => {
    // As the newer action list sends a tool error's kinds: one of them needs a few words more.
    const [action] = normalizeActions([
      {
        key: 't',
        label: 'Answer with a tool error',
        opensRun: true,
        disabled: null,
        flag: '--fail-at 16=timeout',
        group: 'call',
        prompt: {
          label: 'How #16 lookup_order fails:',
          initial: 'timeout',
          choices: [
            { value: 'timeout', label: 'timeout' },
            { value: 'error:', label: 'error, with a message', text: 'Message' },
            { value: '500', label: 'HTTP 500', text: '  ' },
            { value: 7, label: 'not a choice' },
          ],
        },
      } as never,
    ]);
    const choices = action!.prompt!.choices!;
    expect(choices).toEqual([
      { value: 'timeout', label: 'timeout' },
      { value: 'error:', label: 'error, with a message', text: 'Message' },
      { value: '500', label: 'HTTP 500' },
    ]);
    expect(dialogCopy(action!, { ...ctx, callNo: 16, callName: 'lookup_order' }).choices).toEqual(choices);
    expect(choiceAnswer(choices[1]!, ' connection reset ')).toBe('error:connection reset');
    // No message is a plain error (the server reads `error:` as `error`), and a choice without a field sends its value.
    expect(choiceAnswer(choices[1]!, '')).toBe('error:');
    expect(choiceAnswer(choices[0]!, 'ignored')).toBe('timeout');
  });

  it('asks a pack’s question with its warning, and a capture for the command that starts the agent', () => {
    const warned = dialogCopy(a('i', 'Fork: inject (--inject)', { prompt: { label: 'This run came from an imported pack; replaying it runs: node agent.js. Instruction to append at #17:' } }), ctx);
    expect(warned.label).toBe('This run came from an imported pack; replaying it runs: node agent.js. Instruction to append at #17:');
    const yes = dialogCopy(a('g', 'Fork: my changed prompt from #17 on (--prompt-from)', { prompt: { label: 'This run came from an imported pack; replaying it runs: node agent.js. Type yes to run it:', placeholder: 'yes' } }), ctx);
    expect(yes).toMatchObject({ title: 'Fork with your changed prompt', text: '', placeholder: 'yes' });
    expect(yes.label).toMatch(/Type yes to run it/);
    expect(dialogCopy(a('r', 'Replay with your agent’s command', { prompt: { label: '01K5CQ9C4H came from a capture and has no command. What starts your agent?', placeholder: 'python agent.py' } }), { ...ctx, callNo: null, capture: true })).toMatchObject({ title: 'Replay a capture', ok: 'Replay', text: '01K5CQ9C4H came from a capture and has no command. What starts your agent?' });
  });
});

describe('a menu’s place', () => {
  const view = { width: 1440, height: 900 };
  it('hangs under its opener, right edges lined up, and stays 12px inside the window', () => {
    expect(placePop({ left: 1000, right: 1100, bottom: 100 }, { width: 330, height: 300 }, view)).toEqual({ top: 106, left: 770 });
    expect(placePop({ left: 40, right: 120, bottom: 100 }, { width: 330, height: 300 }, view, 'left')).toEqual({ top: 106, left: 40 });
    // Near the right and bottom edges, and wider than the opener's left side allows.
    expect(placePop({ left: 1400, right: 1430, bottom: 800 }, { width: 330, height: 300 }, view, 'left')).toEqual({ top: 588, left: 1098 });
    expect(placePop({ left: 10, right: 60, bottom: 40 }, { width: 330, height: 300 }, view)).toEqual({ top: 46, left: 12 });
  });
});

describe('a tool call’s own conversation', () => {
  const batch = [{ conversation: 1 }, { conversation: 2 }, { conversation: 3 }, { conversation: 4 }];
  it('leads to the model call that asked for it, and says which conversation in a batch', () => {
    expect(conversationLink({ callNo: 76, kind: 'tool', requestedBy: 74, conversation: 3 }, { fromCallNo: 74, n: 3 }, batch)).toEqual({ callNo: 74, text: 'Asked for by #74 · conversation 3 of 4' });
    expect(conversationLink({ callNo: 5, kind: 'tool', requestedBy: 4, conversation: 1 }, { fromCallNo: 4, n: 1 }, [{ conversation: 1 }])).toEqual({ callNo: 4, text: 'Asked for by #4' });
  });
  it('names the request it feeds or follows when no model call asked for it', () => {
    expect(conversationLink({ callNo: 61, kind: 'clock', conversation: 3 }, { fromCallNo: 63, n: 3 }, batch)).toEqual({ callNo: 63, text: 'Before #63, its conversation’s first model call · conversation 3 of 4' });
    expect(conversationLink({ callNo: 80, kind: 'tool', requestedBy: null, conversation: 3 }, { fromCallNo: 77, n: 3 }, batch)).toEqual({ callNo: 77, text: 'After #77 · conversation 3 of 4' });
  });
  it('says nothing for a model call, or when the server names no conversation', () => {
    expect(conversationLink({ callNo: 74, kind: 'api', conversation: 3 }, { fromCallNo: 74, n: 3 }, batch)).toBeNull();
    expect(conversationLink({ callNo: 9, kind: 'tool' }, null, [])).toBeNull();
  });
});

describe('where the strip and Calls flag FORK', () => {
  // `failed` is a call refused offline: the store keeps it as live, answered with an error.
  const calls = (origins: string[]) => origins.map((origin, i) => (origin === 'failed' ? { callNo: i + 1, origin: 'live', outcome: 'error' } : { callNo: i + 1, origin, outcome: 'ok' })) as unknown as CallRow[];
  const run = (meta: Record<string, unknown> | undefined, divergence: number | null, origins: string[], forkAt?: number | null) =>
    ({ ...(forkAt !== undefined ? { forkAt } : {}), calls: calls(origins), run: { divergence: divergence === null ? null : { callNo: divergence }, meta } }) as unknown as Parameters<typeof forkMarkOf>[0];
  it('flags where a replay forked', () => {
    expect(forkMarkOf(run(undefined, 3, ['replayed', 'replayed', 'live', 'live'], 3))).toBe(3);
    expect(forkMarkOf(run(undefined, 3, ['replayed', 'replayed', 'live']))).toBe(3);
    expect(forkMarkOf(run(undefined, null, ['live']))).toBeNull();
  });
  it('flags nothing where a test replay diverged offline: it failed there, it did not fork', () => {
    const test = { test: { golden: 'goldens/research', session: 's1' } };
    expect(forkMarkOf(run(test, 1, ['failed']))).toBeNull();
    expect(forkMarkOf(run(test, 3, ['replayed', 'replayed', 'failed']))).toBeNull();
    // A golden that may fork goes on live from where it differs: that is a fork.
    expect(forkMarkOf(run(test, 3, ['replayed', 'replayed', 'live', 'live']))).toBe(3);
  });
});

describe('a model’s name on the run page', () => {
  const models = { 'opus-5': 'claude-opus-5', 'gpt-5-mini': 'gpt-5-mini' };
  it('is the id without its date stamp, for a row’s short name and a conversation’s full id alike', () => {
    expect(modelLabel(models, 'opus-5')).toBe('claude-opus-5');
    expect(modelLabel(models, 'claude-opus-5-20261001')).toBe('claude-opus-5');
    expect(modelLabel(models, 'claude-opus-5')).toBe('claude-opus-5');
    expect(modelLabel(models, 'gpt-5-mini')).toBe('gpt-5-mini');
    // A model the run's list doesn't name, and a server that sends no list.
    expect(modelLabel(models, 'claude-sonnet-5-20261001')).toBe('claude-sonnet-5');
    expect(modelLabel(undefined, 'opus-5')).toBe('opus-5');
    expect(modelLabel(models, null)).toBeNull();
  });
  it('renames each model call’s row once, and leaves the rest as they are', () => {
    const rows = [{ callNo: 1, kind: 'api', model: 'opus-5' }, { callNo: 2, kind: 'tool', model: null }, { callNo: 3, kind: 'api', model: 'gpt-5-mini' }] as unknown as CallRow[];
    const named = withModelNames(rows, models);
    expect(named.map((c) => c.model)).toEqual(['claude-opus-5', null, 'gpt-5-mini']);
    expect(named[1]).toBe(rows[1]);
    expect(named[2]).toBe(rows[2]);
    expect(withModelNames(rows, undefined)).toBe(rows);
  });
});
