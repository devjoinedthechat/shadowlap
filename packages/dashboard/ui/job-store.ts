import { ApiError, type JobView } from './api.js';
import { isUnreachable } from './backoff.js';
import type { Conn } from './connection.js';
import { afterPollError, jobTitle, type RunningJob } from './job-title.js';

/**
 * The jobs this page follows, one list that the job's drawer and the status bar's chip both read
 * (through `useApp().jobs`), and that starting a job and following it write. At most one is the
 * drawer's: on the screen (`open`), or hidden behind the chip (`hidden`), its drawer still drawn so
 * its way on is there for the toast its end raises. Any other job runs on behind a newer one, and is
 * counted by the chip. No DOM here: the tests import it.
 */

export interface WatchedJob {
  job: JobView;
  lines: string[];
  /** Its drawer is on the screen. */
  open: boolean;
  /** Its drawer is hidden behind the status bar's chip: it went on running, or has ended since. */
  hidden?: boolean;
  /** The server no longer has it (it was restarted): its end is unknown. */
  lost?: boolean;
  /** Asked for from the chip or a toast's Show: its drawer takes the focus. */
  focus?: boolean;
}

/** Over, one way or the other. */
const finished = (w: WatchedJob): boolean => w.job.done || !!w.lost;

/** The job the drawer draws, if any. */
export function drawnJob(list: readonly WatchedJob[]): WatchedJob | null {
  return [...list].reverse().find((w) => w.open || w.hidden) ?? null;
}

/** A newer job takes the drawer; what was in it and is over goes, and what still runs goes on behind it. */
export function jobStarted(list: readonly WatchedJob[], job: JobView, focus = false): WatchedJob[] {
  const kept = list.filter((w) => w.job.id !== job.id && !(finished(w) && !w.open && !w.hidden)).map((w) => ({ ...w, open: false, hidden: false, focus: false }));
  return [...kept, { job, lines: job.lines, open: true, focus }].slice(-8);
}

/** Opens the drawer of a job on the list. */
export function jobOpened(list: readonly WatchedJob[], id: string, focus = false): WatchedJob[] {
  return list.map((w) => (w.job.id === id ? { ...w, open: true, hidden: false, focus } : { ...w, open: false, hidden: false, focus: false }));
}

/** Esc, the chevron or ×: a job that runs is hidden behind the chip, and one that is over goes. */
export function jobClosed(list: readonly WatchedJob[], id: string): WatchedJob[] {
  return list.filter((w) => w.job.id !== id || !finished(w)).map((w) => (w.job.id === id ? { ...w, open: false, hidden: true, focus: false } : w));
}

/** Leaving a page closes a finished drawer on the screen. A running drawer stays across pages, and so does a hidden job's chip. */
export function jobsLeftBehind(list: WatchedJob[]): WatchedJob[] {
  return list.some((w) => w.open && finished(w)) ? list.filter((w) => !finished(w) || w.hidden) : list;
}

/** What following a job needs of the page. */
export interface JobWatch {
  poll: (id: string, from: number) => Promise<JobView>;
  conn: () => Conn;
  /** A poll failed: the page takes note of what that says about the connection. */
  failed: (err: unknown) => void;
  ended: (job: JobView, lines: readonly string[], watched: WatchedJob | undefined) => void;
  lost: (job: JobView, watched: WatchedJob | undefined) => void;
}

/**
 * The list, and each job on it followed to its end, whatever its drawer does. While the server is
 * unreachable the polls wait, and pick up once it is back; a job the server no longer has is lost.
 */
export class JobStore {
  private list: WatchedJob[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly following = new Map<string, string[]>();

  readonly get = (): WatchedJob[] => this.list;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(next: WatchedJob[]): void {
    if (next === this.list) return;
    this.list = next;
    for (const listener of [...this.listeners]) listener();
  }

  private entry(id: string): WatchedJob | undefined {
    return this.list.find((w) => w.job.id === id);
  }

  /** Shows a started job in the drawer and follows it to the end. */
  started(job: JobView, watch: { readonly current: JobWatch }, focus = false): void {
    this.set(jobStarted(this.list, job, focus));
    this.follow(job, watch);
  }

  /** Opens the drawer of a job on the list; false when it isn't on it. */
  open(id: string, focus = false): boolean {
    if (!this.entry(id)) return false;
    this.set(jobOpened(this.list, id, focus));
    return true;
  }

  close(id: string): void {
    this.set(jobClosed(this.list, id));
  }

  closeFinished(): void {
    this.set(jobsLeftBehind(this.list));
  }

  private follow(first: JobView, watch: { readonly current: JobWatch }): void {
    if (this.following.has(first.id)) return;
    this.following.set(first.id, first.lines);
    let count = first.total;
    let failures = 0;
    const lose = () => {
      this.following.delete(first.id);
      this.set(this.list.map((w) => (w.job.id === first.id ? { ...w, lost: true } : w)));
      watch.current.lost(first, this.entry(first.id));
    };
    const step = async () => {
      if (!this.following.has(first.id)) return;
      const on = watch.current;
      if (on.conn() === 'expired') return void this.following.delete(first.id);
      if (on.conn() !== 'ok') return void setTimeout(() => void step(), 1000);
      let next: JobView;
      try {
        next = await on.poll(first.id, count);
        failures = 0;
      } catch (err) {
        failures += 1;
        on.failed(err);
        const what = afterPollError({ status: err instanceof ApiError ? err.status : null, unreachable: isUnreachable(err), failures });
        if (what === 'stop') this.following.delete(first.id);
        else if (what === 'lost') lose();
        else setTimeout(() => void step(), what === 'wait' ? 1000 : Math.min(8000, 500 * 2 ** failures));
        return;
      }
      count = next.total;
      const all = [...(this.following.get(first.id) ?? []), ...next.lines].slice(-2000);
      this.following.set(first.id, all);
      this.set(this.list.map((w) => (w.job.id === first.id ? { ...w, job: next, lines: all } : w)));
      if (!next.done) {
        setTimeout(() => void step(), 300);
        return;
      }
      this.following.delete(first.id);
      on.ended(next, all, this.entry(first.id));
    };
    setTimeout(() => void step(), 200);
  }
}

/** What the status bar's chip says and opens. */
export interface JobChipView {
  /** `Forking · running`, `Forked · exit 0`, `2 jobs running`. */
  label: string;
  /** Its name for a screen reader: `Show job: Forking, running`. */
  name: string;
  opens: string;
  running: boolean;
  tone: '' | 'ok' | 'warn' | 'err';
  /** Several running: which, on hover. */
  title?: string;
}

/**
 * The status bar's chip while jobs run, from the jobs running in every tab and the ones this page
 * follows. One job running that isn't on the screen: what it does, and a click opens it. Several: how
 * many, opening the newest not already open (the server lists jobs newest first, but one this tab has
 * just started may not be on its list yet, so they go by when they started). Nothing while the only
 * job running has its drawer on the screen. None running, a hidden job that ended takes the chip
 * (`endedBehind`, `endChip`), until it is opened and closed.
 */
export function chipJob(jobs: readonly RunningJob[], watched: readonly WatchedJob[]): JobChipView | null {
  const open = watched.find((w) => w.open)?.job.id;
  const running = jobs.filter((j) => !j.done).sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  const opens = running.find((j) => j.id !== open);
  const titleOf = (j: RunningJob): string => jobTitle({ args: [...(j.args ?? [])], done: false, code: null, ...(j.title ? { title: j.title } : {}) });
  if (opens && running.length > 1) {
    const label = `${running.length} jobs running`;
    return { label, name: `Show job: ${label}`, opens: opens.id, running: true, tone: '', title: `${[...new Set(running.map(titleOf))].join(', ')}: open the newest one’s drawer` };
  }
  if (opens) {
    const [t, how] = [titleOf(opens), opens.stopped ? 'stopping' : 'running'];
    return { label: `${t} · ${how}`, name: `Show job: ${t}, ${how}`, opens: opens.id, running: true, tone: '' };
  }
  return null;
}

/** A hidden job that has ended. */
export function endedBehind(watched: readonly WatchedJob[]): WatchedJob | null {
  return watched.find((w) => w.hidden && finished(w)) ?? null;
}
