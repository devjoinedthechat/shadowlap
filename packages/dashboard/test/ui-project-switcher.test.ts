import { createElement, useState } from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { onProjectsChanged } from '../ui/project-actions.js';
import type { RemovedProject, RestoredProject } from '../ui/projects-api.js';
import { ProjectBlock } from '../ui/shell/ProjectBlock.js';
import { RemoveProjectDialog } from '../ui/shell/RemoveProject.js';
import type { ToastAction } from '../ui/toast.js';
import type { Meta } from '../ui/types.js';
import { app, shell, words } from './ui-overlays-page.js';
import { render, type Rendered } from './ui-render.js';

/**
 * The project switcher's keys and a removal's Undo: → reaches a row's ×, ← comes back, and Delete
 * or Backspace on a row opens the Remove dialog, never for the only project; the toast that says a
 * project was removed offers Undo, which puts it back and has the switcher read its list again.
 */

let r: Rendered | null = null;
afterEach(async () => {
  await r?.unmount();
  r = null;
});

const g = globalThis as unknown as { location: unknown; history: unknown };
const saved = { location: g.location, history: g.history };
beforeAll(() => {
  // The address bar, which a removal sends to the Overview.
  const location = { hash: '#/settings/project', pathname: '/', search: '' };
  Object.assign(globalThis, { innerWidth: 1440, innerHeight: 900, location, history: { state: null, replaceState: (_s: unknown, _t: string, url: string) => (location.hash = url.slice(url.indexOf('#'))) } });
});
afterAll(() => Object.assign(g, saved));

const item = (over: Record<string, unknown>) => ({ id: 'support-agent', name: 'support-agent', path: '~/support-agent', initial: 'S', runs: 3, current: true, settingUp: false, missing: false, unreadable: false, detail: '3 runs', removable: true, removeLabel: 'Remove project support-agent', ...over });
const listOf = (items: Array<ReturnType<typeof item>>) => ({ current: items[0], heading: 'Projects on this machine', items, add: { label: 'Add project…', hint: 'A folder with your agent’s code', href: '#/new' }, note: 'Each project keeps its own store.', notice: null, warnings: [] });
const meta = { project: { id: 'support-agent', name: 'support-agent', path: '/work/support-agent' } } as unknown as Meta;
const view = { title: 'Remove research from the dashboard?', project: { id: 'research', name: 'research', path: '~/research', initial: 'R', summary: 'no runs yet' }, onDisk: [], keep: { text: 'Takes research off the dashboard; nothing on disk changes.', note: null, button: { label: 'Remove project', style: 'plain' }, crossedOut: null, done: 'Removed research · nothing on disk changed' }, deleteZone: null, canRemove: true, why: null };

describe('the project switcher’s keys', () => {
  const open = async (list: ReturnType<typeof listOf>) => {
    const asked: string[] = [];
    const client = { projects: { list: async () => list, removal: async (id: string) => (asked.push(id), view) } };
    r = await render(shell({ ...app(), client: client as never, guard: (fn: () => void) => (fn(), true), toast: () => undefined, reload: async () => undefined, actionsOff: null }, createElement(ProjectBlock, { key: 'block', meta })));
    await r.click(r.one('button.proj'));
    await r.until('the list', () => r!.all('.prow').length === list.items.length);
    await r.press('Home');
    return asked;
  };
  const on = () => r!.focused().getAttribute('data-project');

  it('reach a row’s × with →, come back with ←, and open the Remove dialog with Delete or Backspace on the row', async () => {
    const asked = await open(listOf([item({}), item({ id: 'research', name: 'research', path: '~/research', current: false, detail: 'no runs yet', removeLabel: 'Remove project research' })]));
    await r!.press('ArrowDown');
    expect(on()).toBe('research');
    await r!.press('ArrowRight');
    expect(words(r!.focused())).toBe('button ×');
    expect(r!.focused().getAttribute('aria-label')).toBe('Remove project research');
    await r!.press('ArrowLeft');
    expect(on()).toBe('research');
    await r!.press('Delete');
    await r!.until('the dialog', () => r!.all('.dialog').length === 1);
    expect(asked).toEqual(['research']);
    await r!.press('Escape');
    await r!.until('the dialog gone', () => r!.all('.dialog').length === 0);

    await r!.click(r!.one('button.proj'));
    await r!.until('the list', () => r!.all('.prow').length === 2);
    await r!.press('Home');
    await r!.press('ArrowDown');
    await r!.press('Backspace');
    await r!.until('the dialog again', () => r!.all('.dialog').length === 1);
    expect(asked).toEqual(['research', 'research']);
  });

  it('reach nothing past the only project: no ×, and Delete opens no dialog', async () => {
    const asked = await open(listOf([item({ removable: false, removeLabel: null })]));
    expect(on()).toBe('support-agent');
    await r!.press('ArrowRight');
    expect(on()).toBe('support-agent');
    expect(r!.all('.prow .px')).toEqual([]);
    await r!.press('Delete');
    await r!.press('Backspace');
    expect(r!.all('.dialog')).toEqual([]);
    expect(asked).toEqual([]);
  });
});

describe('Undo after a removal', () => {
  const removeWith = async (answer: Partial<RemovedProject>) => {
    const toasts: Array<{ text: string; kind: string | undefined; action: ToastAction | undefined }> = [];
    const restored: string[] = [];
    let reloads = 0;
    let changed = 0;
    const stop = onProjectsChanged(() => changed++);
    const back: RestoredProject = { project: { id: 'research', name: 'research' }, current: 'support-agent', message: 'research is back on the dashboard' };
    const projects = {
      removal: async () => view,
      remove: async (): Promise<RemovedProject> => ({ removed: 'research', current: 'support-agent', deleted: [], message: 'Removed research · nothing on disk changed', undo: true, ...answer }),
      restore: async (id: string) => (restored.push(id), back),
    };
    function Opened() {
      const [open, setOpen] = useState(true);
      return open ? createElement(RemoveProjectDialog, { id: 'research', onClose: () => setOpen(false) }) : null;
    }
    const toast = (text: string, kind?: string, action?: ToastAction) => void toasts.push({ text, kind, action });
    r = await render(shell({ ...app(), client: { projects } as never, guard: (fn: () => void) => (fn(), true), toast, reload: async () => void reloads++, actionsOff: null }, createElement(Opened, { key: 'remove' })));
    await r.until('the dialog', () => r!.all('.dialog').length === 1);
    await r.click(r.one('.dlg-ok'));
    await r.until('the removal’s toast', () => toasts.length === 1);
    return { toasts, restored, reloads: () => reloads, changed: () => changed, stop };
  };

  it('puts the project back from the toast, says so, and has the switcher read its list again', async () => {
    const w = await removeWith({});
    expect(w.toasts[0]).toMatchObject({ text: 'Removed research · nothing on disk changed', kind: 'notice', action: { label: 'Undo', undo: true } });
    const reloadsBefore = w.reloads();
    w.toasts[0]?.action?.run();
    await r!.until('the Undo’s toast', () => w.toasts.length === 2);
    expect(w.restored).toEqual(['research']);
    expect(w.toasts[1]).toMatchObject({ text: 'research is back on the dashboard' });
    await r!.until('the list read again', () => w.changed() === 1);
    expect(w.reloads()).toBe(reloadsBefore + 1);
    w.stop();
  });

  it('offers none when the server says it can’t put the project back', async () => {
    const w = await removeWith({ message: 'Removed research and deleted its recordings', undo: false });
    expect(w.toasts[0]).toEqual({ text: 'Removed research and deleted its recordings', kind: 'notice', action: undefined });
    w.stop();
  });
});
