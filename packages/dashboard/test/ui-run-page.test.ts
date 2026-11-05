import { describe, expect, it } from 'vitest';
import { choiceAnswer, consentAsked, consentTitle, dialogCopy, forkMenu, injectsAsUser, isInject, isOverride, isUserAnswer, menuFlag, shortFlag, type ActionLike } from '../ui/actions.js';
import { normalizeActions } from '../ui/normalize.js';
import { keepPlaced, placeMenu, type PopMeasure } from '../ui/place.js';
import { conversationLink } from '../ui/run/calls.js';
import { forkMarkOf, modelLabel, withModelNames } from '../ui/run/model.js';
import type { CallRow } from '../ui/types.js';

// The fork menu and the dialog each action asks in: the server's action list arranged and worded,
// and an instruction said to go in as a user message only when the server's flag says so.

describe('the fork menu from the newer action list', () => {
  const a = (key: string, label: string, extra: Partial<ActionLike> = {}): ActionLike => ({ key, label, opensRun: true, prompt: null, disabled: null, ...extra });
  const grouped = [
    a('r', 'Replay', { flag: 'replay', group: null }),
    a('o', 'Override result…', { flag: '--override 16=…', group: 'call' }),
    a('t', 'Fail with tool error…', { flag: '--fail-at 16=timeout', group: 'call' }),
    a('x', 'Plant instruction…', { flag: '--inject-result 16=… --repeat 3', group: 'call', opensRun: false }),
    a('l', 'Force lookup_order live', { flag: '--live-tool lookup_order', group: 'call' }),
    a('a', 'Run live from here', { flag: '--diverge-at 16', group: 'call' }),
    a('e', 'Repeat 5 times', { flag: '--repeat 5', group: 'run', opensRun: false }),
    a('s', 'Replay with writes stubbed', { flag: '--writes stub', group: 'run' }),
    a('n', 'Add suggested normalizer', { flag: 'normalize add', group: null, opensRun: false }),
    a('p', 'Pack run…', { flag: 'pack', group: null, opensRun: false }),
  ];

  it('keeps the server’s order, and leaves out what has a place of its own', () => {
    const menu = forkMenu(grouped, 'lookup_order');
    // At a call, the option alone, as a menu shows a shortcut; the whole flag is on the line's hover and in its dialog.
    expect(menu.call.map((m) => [m.label, m.flag])).toEqual([
      ['Override result…', '--override'],
      ['Fail with tool error…', '--fail-at'],
      ['Plant instruction…', '--inject-result'],
      ['Force lookup_order live', '--live-tool'],
      ['Run live from here', '--diverge-at'],
    ]);
    expect(menu.run.map((m) => [m.label, m.flag])).toEqual([
      ['Repeat 5 times', '--repeat 5'],
      ['Replay with writes stubbed', '--writes stub'],
    ]);
  });

  it('shows the first option and its value on the right, and the whole command in the dialog', () => {
    expect(shortFlag('--inject 17=… --inject-as user')).toBe('--inject 17=…');
    expect(shortFlag('--writes stub')).toBe('--writes stub');
    expect(shortFlag('replay')).toBe('replay');
    expect(menuFlag(a('i', 'Inject instruction…', { flag: '--inject 17=… --inject-as user' }))).toBe('--inject 17=…');
  });

  it('tells inject, override and a user’s answer apart', () => {
    expect(isInject(a('i', 'Fork: inject an instruction at #17 (--inject)'))).toBe(true);
    expect(isInject(a('x', 'Plant instruction…', { flag: '--inject-result 16=… --repeat 3' }))).toBe(false);
    expect(isOverride(a('o', 'Fork: override the result of #16 lookup_order (--override)'))).toBe(true);
    expect(isOverride(a('u', 'Override user reply…', { flag: '--override 9=…' }))).toBe(false);
    expect(isUserAnswer(a('u', 'Override user reply…'))).toBe(true);
    expect(injectsAsUser(a('i', 'Inject instruction…', { flag: '--inject 17=… --inject-as user' }))).toBe(true);
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
    // Titled and confirmed with its menu name, as one action is named everywhere.
    expect(today).toMatchObject({ title: 'Inject instruction at #17', multiline: true, ok: 'Inject instruction', placeholder: 'Prefer sources from 2026.' });

    const asUser = dialogCopy(a('i', 'Inject instruction…', { flag: '--inject 17=… --inject-as user' }), ctx);
    expect(asUser.text).toMatch(/part of the last user message \(--inject-as user\)/);
    expect(asUser.command).toBe('shadowlap replay 01K5CQ4N7G --inject 17="…" --inject-as user');

    // The server's own words win when it sends them.
    expect(dialogCopy(a('i', 'Inject instruction…', { flag: '--inject 17=… --inject-as user', hint: 'Goes in as part of the user turn.' }), ctx).text).toBe('Goes in as part of the user turn.');
  });

  it('opens an override on the server’s starting value, else the recorded result', () => {
    expect(dialogCopy(a('o', 'Fork: override (--override)'), { ...ctx, callNo: 16, callName: 'lookup_order', recorded: { status: 'held' } })).toMatchObject({ title: 'Override #16 lookup_order', ok: 'Override result', initial: '{\n  "status": "held"\n}', multiline: true });
    // The server's starting value, laid out to edit as the design shows it; a string stays the JSON the CLI reads.
    expect(dialogCopy(a('o', 'Override result…', { flag: '--override 16=…', prompt: { label: 'Result:', initial: '{"status":"held"}' } }), { ...ctx, recorded: { other: 1 } }).initial).toBe('{\n  "status": "held"\n}');
    expect(dialogCopy(a('o', 'Override result…', { flag: '--override 16=…', prompt: { label: 'Result:', initial: '"sent"' } }), { ...ctx, recorded: 'sent' }).initial).toBe('"sent"');
    expect(dialogCopy(a('o', 'Fork: override (--override)'), { ...ctx, callNo: 16, recorded: 'sent' }).initial).toBe('"sent"');
    expect(dialogCopy(a('u', 'Override user reply…', { flag: '--override 9=…', prompt: { label: 'Reply:', initial: 'Yes please' } }), { ...ctx, callNo: 9, recorded: { text: 'Yes please' } })).toMatchObject({ title: 'Override user reply at #9', ok: 'Override user reply', initial: 'Yes please' });
  });

  it('offers a tool error’s kinds and an HTTP failure’s statuses to pick from', () => {
    const choices = [
      { value: 'timeout', label: 'timeout' },
      { value: '500', label: 'HTTP 500' },
    ];
    expect(dialogCopy(a('t', 'Fail with tool error…', { prompt: { label: 'How it fails:', initial: 'timeout', choices } }), { ...ctx, callNo: 16, callName: 'lookup_order' })).toMatchObject({ title: 'Fail #16 lookup_order with tool error', ok: 'Fail with tool error', label: 'Error', initial: 'timeout', choices });
    expect(dialogCopy(a('f', 'Fork: answer #17 with an HTTP failure (--fail-at)', { prompt: { label: 'Status:', initial: '429' } }), ctx)).toMatchObject({ title: 'Fail #17 with HTTP status', ok: 'Fail with HTTP status', label: 'Status (429 rate limit, 500 or 529 overloaded, 400 bad request)', initial: '429' });
  });

  it('asks for the message of "error, with a message", and sends it after the choice’s value', () => {
    // As the newer action list sends a tool error's kinds: one of them needs a few words more.
    const [action] = normalizeActions([
      {
        key: 't',
        label: 'Fail with tool error…',
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
    const choices = action.prompt!.choices!;
    expect(choices).toEqual([
      { value: 'timeout', label: 'timeout' },
      { value: 'error:', label: 'error, with a message', text: 'Message' },
      { value: '500', label: 'HTTP 500' },
    ]);
    expect(dialogCopy(action, { ...ctx, callNo: 16, callName: 'lookup_order' }).choices).toEqual(choices);
    expect(choiceAnswer(choices[1], ' connection reset ')).toBe('error:connection reset');
    // No message is a plain error (the server reads `error:` as `error`), and a choice without a field sends its value.
    expect(choiceAnswer(choices[1], '')).toBe('error:');
    expect(choiceAnswer(choices[0], 'ignored')).toBe('timeout');
  });

  it('asks a pack’s question with its warning, and a capture for the command that starts the agent', () => {
    const warned = dialogCopy(a('i', 'Fork: inject (--inject)', { prompt: { label: 'This run came from an imported pack; replaying it runs: node agent.js. Instruction to append at #17:' } }), ctx);
    expect(warned.label).toBe('This run came from an imported pack; replaying it runs: node agent.js. Instruction to append at #17:');
    const yes = dialogCopy(a('g', 'Fork: my changed prompt from #17 on (--prompt-from)', { prompt: { label: 'This run came from an imported pack; replaying it runs: node agent.js. Type yes to run it:', placeholder: 'yes' } }), ctx);
    expect(yes).toMatchObject({ title: 'Use changed prompt from #17', ok: 'Use changed prompt from #17', text: '', placeholder: 'yes' });
    expect(yes.label).toMatch(/Type yes to run it/);
    expect(dialogCopy(a('r', 'Replay with your command…', { flag: 'replay', prompt: { label: '01K5CQ9C4H came from a capture and has no command. What starts your agent?', placeholder: 'python agent.py' } }), { ...ctx, callNo: null, capture: true })).toMatchObject({ title: 'Replay with your command', ok: 'Replay with your command', text: '01K5CQ9C4H came from a capture and has no command. What starts your agent?' });
  });

  it('names a fork from the call by number, and asks before a fork is repeated five times live', () => {
    const yes = { label: 'This run came from an imported pack; replaying it runs: node agent.js. Type yes to run it:', placeholder: 'yes' };
    expect(dialogCopy(a('a', 'Run live from here', { flag: '--diverge-at 17', prompt: yes }), ctx)).toMatchObject({ title: 'Run live from #17', ok: 'Run live from #17' });
    const hint = 'Makes this replay again from 01K5CQ4N7G five times (--inject 15=Be brief.): the prefix replays free, and each attempt runs live from the fork, so they show whether the path after it holds or was luck.';
    const repeat = dialogCopy(a('e', 'Repeat 5 times', { flag: '--repeat 5', opensRun: false, asksFirst: true, hint }), { ...ctx, callNo: null });
    expect(repeat).toMatchObject({ title: 'Repeat fork 5 times', ok: 'Repeat 5 times', text: hint });
    expect(repeat.label).toBeUndefined();
  });

  it('asks a teammate’s pulled run’s question with its warning too, naming the team store', () => {
    const label = 'This run came from the team store; replaying it runs: node support_chat.mjs. Type yes to run it:';
    expect(dialogCopy(a('r', 'Replay', { prompt: { label, placeholder: 'yes' } }), { ...ctx, callNo: null })).toMatchObject({ title: 'Replay', label, text: '' });
    const inject = 'This run came from the team store; replaying it runs: node support_chat.mjs. Instruction to append at #17:';
    expect(dialogCopy(a('i', 'Fork: inject (--inject)', { prompt: { label: inject } }), ctx).label).toBe(inject);
  });

  it('knows the question a blame or repair job asks before running a command someone else recorded', () => {
    const pack = '01M53N822K came from an imported pack: this runs the command it was recorded with (node triage.mjs). Confirm it to run it';
    const pulled = '01M53N7ZKV came from the team store: this runs the command it was recorded with (node support_chat.mjs). Confirm it to run it';
    const sent = '01M53N7ZKW came from a program that sent the sidecar its command: this runs the command it was recorded with (node agent.mjs). Confirm it to run it';
    const confirm = 'ab'.repeat(16);
    // An error as the page's client throws one (ApiError): its status, its words, and the confirm a question gives.
    const refused = (status: number, why: string, yes?: string) => Object.assign(new Error(why), { status, ...(yes !== undefined ? { confirm: yes } : {}) });
    // The question is a 409 with what says yes to the lines it names, whatever the words.
    expect([pack, pulled, sent].map((why) => consentAsked(refused(409, why, confirm)))).toEqual([pack, pulled, sent].map((why) => ({ why, confirm })));
    expect([consentTitle(pack), consentTitle(pulled), consentTitle(sent)]).toEqual(['Run a command from an imported pack?', 'Run a command from the team store?', 'Run a command a program sent the sidecar?']);
    // Other refusals are not questions: a capture has no command at all, and a 409 that gives no confirm asks nothing.
    expect(consentAsked(refused(409, '01K5CQ9C4H was imported from a capture and has no command to re-run: blame it in a terminal with yours, shadowlap blame 01K5CQ9C4H -- <command>'))).toBeNull();
    expect(consentAsked(refused(409, pack))).toBeNull();
    expect(consentAsked(refused(400, pack, confirm))).toBeNull();
    expect(consentAsked(new Error(pack))).toBeNull();
  });
});

describe('a menu’s place', () => {
  const view = { width: 1440, height: 900 };
  it('hangs under its opener at the edge nearer the window’s middle, or the edge it is told, and stays 12px inside the window', () => {
    // A button on the window's right lines up by its right edge, one on its left by its left edge.
    expect(placeMenu({ left: 1000, right: 1100, top: 66, bottom: 100 }, { width: 330, height: 300 }, view)).toEqual({ top: 106, left: 770, maxHeight: null, up: false });
    expect(placeMenu({ left: 40, right: 120, top: 66, bottom: 100 }, { width: 330, height: 300 }, view)).toEqual({ top: 106, left: 40, maxHeight: null, up: false });
    expect(placeMenu({ left: 1000, right: 1100, top: 66, bottom: 100 }, { width: 330, height: 300 }, view, 'start').left).toBe(1000);
    expect(placeMenu({ left: 40, right: 400, top: 66, bottom: 100 }, { width: 330, height: 300 }, view, 'end').left).toBe(70);
    // Wider than the window's edge allows.
    expect(placeMenu({ left: 1400, right: 1430, top: 66, bottom: 100 }, { width: 330, height: 300 }, view, 'start').left).toBe(1098);
    expect(placeMenu({ left: 10, right: 60, top: 6, bottom: 40 }, { width: 330, height: 300 }, view, 'end').left).toBe(12);
  });

  it('goes over its button when there is more room there, and scrolls in the room there is, never over the button', () => {
    // Under a low row: 6px over the button, its height whole.
    expect(placeMenu({ left: 1180, right: 1204, top: 576, bottom: 600 }, { width: 330, height: 343 }, view)).toEqual({ top: 227, left: 874, maxHeight: null, up: true });
    // It would fit under the button: it stays there, however much room there is over it.
    expect(placeMenu({ left: 1180, right: 1204, top: 576, bottom: 600 }, { width: 330, height: 282 }, view).up).toBe(false);
    // Taller than either side: the side with more room, as tall as that room, its edge 12px from the window's.
    const over = placeMenu({ left: 40, right: 120, top: 500, bottom: 534 }, { width: 340, height: 700 }, view);
    expect(over).toEqual({ top: 12, left: 40, maxHeight: 482, up: true });
    const under = placeMenu({ left: 40, right: 120, top: 300, bottom: 334 }, { width: 340, height: 700 }, view);
    expect(under).toEqual({ top: 340, left: 40, maxHeight: 548, up: false });
    // A low window never squeezes it below three rows.
    expect(placeMenu({ left: 40, right: 120, top: 20, bottom: 54 }, { width: 340, height: 300 }, { width: 800, height: 150 }).maxHeight).toBe(120);
  });

  it('moves over its button when it grows after opening under a low row', () => {
    // The fork icon of call #22 at 1440 × 900: the menu opens on "Loading the call…", 40px tall, and
    // grows to 343px once the call arrives.
    const anchor = { left: 1180, right: 1204, top: 576, bottom: 600 };
    let height = 40;
    const measure = (): PopMeasure => ({ anchor, pop: { width: 330, height }, view });
    const places: Array<{ top: number; left: number }> = [];
    let grew: (() => void) | null = null;
    let stopped = false;
    const stop = keepPlaced(measure, undefined, (p) => places.push(p), (again) => {
      grew = again;
      return () => {
        stopped = true;
      };
    });
    expect(places).toEqual([{ top: 606, left: 874, maxHeight: null, up: false }]);
    height = 343;
    grew!();
    const last = places.at(-1)!;
    expect(last.top + height).toBeLessThanOrEqual(view.height - 12);
    expect(last).toEqual({ top: 227, left: 874, maxHeight: null, up: true });
    // On a phone, 390 × 844, under row #7 near the bottom, were it not a sheet.
    const phone = { width: 390, height: 844 };
    const low = { left: 330, right: 354, top: 764, bottom: 788 };
    height = 40;
    const onPhone: Array<{ top: number; left: number }> = [];
    let phoneGrew: (() => void) | null = null;
    keepPlaced(() => ({ anchor: low, pop: { width: 330, height }, view: phone }), undefined, (p) => onPhone.push(p), (again) => {
      phoneGrew = again;
      return () => {};
    });
    height = 343;
    phoneGrew!();
    expect(onPhone.at(-1)!.top + height).toBeLessThanOrEqual(phone.height - 12);
    stop();
    expect(stopped).toBe(true);
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
