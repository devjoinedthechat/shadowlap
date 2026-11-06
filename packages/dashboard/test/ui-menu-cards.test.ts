import { buildActions, type CallRecord, type RunRecord } from '@shadowlap/engine';
import { createElement, useState } from 'react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { forkRowLine, type ActionLike } from '../ui/actions.js';
import { ForkMenu } from '../ui/run/actions.js';
import { ShareMenu } from '../ui/run/ShareMenu.js';
import { ProjectBlock } from '../ui/shell/ProjectBlock.js';
import { RemoveProjectDialog } from '../ui/shell/RemoveProject.js';
import type { Meta, RunDetail, RunOffers } from '../ui/types.js';
import type { CallDetail } from '../ui/api.js';
import { app, shell, words } from './ui-overlays-page.js';
import { render, type FakeElement, type Rendered } from './ui-render.js';

/**
 * What a menu's rows say on their hover cards: a title without the ellipsis the row has, what the row
 * is for in a line or two, and the command it runs, read as the card reads it. The cards themselves
 * are test/ui-hover-cards.test.ts's.
 */

const RUN = '01M50J6C69T0S34ZZX4WBXJKD1';

let r: Rendered | null = null;
afterEach(async () => {
  await r?.unmount();
  r = null;
});

beforeAll(() => {
  Object.assign(globalThis, { innerWidth: 1440, innerHeight: 900 });
});

/** A row's card, by the words on its row. */
const card = (row: string): { t: string; s?: string; cmd?: string } => {
  const el = r!.all('[role="menu"] button').find((b) => b.querySelector('b')?.textContent === row);
  return JSON.parse((el as FakeElement).getAttribute('data-tip') ?? '{}') as { t: string; s?: string; cmd?: string };
};

const a = (key: string, label: string, over: Partial<ActionLike> = {}): ActionLike => ({ key, label, opensRun: true, prompt: null, disabled: null, ...over });

describe('a fork menu’s rows', () => {
  const run = { run: { runId: RUN, status: 'completed' }, actions: [], source: null } as unknown as RunDetail;
  const call = (actions: ActionLike[]) => ({ call: { callNo: 17, kind: 'api', name: 'POST /v1/messages', effect: null }, actions, result: null, forkTitle: 'At #17 · model call' }) as unknown as CallDetail;
  const props = { anchor: null as unknown as HTMLElement, onPick: () => undefined, onFindCommit: () => undefined, onClose: () => undefined };
  const inApp = { hasKind: () => true, actionsOff: null };
  const offers = (bisect: Partial<NonNullable<RunOffers['bisect']>>) => ({ bisect: { target: { kind: 'run', runId: RUN }, failed: true, good: null, bad: null, revisions: [], fork: false, live: false, unavailable: null, args: null, ...bisect } }) as unknown as RunOffers;

  it('say what each is for in a short line, the dialog keeping the rest, with no ellipsis in the title, and the flag on the command', async () => {
    const inject = a('i', 'Inject instruction…', { flag: '--inject 17=… --inject-as user', group: 'call', hint: 'Not every model takes a system message mid-conversation, so it goes in as part of the last user message (--inject-as user) and stays in place for every later request of the fork. Calls before it replay.' });
    r = await render(shell(inApp, createElement(ForkMenu, { ...props, run, call: call([inject]), offers: null })));
    expect(card('Inject instruction…')).toEqual({ t: 'Inject instruction', s: 'Adds the instruction at this call, kept for every later request of the fork', rows: [], cmd: '$ shadowlap replay 01M50J6C69 --inject 17=… --inject-as user' });
  });

  it('have a short line for every fork the engine offers, and the server’s hint for one this page doesn’t know', () => {
    const record = { runId: RUN, parentRunId: null, mode: 'record', status: 'completed', command: { argv: ['node', 'agent.mjs'], cwd: '/work' }, codeVersion: 'f6c5756', startedAt: 1, endedAt: 2, meta: {} } as unknown as RunRecord;
    const calls: Array<Partial<CallRecord>> = [
      { callNo: 3, kind: 'api', name: 'POST /v1/messages', meta: {}, end: { meta: {} } as never },
      { callNo: 4, kind: 'tool', name: 'lookup_order', effect: 'read', meta: {} },
      { callNo: 5, kind: 'tool', name: 'issue_refund', effect: 'write', meta: {} },
    ];
    for (const c of calls) {
      const actions = buildActions(record, c as CallRecord).filter((x) => x.group === 'call' || x.group === 'run');
      expect(actions.length).toBeGreaterThan(3);
      for (const x of actions) {
        const line = forkRowLine({ key: x.key, ...(x.hint ? { hint: x.hint } : {}) })!;
        expect(line, x.label).not.toBe(x.hint);
        expect(line.length, x.label).toBeLessThanOrEqual(80);
      }
    }
    expect(forkRowLine({ key: 'z', hint: 'A hint of its own' })).toBe('A hint of its own');
    expect(forkRowLine({ key: 'z' })).toBeNull();
  });

  it('give Find breaking commit its command, from the commit the server knows or the one to name, and a golden’s where it searches one', async () => {
    r = await render(shell(inApp, createElement(ForkMenu, { ...props, run, call: call([]), offers: null })));
    expect(card('Find breaking commit…').t).toBe('Find breaking commit');
    expect(card('Find breaking commit…').cmd).toBe('$ shadowlap bisect 01M50J6C69 --good <commit>');
    await r.unmount();
    r = await render(shell(inApp, createElement(ForkMenu, { ...props, run, call: call([]), offers: offers({ good: 'c91d0f4', bad: 'a7b3f10' }) })));
    expect(card('Find breaking commit…').cmd).toBe('$ shadowlap bisect 01M50J6C69 --good c91d0f4 --bad a7b3f10');
    await r.unmount();
    r = await render(shell(inApp, createElement(ForkMenu, { ...props, run, call: call([]), offers: offers({ target: { kind: 'golden', golden: 'goldens/refund' } as never, failed: false }) })));
    expect(card('Find commit that changed it…').cmd).toBe('$ shadowlap bisect goldens/refund --good <commit>');
  });

  it('give a capture’s Replay its command, which takes yours', async () => {
    const replay = a('r', 'Replay with your command…', { flag: 'replay', group: 'call' });
    r = await render(shell(inApp, createElement(ForkMenu, { ...props, run: { ...run, source: 'har' } as unknown as RunDetail, call: call([replay]), offers: null })));
    expect(card('Replay with your command…')).toMatchObject({ t: 'Replay with your command', cmd: '$ shadowlap replay 01M50J6C69 -- <your command>' });
  });
});

describe('the Share menu’s rows', () => {
  const run = { run: { runId: RUN, status: 'completed' }, actions: [], provenance: null, parent: null } as unknown as RunDetail;
  const team = { store: 'northwind-agent-runs/support-agent', state: 'only-here' } as NonNullable<RunOffers['team']>;
  const offers = { team, copies: { total: 1, pathless: 1, formats: [] } } as unknown as RunOffers;

  it('say each copy’s real command, and which bucket a share link goes to, in a clause of its own', async () => {
    r = await render(shell({ client: {} as never, hasKind: () => true, actionsOff: null, toast: () => undefined, guard: (fn: () => void) => (fn(), true), watchJob: () => undefined, meta: null }, createElement(ShareMenu, { anchor: null as unknown as HTMLElement, run, offers, onClose: () => undefined, onAction: () => undefined })));
    expect(card('Share link')).toMatchObject({ s: 'A redacted report in your bucket, northwind-agent-runs/support-agent; the link expires in 7 days', cmd: '$ shadowlap share 01M50J6C69 --lineage' });
    expect(card('Pack…').cmd).toBe('$ shadowlap pack 01M50J6C69 .shadowlap/exports/01m50j6c69');
    expect(card('HTML report').cmd).toBe('$ shadowlap export html 01M50J6C69 .shadowlap/exports/shadowlap-01m50j6c69.html --lineage');
    expect(card('HAR file').cmd).toBe('$ shadowlap export har 01M50J6C69 .shadowlap/exports/01m50j6c69.har');
  });

  it('head the menu with the run’s id, end on a kept result’s Security report, and say the way to the rules and what a run still recording waits for', async () => {
    const app = { client: {} as never, hasKind: () => true, actionsOff: null, toast: () => undefined, guard: (fn: () => void) => (fn(), true), watchJob: () => undefined, meta: null };
    const kept = { ...offers, security: { resultId: 'inj-1', mode: 'plant' } } as RunOffers;
    r = await render(shell(app, createElement(ShareMenu, { anchor: null as unknown as HTMLElement, run, offers: kept, onClose: () => undefined, onAction: () => undefined })));
    expect(r.one('.pop').getAttribute('aria-label')).toBe('Share 01M50J6C69');
    const last = r.all('.pop [role="menuitem"] b').at(-1)!;
    expect(last.textContent).toBe('Security report');
    expect(card('Security report')).toEqual({ t: 'Security report', s: 'The kept test’s report: the matrix and each proof', rows: [] });
    expect(r.all('.pop [role="menuitem"]').find((b) => b.textContent?.startsWith('Security report'))!.textContent).toBe('Security report');
    expect(r.one('.pnote a.more.nw').textContent).toBe('Redaction settings →');
    await r.unmount();
    const live = { ...run, run: { ...run.run, status: 'running' } } as RunDetail;
    r = await render(shell(app, createElement(ShareMenu, { anchor: null as unknown as HTMLElement, run: live, offers, onClose: () => undefined, onAction: () => undefined })));
    expect(card('HAR file')).toMatchObject({ s: 'Waits until the recording ends: a copy now would be cut off', cmd: '$ shadowlap export har 01M50J6C69 .shadowlap/exports/01m50j6c69.har' });
  });
});

describe('the project switcher’s rows', () => {
  const item = (over: Record<string, unknown>) => ({ id: 'support-agent', name: 'support-agent', path: '~/support-agent', initial: 'S', runs: 3, current: true, settingUp: false, missing: false, unreadable: false, detail: '3 runs', removable: true, removeLabel: 'Remove support-agent from the dashboard', ...over });
  const list = { current: item({}), heading: 'Projects on this machine', items: [item({}), item({ id: 'research', name: 'research', path: '~/research', current: false, settingUp: true, detail: 'setting up' })], add: { label: 'Add project…', hint: 'A folder with your agent’s code', href: '#/new' }, note: 'Each project keeps its own store.', notice: null, warnings: [] };
  const meta = { project: { id: 'support-agent', name: 'support-agent', path: '/work/support-agent' } } as unknown as Meta;

  it('say the folder, that one is still being set up, and no ellipsis on Add project', async () => {
    r = await render(shell({ client: { projects: { list: async () => list } } as never, guard: (fn: () => void) => (fn(), true), toast: () => undefined, reload: async () => undefined }, createElement(ProjectBlock, { key: 'block', meta })));
    await r.click(r.one('button.proj'));
    await r.until('the list', () => r!.all('.prow').length === 2);
    expect(card('support-agent').s).toBe('~/support-agent');
    expect(card('research').s).toBe('~/research · setting up');
    expect(card('Add project…')).toMatchObject({ t: 'Add project', s: 'A folder with your agent’s code' });
  });
});

describe('Remove project', () => {
  const view = { title: 'Remove support-agent from the dashboard?', project: { id: 'support-agent', name: 'support-agent', path: '~/support-agent', initial: 'S', summary: '3 runs' }, onDisk: [], keep: { text: 'The dashboard stops listing it.', note: 'Adding the folder again brings it all back.', button: { label: 'Remove', style: 'plain' }, crossedOut: null, done: 'Removed' }, deleteZone: null, canRemove: true, why: null };

  it('starts on Cancel, its button calm as it is: a second Enter never removes the project', async () => {
    function Opened() {
      const [open, setOpen] = useState(true);
      return open ? createElement(RemoveProjectDialog, { id: 'support-agent', onClose: () => setOpen(false) }) : null;
    }
    r = await render(shell({ ...app(), client: { projects: { removal: async () => view } } as never, guard: (fn: () => void) => (fn(), true), actionsOff: null }, createElement(Opened, { key: 'remove' })));
    await r.until('the dialog', () => r!.all('.dialog').length === 1);
    expect(r.one('.dlg-ok').className).not.toMatch(/lime|danger|solid/);
    expect(words(r.focused())).toBe('button Cancel');
  });
});
