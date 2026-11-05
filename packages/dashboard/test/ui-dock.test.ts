import { act, createElement, useEffect, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionButton } from '../ui/components/ActionButton.js';
import { JobDrawer } from '../ui/components/Drawer.js';
import { chipJob, drawnJob, endedBehind, jobClosed, jobOpened, jobsLeftBehind, jobStarted, type WatchedJob } from '../ui/job-store.js';
import { endChip } from '../ui/jobs.js';
import { closeTopPanel } from '../ui/overlays/slots.js';
import { JobChip } from '../ui/shell/JobChip.js';
import { AppContext, type AppState } from '../ui/state.js';
import type { ToastAction } from '../ui/toast.js';
import type { JobFile, JobView } from '../ui/types.js';
import { render, type Rendered } from './ui-render.js';

/**
 * The job drawer docked across the content's foot, as the shell draws it: what it says as its job runs
 * and ends, its fold, hiding a running job behind the status bar's chip, and the end's toast with its
 * way on. Its list is the job store's own, its transitions the store's.
 */

function job(over: Partial<JobView> = {}): JobView {
  return { id: 'a1', kind: 'action', args: ['replay', 'X'], worktree: null, runId: 'X', opensRun: true, startedAt: 1_000, done: false, stopped: false, code: null, newRunId: null, lines: [], total: 0, ...over };
}

const entry = (j: JobView, over: Partial<WatchedJob> = {}): WatchedJob => ({ job: j, lines: j.lines, open: true, ...over });

describe('the job store', () => {
  it('gives the drawer to a newer job, what still runs going on behind it and what is over going', () => {
    const a = job({ id: 'a' });
    const b = job({ id: 'b', done: true, code: 0 });
    const list = jobStarted([entry(a, { open: false, hidden: true }), entry(b, { open: false })], job({ id: 'c' }));
    expect(list.map((w) => [w.job.id, w.open, !!w.hidden])).toEqual([
      ['a', false, false],
      ['c', true, false],
    ]);
    expect(drawnJob(list)?.job.id).toBe('c');
  });

  it('keeps eight, the newest', () => {
    let list: WatchedJob[] = [];
    for (let i = 0; i < 12; i++) list = jobStarted(list, job({ id: `j${i}` }));
    expect(list.map((w) => w.job.id)).toEqual(['j4', 'j5', 'j6', 'j7', 'j8', 'j9', 'j10', 'j11']);
  });

  it('hides a running job on close, and lets go of one that is over', () => {
    const running = entry(job({ id: 'a' }));
    const hidden = jobClosed([running], 'a');
    expect(hidden.map((w) => [w.open, w.hidden])).toEqual([[false, true]]);
    expect(drawnJob(hidden)?.job.id).toBe('a');
    expect(jobClosed([entry(job({ id: 'a', done: true, code: 0 }))], 'a')).toEqual([]);
    expect(jobClosed([entry(job({ id: 'a' }), { lost: true })], 'a')).toEqual([]);
  });

  it('opens a job on the list, and the drawer is only ever one job’s', () => {
    const list = jobOpened([entry(job({ id: 'a' }), { open: false, hidden: true }), entry(job({ id: 'b' }))], 'a', true);
    expect(list.map((w) => [w.job.id, w.open, !!w.hidden, !!w.focus])).toEqual([
      ['a', true, false, true],
      ['b', false, false, false],
    ]);
  });

  it('closes only a finished drawer on the screen when the page changes', () => {
    const running = [entry(job({ id: 'a' }))];
    expect(jobsLeftBehind(running)).toBe(running);
    const hiddenRunning = [entry(job({ id: 'a' }), { open: false, hidden: true })];
    expect(jobsLeftBehind(hiddenRunning)).toBe(hiddenRunning);
    const hiddenEnded = [entry(job({ id: 'a', done: true, code: 0 }), { open: false, hidden: true })];
    expect(jobsLeftBehind(hiddenEnded)).toBe(hiddenEnded);
    expect(jobsLeftBehind([entry(job({ id: 'a', done: true, code: 0 }))])).toEqual([]);
    expect(jobsLeftBehind([entry(job({ id: 'a', done: true, code: 0 })), entry(job({ id: 'b' }), { open: false })]).map((w) => w.job.id)).toEqual(['b']);
  });
});

describe('the status bar’s chip', () => {
  const fork = job({ id: 'f', title: 'Forking', startedAt: 2 });
  const repair = job({ id: 'r', title: 'Repairing', args: ['repair'], startedAt: 3 });

  it('says what one job off the screen is doing, and opens it', () => {
    expect(chipJob([fork], [])).toEqual({ label: 'Forking · running', name: 'Show job: Forking, running', opens: 'f', running: true, tone: '' });
    expect(chipJob([{ ...fork, stopped: true }], [])).toMatchObject({ label: 'Forking · stopping' });
  });

  it('shows nothing while the only job running is on the screen', () => {
    expect(chipJob([fork], [entry(fork)])).toBeNull();
    expect(chipJob([], [])).toBeNull();
    expect(chipJob([job({ id: 'x', done: true, code: 0 })], [])).toBeNull();
  });

  it('counts several, opening the newest not on the screen', () => {
    expect(chipJob([fork, repair], [])).toMatchObject({ label: '2 jobs running', opens: 'r', running: true, title: 'Repairing, Forking: open the newest one’s drawer' });
    expect(chipJob([fork, repair], [entry(repair)])).toMatchObject({ label: '2 jobs running', opens: 'f' });
    // A job this tab has just started comes after the server's list until it is read again: still the newest.
    expect(chipJob([fork, repair, job({ id: 'n', startedAt: 9 })], [])?.opens).toBe('n');
  });

  it('says how a hidden job ended, in its colour, until it gives way to one running', () => {
    const ended = job({ id: 'e', done: true, code: 0, args: ['replay', 'X'] });
    const hidden = [entry(ended, { open: false, hidden: true, lines: ['✓ Replay clean: 30/30 calls replayed'] })];
    expect(chipJob([], hidden)).toBeNull();
    expect(endChip(endedBehind(hidden)!)).toEqual({ label: 'Replayed · reproduced · exit 0', name: 'Show job: Replayed, reproduced, exit 0', opens: 'e', running: false, tone: 'ok' });
    expect(chipJob([fork], hidden)).toMatchObject({ label: 'Forking · running', opens: 'f' });
    expect(endedBehind([entry(job({ id: 'r' }), { open: false, hidden: true })])).toBeNull();
    expect(endChip(entry(job({ id: 'l', title: 'Forking' }), { open: false, hidden: true, lost: true }))).toMatchObject({ label: 'Forking · lost · the dashboard server no longer has this job', tone: 'err' });
  });
});

describe('the drawer', () => {
  const g = globalThis as Record<string, unknown>;
  let r: Rendered | null = null;
  afterEach(async () => {
    await r?.unmount();
    r = null;
    vi.useRealTimers();
    delete g.location;
  });

  /** The drawer and the chip over the store's own transitions; `set` changes the list as following the job does. */
  function page(first: WatchedJob[], over: Partial<AppState> = {}, lead = false) {
    const on: { set: (fn: (l: WatchedJob[]) => WatchedJob[]) => void; toast: Array<{ text: string; kind?: string; action?: ToastAction }>; dropped: ToastAction[] } = { set: () => undefined, toast: [], dropped: [] };
    function Host() {
      const [jobs, setJobs] = useState(first);
      useEffect(() => {
        on.set = setJobs;
      }, []);
      const value = {
        client: { jobs: async () => [] },
        conn: 'ok',
        exported: false,
        meta: { project: { id: 'p', name: 'p', path: '/p' } },
        runs: [],
        feeds: {},
        jobs,
        actionsOff: null,
        hasKind: () => false,
        guard: (fn: () => void) => fn(),
        toast: (text: string, kind?: string, action?: ToastAction) => on.toast.push({ text, ...(kind ? { kind } : {}), ...(action ? { action } : {}) }),
        dropToast: (a: ToastAction) => on.dropped.push(a),
        closeJob: (id: string) => setJobs((l) => jobClosed(l, id)),
        openJob: (id: string, focus?: boolean) => setJobs((l) => jobOpened(l, id, focus)),
        ...over,
      } as unknown as AppState;
      return createElement(AppContext.Provider, { value }, createElement('main', { id: 'view', tabIndex: -1 }, createElement('button', { className: `mine${lead ? ' btn lime' : ''}`, type: 'button' }, 'A control')), createElement(JobDrawer), createElement('footer', { className: 'status' }, createElement(JobChip)));
    }
    return { Host, on };
  }
  const end = (o: Partial<JobView> = {}, ...lines: string[]) => (l: WatchedJob[]) => l.map((w) => ({ ...w, lines, job: { ...w.job, done: true, code: 0, ...o } }));
  const labels = (d: Rendered) => d.all('.drawer header .ibtn').map((b) => b.getAttribute('aria-label'));
  const body = (d: Rendered) => d.document.body.className;

  it('runs under its -ing title, makes room, and offers Stop and to hide', async () => {
    const { Host } = page([entry(job({ title: 'Forking', args: ['replay', 'X', '--inject', '3=x'] }))]);
    r = await render(createElement(Host));
    const section = r.one('section.drawer');
    expect([section.getAttribute('role'), section.getAttribute('aria-labelledby')]).toEqual(['region', 'jtitle']);
    expect(r.one('#jtitle').textContent).toBe('Forking');
    expect(r.one('.drawer .st2').textContent).toBe('running');
    expect(r.all('.drawer .spin')).toHaveLength(1);
    expect(r.all('.drawer .jfoot button').map((b) => b.textContent)).toEqual(['Stop']);
    expect(labels(r)).toEqual(['Hide while it runs']);
    expect(r.one('.drawer pre').textContent).toContain('starting…');
    expect(body(r)).toContain('docked');
  });

  it('keeps each word of the log whole, its spaces as printed', async () => {
    const line = '  ✓ wrote /a/very/long/path/that/goes/on/and/on/and/on/report.json --out file';
    const { Host } = page([entry(job({ lines: [line], total: 1 }))]);
    r = await render(createElement(Host));
    expect(r.one('#jout').textContent).toContain(`${line}\n`);
    expect(r.all('#jout .tk').map((t) => t.textContent)).toEqual(['✓', 'wrote', '/a/very/long/path/that/goes/on/and/on/and/on/report.json', '--out file']);
    expect(r.all('#jout .tk wbr').length).toBeGreaterThan(5);
  });

  it('ends in the past tense, in the verdict’s colour, and folds to its header line two seconds later', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { Host, on } = page([entry(job())]);
    r = await render(createElement(Host));
    (r.one('button.mine') as unknown as HTMLElement).focus();
    await act(async () => on.set(end({}, '✓ Replay clean: 30/30 calls replayed')));
    expect(r.one('#jtitle').textContent).toBe('Replayed');
    expect(r.one('.drawer .st2').className).toContain('ok');
    expect(r.one('.drawer .st2').textContent).toBe('reproduced · exit 0');
    expect(r.all('.drawer .spin')).toHaveLength(0);
    expect(labels(r)).toEqual(['Hide log', 'Close']);
    expect(r.one('#jlog').getAttribute('aria-expanded')).toBe('true');
    expect(r.one('#jlog').getAttribute('aria-controls')).toBe('jout');
    await act(async () => void vi.advanceTimersByTime(1999));
    expect(r.one('section.drawer').className).not.toContain('folded');
    await act(async () => void vi.advanceTimersByTime(2));
    expect(r.one('section.drawer').className).toContain('folded');
    expect(body(r)).toContain('dockfold');
    expect(labels(r)).toEqual(['Show log', 'Close']);
    expect(r.one('#jlog').getAttribute('aria-expanded')).toBe('false');
    // The log is a button away.
    await r.click(r.one('#jlog'));
    expect(r.one('section.drawer').className).not.toContain('folded');
    expect(body(r)).not.toContain('dockfold');
  });

  it('stays open when the keyboard is in it as the fold comes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { Host, on } = page([entry(job())]);
    r = await render(createElement(Host));
    await act(async () => on.set(end()));
    (r.one('#jout') as unknown as HTMLElement).focus();
    await act(async () => void vi.advanceTimersByTime(5000));
    expect(r.one('section.drawer').className).not.toContain('folded');
  });

  it('gives the focus to its way on, else its log, when the page drawn anew took it, and then stays open', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { Host, on } = page([entry(job())]);
    r = await render(createElement(Host));
    await act(async () => on.set(end()));
    await act(async () => void vi.advanceTimersByTime(61));
    expect(r.focused()).toBe(r.one('#jout'));
    await act(async () => void vi.advanceTimersByTime(3000));
    expect(r.one('section.drawer').className).not.toContain('folded');
    await r.unmount();
    g.location = { hash: '#/tests' };
    const led = page([entry(job())]);
    r = await render(createElement(led.Host));
    await act(async () => led.on.set(end({ links: [{ label: 'Open run', href: '#/run/R' }] })));
    await act(async () => void vi.advanceTimersByTime(61));
    expect(r.focused()).toBe(r.one('.drawer .jfoot a'));
  });

  it('keeps a job’s folders out of a folded drawer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const files = [{ fileId: 'd', name: 'x', path: 'share/x', directory: true }] as unknown as JobFile[];
    const { Host, on } = page([entry(job({ files }))]);
    r = await render(createElement(Host));
    expect(r.all('.jfiles')).toHaveLength(1);
    (r.one('button.mine') as unknown as HTMLElement).focus();
    await act(async () => on.set(end()));
    await act(async () => void vi.advanceTimersByTime(2100));
    expect(r.all('.jfiles')).toHaveLength(0);
  });

  it('hides a running job behind the chip, the focus going with it only if it was in the drawer', async () => {
    const { Host } = page([entry(job({ title: 'Forking' }))]);
    r = await render(createElement(Host));
    await r.click(r.one('#jx'));
    expect(r.one('section.drawer').hasAttribute('hidden')).toBe(true);
    expect(body(r)).not.toContain('docked');
    expect(body(r)).toContain('jobmin');
    const chip = r.one('.status .jobchip');
    expect(chip.textContent).toBe('Forking · running');
    expect(chip.getAttribute('aria-label')).toBe('Show job: Forking, running');
    expect(r.focused()).toBe(chip);
    // Shown again, its drawer takes the focus, on what hides it.
    await r.click(chip);
    expect(r.one('section.drawer').hasAttribute('hidden')).toBe(false);
    expect(r.focused()).toBe(r.one('#jx'));
    expect(r.all('.status .jobchip')).toHaveLength(0);
  });

  it('takes Esc while it shows, and lets it go on once it is hidden', async () => {
    const { Host } = page([entry(job())]);
    r = await render(createElement(Host));
    const mine = r.one('button.mine') as unknown as HTMLElement;
    mine.focus();
    await act(async () => void expect(closeTopPanel()).toBe(true));
    expect(r.one('section.drawer').hasAttribute('hidden')).toBe(true);
    // The focus wasn't in the drawer: it stays.
    expect(r.focused()).toBe(mine);
    await act(async () => void expect(closeTopPanel()).toBe(false));
  });

  it('closes on Esc or Close once it has ended, the focus going back if it was in it', async () => {
    const { Host, on } = page([entry(job())]);
    r = await render(createElement(Host));
    const mine = r.one('button.mine') as unknown as HTMLElement;
    await act(async () => on.set(end()));
    await r.click(r.one('#jx'));
    expect(r.all('section.drawer')).toHaveLength(0);
    expect(body(r)).not.toContain('docked');
    expect(mine).toBeTruthy();
    expect(r.focused()).toBe(r.one('main#view'));
  });

  it('raises a toast with its way on when a hidden job ends, and takes it away when it is shown', async () => {
    const links = [{ label: 'Open fix', href: '#/fixes/fx-1' }, { label: 'refund', href: '#/run/R', secondary: true }];
    const { Host, on } = page([entry(job({ title: 'Blaming', kind: 'blame', args: ['blame', 'X'] }), { open: false, hidden: true })]);
    r = await render(createElement(Host));
    await act(async () => on.set(end({ links, result: { outcome: 'blamed', blamed: { callNo: 5 } } })));
    expect(on.toast).toHaveLength(1);
    expect(on.toast[0]).toMatchObject({ text: 'Blamed · lost at #5 · exit 0', kind: 'notice' });
    expect(on.toast[0].action!.label).toBe('Open fix');
    expect(body(r)).toContain('jobtoast');
    // Its chip says it too, and steps aside on a phone while the toast does.
    await r.until('the chip’s words', () => r!.all('.status .jobchip').length === 1);
    expect(r.one('.status .jobchip').textContent).toBe('Blamed · lost at #5 · exit 0');
    expect(r.one('.status .jobchip').className).toContain('ok');
    const action = on.toast[0].action!;
    await r.click(r.one('.status .jobchip'));
    expect(on.dropped).toEqual([action]);
    await act(async () => action.onGone?.(false));
    expect(body(r)).not.toContain('jobtoast');
    // A finished one shows its log, which is what was asked for.
    expect(r.one('section.drawer').className).not.toContain('folded');
    expect(r.focused()).toBe(r.one('#jx'));
  });

  it('offers to show a hidden job that ends with no way on, and says a failure as an error', async () => {
    const { Host, on } = page([entry(job({ title: 'Exporting HTML report', args: ['export', 'html'] }), { open: false, hidden: true })]);
    r = await render(createElement(Host));
    await act(async () => on.set(end({ code: 2 }, 'shadowlap: no run X')));
    expect(on.toast[0]).toMatchObject({ text: 'Tried exporting HTML report · shadowlap: no run X', kind: 'error' });
    expect(on.toast[0].action!.label).toBe('Show');
    await act(async () => on.toast[0].action!.run());
    expect(r.one('section.drawer').hasAttribute('hidden')).toBe(false);
    expect(r.focused()).toBe(r.one('#jx'));
  });

  it('takes the way on from what the job’s kind adds when it has no link, and a file before nothing', async () => {
    const files = [{ fileId: 'f', name: 'x.html', label: 'HTML' }] as unknown as JobFile[];
    const { Host, on } = page([entry(job({ title: 'Exporting HTML report', args: ['export', 'html'], files: [] }), { open: false, hidden: true })]);
    r = await render(createElement(Host));
    await act(async () => on.set(end({ files })));
    expect(on.toast[0].action!.label).toBe('HTML');
  });

  it('never links to the page on the screen, and reads plain while the page leads with its own lime step', async () => {
    g.location = { hash: '#/tests' };
    const links = [{ label: 'Open Tests', href: '#/tests' }, { label: 'Open run', href: '#/run/R' }];
    const { Host, on } = page([entry(job({ args: ['test'], title: 'Running tests' }))]);
    r = await render(createElement(Host));
    await act(async () => on.set(end({ links })));
    expect(r.all('.drawer .jfoot a').map((a) => [a.textContent, a.className])).toEqual([['Open run', 'btn lime']]);
    await r.unmount();
    // Where the page has its own lime step, the way on reads plain.
    const led = page([entry(job({ args: ['test'], title: 'Running tests' }))], {}, true);
    r = await render(createElement(led.Host));
    await act(async () => led.on.set(end({ links })));
    expect(r.all('.drawer .jfoot a').map((a) => [a.textContent, a.className])).toEqual([['Open run', 'btn']]);
  });

  it('calls the run a job made by what it is, with no id', async () => {
    g.location = { hash: '#/runs' };
    const open = (args: string[]) => page([entry(job({ args, newRunId: '01KNEW', done: true, code: 0 }))]);
    r = await render(createElement(open(['replay', 'X']).Host));
    expect(r.one('.drawer .jfoot a').textContent).toBe('Open replay');
    await r.unmount();
    r = await render(createElement(open(['replay', 'X', '--inject', '3=x']).Host));
    expect(r.one('.drawer .jfoot a').textContent).toBe('Open fork');
    await r.unmount();
    r = await render(createElement(open(['import', 'x.har']).Host));
    expect(r.one('.drawer .jfoot a').textContent).toBe('Open run');
  });

  it('keeps a lost job’s -ing title, with Close and no log’s button, and never folds it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { Host, on } = page([entry(job({ title: 'Forking' }))]);
    r = await render(createElement(Host));
    await act(async () => on.set((l) => l.map((w) => ({ ...w, lost: true }))));
    expect(r.one('#jtitle').textContent).toBe('Forking');
    expect(r.one('.drawer .st2').className).toContain('err');
    expect(labels(r)).toEqual(['Close']);
    expect(r.all('.drawer .spin')).toHaveLength(0);
    expect(r.all('.drawer .jfoot button')).toHaveLength(0);
    await act(async () => void vi.advanceTimersByTime(5000));
    expect(r.one('section.drawer').className).not.toContain('folded');
    await r.click(r.one('#jx'));
    expect(r.all('section.drawer')).toHaveLength(0);
  });

  it('says in the polite status how it starts and how it ends, never its lines', async () => {
    const { Host, on } = page([entry(job({ title: 'Forking', args: ['replay', 'X', '--inject', '1=x'] }))]);
    r = await render(createElement(Host));
    const said = () => r!.one('.drawer .sr[role="status"]').textContent;
    expect(said()).toBe('Forking, running');
    await act(async () => on.set((l) => l.map((w) => ({ ...w, job: { ...w.job, stopped: true } }))));
    expect(said()).toBe('Forking, stopping');
    await act(async () => on.set(end({}, '⑂ Forked at call 1')));
    expect(said()).toBe('Forking, stopped, exit 0');
  });
});

describe('what waits', () => {
  let r: Rendered | null = null;
  afterEach(async () => {
    await r?.unmount();
    r = null;
  });
  const PAUSED = 'Paused until the dashboard server is back';

  /** An `ActionButton` over the app as it stands. */
  async function draw(state: Partial<AppState>, props: Record<string, unknown>, label = 'Run tests') {
    const toasts: unknown[][] = [];
    const value = { conn: 'ok', actionsOff: null, toast: (...a: unknown[]) => toasts.push(a), ...state } as unknown as AppState;
    r = await render(createElement(AppContext.Provider, { value }, createElement(ActionButton, { className: 'btn lime', ...props }, label)));
    return { button: r.one('.btn'), toasts };
  }

  it('reads plain, keeps its place and the focus, and says why on a press when offline', async () => {
    const onClick = vi.fn();
    const { button, toasts } = await draw({ conn: 'offline' }, { onClick, title: 'shadowlap test', command: '$ shadowlap test' });
    expect(button.className).toBe('btn');
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.getAttribute('data-why')).toBe(PAUSED);
    expect(button.hasAttribute('disabled')).toBe(false);
    expect(button.hasAttribute('title')).toBe(false);
    expect(JSON.parse(button.getAttribute('data-tip')!)).toEqual({ t: 'shadowlap test', s: PAUSED, rows: [], cmd: '$ shadowlap test' });
    await r!.click(button);
    expect(onClick).not.toHaveBeenCalled();
    expect(toasts).toEqual([[PAUSED, 'notice', undefined]]);
  });

  it('takes the first reason there is: read-only, then offline, then the page’s', async () => {
    expect((await draw({ conn: 'offline', actionsOff: 'Read-only' }, { why: 'Busy' })).button.getAttribute('data-why')).toBe('Read-only');
    await r!.unmount();
    expect((await draw({ conn: 'offline' }, { why: 'Busy' })).button.getAttribute('data-why')).toBe(PAUSED);
    await r!.unmount();
    expect((await draw({}, { why: 'Busy' })).button.getAttribute('data-why')).toBe('Busy');
  });

  it('runs when nothing waits, and a plain disabled wins over every reason', async () => {
    const onClick = vi.fn();
    const free = await draw({}, { onClick, title: 'shadowlap test' });
    expect(free.button.className).toBe('btn lime');
    expect(free.button.hasAttribute('aria-disabled')).toBe(false);
    expect(free.button.getAttribute('title')).toBe('shadowlap test');
    await r!.click(free.button);
    expect(onClick).toHaveBeenCalledOnce();
    await r!.unmount();
    const off = await draw({ conn: 'offline' }, { disabled: true });
    expect(off.button.hasAttribute('disabled')).toBe(true);
    expect(off.button.hasAttribute('aria-disabled')).toBe(false);
    expect(off.button.className).toBe('btn lime');
  });

  it('is a link while it can run and a button while it waits, and a red confirm loses its red', async () => {
    const free = await draw({}, { href: '#/tests' });
    expect(free.button.tagName).toBe('A');
    await r!.unmount();
    const held = await draw({ conn: 'offline' }, { href: '#/tests', className: 'btn danger' });
    expect(held.button.tagName).toBe('BUTTON');
    expect(held.button.className).toBe('btn');
  });

  it('offers a way out in the toast, and gives it the focus from the keyboard, with its reason in full on the card', async () => {
    const run = vi.fn();
    const { button, toasts } = await draw({}, { why: 'A check stands in the way', whyAct: { label: 'Open Tests', run }, whyTip: 'A check stands in the way of this, because of that.' });
    expect(JSON.parse(button.getAttribute('data-tip')!).s).toBe('A check stands in the way of this, because of that.');
    await r!.click(button);
    expect(toasts[0][0]).toBe('A check stands in the way');
    expect(toasts[0][2]).toMatchObject({ label: 'Open Tests', run });
  });
});
