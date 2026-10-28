import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError, type ActionItem, type JobView } from '../ui/api.js';
import { useActionRunner } from '../ui/run/actions.js';
import { AppContext, type AppState } from '../ui/state.js';
import { render, type Rendered } from './ui-render.js';

/**
 * A replay of a run from someone else's pack, or a teammate's pulled from the team store, runs
 * their command. The server refuses it until the request says yes, naming the command (409) with
 * the confirm that says yes to it; the page shows that in a dialog of its own, after whatever the
 * action asked first, and only its Run sends the yes: that confirm, tied to the lines it named.
 */

const RUN = '01M5GRX8K406H4KHQ7DEKYWTSZ';
const why = (flags: string) => `01M5GRX8K4 came from an imported pack: this runs the command it was recorded with (node agent.mjs), under shadowlap replay ${RUN}${flags}. Confirm it to run it`;
/** The confirm the server gives with its question, for the command lines it named. */
const confirmOf = (flags: string) => `c0ffee${flags.length.toString(16).padStart(2, '0')}`.padEnd(32, '0');

interface Asked {
  key: string;
  value?: string;
  yes: string | null;
}

function app(asked: Asked[], watched: Array<Promise<JobView>>, refuse: (a: Asked) => Error | null): AppState {
  return {
    exported: false,
    actionsOff: null,
    hasKind: () => true,
    guard: (fn: () => void) => fn(),
    toast: () => undefined,
    watchJob: (p: Promise<JobView>) => void watched.push(p.catch(() => ({ id: 'failed' }) as JobView)),
    registerLayer: () => () => undefined,
    client: {
      action: async (_run: string, key: string, _callNo: number | null, value?: string, yes?: string) => {
        const a: Asked = { key, ...(value !== undefined ? { value } : {}), yes: yes ?? null };
        asked.push(a);
        const err = refuse(a);
        if (err) throw err;
        return { id: 'j1' } as JobView;
      },
    },
  } as unknown as AppState;
}

const replay: ActionItem = { key: 'r', label: 'Replay', opensRun: true, prompt: null, disabled: null, group: null };
const repeat: ActionItem = { key: 'e', label: 'Repeat the replay', opensRun: false, prompt: { label: 'This run came from an imported pack; replaying it runs: node agent.mjs. Attempts:', initial: '5' }, disabled: null, flag: '--repeat …', group: 'run' };

function Runner({ action }: { action: ActionItem }) {
  const runner = useActionRunner(RUN);
  return createElement('div', null, createElement('button', { type: 'button', className: 'go', onClick: () => runner.run({ action, callNo: null }) }, 'Go'), runner.dialog);
}

let r: Rendered | null = null;
afterEach(async () => {
  await r?.unmount();
  r = null;
});

const open = async (action: ActionItem, state: AppState) => {
  r = await render(createElement(AppContext.Provider, { value: state }, createElement('main', { id: 'view', tabIndex: -1 }, createElement(Runner, { action }))));
  return r;
};

/** Until the request says yes with the question's confirm, the server names the command and refuses it. */
const unconfirmed = (flags: string) => (a: Asked) => (a.yes === confirmOf(flags) ? null : new ApiError(409, why(flags), confirmOf(flags)));

describe('an action on someone else’s run', () => {
  it('shows the command the server named, and runs it with the yes only from the dialog’s Run', async () => {
    const asked: Asked[] = [];
    const watched: Array<Promise<JobView>> = [];
    const page = await open(replay, app(asked, watched, unconfirmed('')));
    await page.click(page.one('.go'));
    await page.until('the question', () => page.all('[role="dialog"]').length === 1);
    const dialog = page.one('[role="dialog"]');
    expect(dialog.textContent).toContain('Run a command from an imported pack?');
    expect(dialog.textContent).toContain(`${why('')}.`);
    expect(watched).toEqual([]);
    await page.click(page.byText('.dlg-ok', 'Run'));
    await page.until('the job', () => watched.length === 1);
    expect(asked).toEqual([
      { key: 'r', yes: null },
      { key: 'r', yes: confirmOf('') },
    ]);
    expect(page.all('[role="dialog"]')).toEqual([]);
  });

  it('opens the question on Cancel, so an Enter pressed once too often runs nothing', async () => {
    const asked: Asked[] = [];
    const watched: Array<Promise<JobView>> = [];
    const page = await open(replay, app(asked, watched, unconfirmed('')));
    await page.click(page.one('.go'));
    await page.until('the question', () => page.all('[role="dialog"]').length === 1);
    expect(page.focused()).toBe(page.one('[role="dialog"] .dlg-cancel'));
    // Enter on a button clicks it, in a browser: here, the button the focus is on.
    await page.click(page.focused());
    expect(page.all('[role="dialog"]')).toEqual([]);
    expect(asked).toEqual([{ key: 'r', yes: null }]);
    expect(watched).toEqual([]);
  });

  it('asks every such question with the one dialog that opens on Cancel', () => {
    // Every page that asks this yes (a fix's steps, blame, a run's actions, Edit and fork) asks it
    // with ConsentDialog, never a dialog of its own that would open on its Run.
    const ui = join(import.meta.dirname, '..', 'ui');
    const files = readdirSync(ui, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.tsx'));
    const asking = files.filter((f) => readFileSync(join(ui, f), 'utf8').includes('consentAsked('));
    expect(asking.length).toBeGreaterThanOrEqual(5);
    for (const f of asking) {
      const src = readFileSync(join(ui, f), 'utf8');
      expect({ f, consent: src.includes('<ConsentDialog'), ownTitle: src.includes('consentTitle(') }).toEqual({ f, consent: true, ownTitle: false });
    }
  });

  it('asks its own question first, and the yes after it, sending the answer with both', async () => {
    const asked: Asked[] = [];
    const watched: Array<Promise<JobView>> = [];
    const page = await open(repeat, app(asked, watched, unconfirmed(' --repeat 3')));
    await page.click(page.one('.go'));
    const field = page.one('[role="dialog"] input');
    await page.type(field, '3');
    await page.click(page.byText('.dlg-ok', 'Run'));
    await page.until('the question', () => page.all('[role="dialog"]').some((d) => d.textContent.includes('Run a command from an imported pack?')));
    await page.click(page.byText('.dlg-ok', 'Run'));
    await page.until('the job', () => watched.length === 1);
    expect(asked).toEqual([
      { key: 'e', value: '3', yes: null },
      { key: 'e', value: '3', yes: confirmOf(' --repeat 3') },
    ]);
  });

  it('runs nothing when the question is cancelled, and shows any other refusal as it is', async () => {
    const asked: Asked[] = [];
    const watched: Array<Promise<JobView>> = [];
    const page = await open(replay, app(asked, watched, unconfirmed('')));
    await page.click(page.one('.go'));
    await page.until('the question', () => page.all('[role="dialog"]').length === 1);
    await page.click(page.byText('.dlg-cancel', 'Cancel'));
    expect(page.all('[role="dialog"]')).toEqual([]);
    expect(asked).toHaveLength(1);
    expect(watched).toEqual([]);
    await page.unmount();
    // A refusal that names no one else's command is the job's error, in its drawer.
    const other: Asked[] = [];
    const shown: Array<Promise<JobView>> = [];
    r = null;
    const again = await open(replay, app(other, shown, () => new ApiError(409, '01M5GRX8K4 is still recording: replay it once it has ended')));
    await again.click(again.one('.go'));
    await again.until('the error', () => shown.length === 1);
    expect(again.all('[role="dialog"]')).toEqual([]);
    expect(other).toEqual([{ key: 'r', yes: null }]);
  });
});
