import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore, type MutableRefObject, type ReactNode } from 'react';
import { ApiError, JOB_KINDS, type Client, type JobView, type LiveRun, type Meta, type RunListItem } from './api.js';
import { isUnreachable } from './backoff.js';
import { connStart, connStep, feedCursor, feedMoves, onTick, secondsLeft, withLiveCalls, type Conn } from './connection.js';
import { useLatest } from './hooks.js';
import { afterPollError, endToast, jobStatus, jobTitle } from './jobs.js';
import { endedRecordings, recordingToast } from './live.js';
import type { PaletteGroup } from './palette.js';
import { previewState } from './router.js';
import { errorText, type ToastAction, type ToastKind } from './toast.js';

/**
 * The state every screen shares: the client, the server's meta and run list, the connection, the
 * layers on top of the page (menus, dialogs, panels), toasts and the jobs the dashboard started.
 */

export type { Conn } from './connection.js';

/** An entry a screen adds to the palette (This run, and later Fixes, Tests, Projects). */
export interface PaletteCommand {
  group: PaletteGroup;
  label: string;
  hint: string;
  mono?: boolean;
  /** It starts a job, or opens what starts one: dimmed and paused while the server can't be reached. */
  job?: boolean;
  /** A run's about line, the hint fitted to the rest of the row (decision 10). */
  about?: { text: string; from: string } | null;
  /** Words it matches that don't show (a run's kind, command and labels). */
  match?: string;
  run: () => void;
}

export interface WatchedJob {
  job: JobView;
  lines: string[];
  open: boolean;
  /** The server no longer has it (it was restarted): its end is unknown. */
  lost?: boolean;
}

/** A menu hangs from a button; a dialog dims the page (dialogs, the palette, the shortcuts); a panel sits beside it (the job drawer). */
export type LayerKind = 'menu' | 'dialog' | 'panel';

export interface AppState {
  client: Client;
  exported: boolean;
  meta: Meta | null;
  /** Every run the server lists, attempts included (views leave attempts out). */
  runs: RunListItem[] | null;
  /** When the run list last loaded: what an offline page is showing. */
  loadedAt: number | null;
  /** The last successful exchange with the server. */
  syncedAt: number | null;
  conn: Conn;
  retryIn: number;
  retrying: boolean;
  retryNow: () => void;
  /** Goes up whenever runs or calls may have changed: a page of counts reloads on it. */
  tick: number;
  /**
   * Goes up whenever the run list loads again: a run started, ended or changed. A run's page reloads
   * on it, and while the run records on its own call events (`live`, `runRefresh`), so another run
   * recording asks it for nothing.
   */
  runsTick: number;
  /**
   * How often each other part of the change feed has moved since the page loaded: `jobs` (a job
   * started, ended or reported something) and each table a feature counts (`fixes`, …). A page that
   * shows one reloads on its count, as an open run does on `tick`.
   */
  feeds: Readonly<Record<string, number>>;
  live: LiveRun[];
  refresh: () => void;
  /**
   * Loads the meta and the run list again at once, as after switching projects: what the page had
   * was another project's, so the run list is emptied first and the change feed starts over.
   */
  reload: () => Promise<void>;
  /** Why actions cannot run here, shown on the disabled control; null when they can. */
  actionsOff: string | null;
  /** Whether the server runs a job kind (`meta.jobKinds`); a server that lists none runs none of them. */
  hasKind: (kind: string) => boolean;
  /** Runs `fn`, or says why it cannot while the server is unreachable. */
  guard: (fn: () => void) => void;
  /** A notice at the bottom of the window; `error` for a refusal or a failure, which stays until dismissed (`toast.ts`). */
  toast: (text: string, kind?: ToastKind, action?: ToastAction) => void;
  toastText: { id: number; text: string; kind: ToastKind; action?: ToastAction } | null;
  /** Shows a started job in the drawer and follows it to the end. */
  watchJob: (p: Promise<JobView>) => void;
  jobs: WatchedJob[];
  /**
   * Opens a job's drawer again: one this page follows, or one it doesn't (started in another tab, or
   * before the page loaded), which it then follows to its end.
   */
  openJob: (id: string) => void;
  closeJob: (id: string) => void;
  /** Closes every job's drawer, as leaving a page does; running jobs go on and say when they finish. */
  closeJobs: () => void;
  registerLayer: (kind: LayerKind, close: () => void) => () => void;
  /** Esc: closes a menu, else a dialog, else a panel. False when nothing was open. */
  closeTopLayer: () => boolean;
  /** Whether a menu or a dialog is open: single-key shortcuts wait until it closes. */
  blockingLayer: () => boolean;
  /** The open run's keys (j, k, 1–4, v, n, p, f, /): true when it handled one. */
  runKeys: MutableRefObject<((e: KeyboardEvent) => boolean) | null>;
  sideOpen: boolean;
  setSideOpen: (open: boolean) => void;
  palette: boolean;
  setPalette: (open: boolean) => void;
  help: boolean;
  setHelp: (open: boolean) => void;
  runCommands: PaletteCommand[];
  setRunCommands: (items: PaletteCommand[]) => void;
}

/**
 * The app's state as a store: AppProvider keeps it here, and each component reads it through
 * `useSyncExternalStore`, so a change re-renders the components that read what changed and no
 * other. The status bar's sync time moves on every poll; the pages that never read it don't redraw.
 */
export class AppStore {
  private state: AppState;
  private readonly listeners = new Set<() => void>();

  constructor(state: AppState) {
    this.state = state;
  }

  readonly get = (): AppState => this.state;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  set(next: AppState): void {
    if (next === this.state) return;
    this.state = next;
    for (const listener of [...this.listeners]) listener();
  }
}

const AppStoreContext = createContext<AppStore | null>(null);

/** The app's state as a plain value, for a test that renders a component with an app of its own. AppProvider gives a store instead. */
export const AppContext = createContext<AppState | null>(null);

/** The store a component reads: AppProvider's, or one holding a test's plain value. */
function useAppStore(): AppStore {
  const kept = useContext(AppStoreContext);
  const plain = useContext(AppContext);
  const store = useMemo(() => kept ?? (plain ? new AppStore(plain) : null), [kept, plain]);
  if (!store) throw new Error('useApp outside AppProvider');
  return store;
}

/**
 * One field of the app's state, or what `select` makes of it: the component re-renders when that
 * changes (compared with `Object.is`), and for nothing else. `select` must give the same value for
 * the same state (pick a field; don't build an object).
 */
export function useAppSelector<T>(select: (app: AppState) => T): T {
  const store = useAppStore();
  const read = () => select(store.get());
  // The same on a server's render (a test's static markup) as in the browser.
  return useSyncExternalStore(store.subscribe, read, read);
}

/**
 * The app's state as every component reads it. The component re-renders when a field it read
 * changes, whenever it read it (while rendering, in an effect or a handler), and for no other:
 * the object given notes each field read and reads the store's current value. It is a new object
 * when such a field changed, so an effect or a callback that depends on it runs again then.
 */
export function useApp(): AppState {
  const store = useAppStore();
  const track = useRef<{ store: AppStore; used: Set<PropertyKey>; seen: AppState; version: number } | null>(null);
  if (track.current?.store !== store) track.current = { store, used: new Set(), seen: store.get(), version: 0 };
  const t = track.current;
  const read = () => {
    const now = store.get();
    if (now !== t.seen) {
      for (const k of t.used) {
        if (Object.is(t.seen[k as keyof AppState], now[k as keyof AppState])) continue;
        t.version++;
        break;
      }
      t.seen = now;
    }
    return t.version;
  };
  // The same on a server's render (a test's static markup) as in the browser.
  const version = useSyncExternalStore(store.subscribe, read, read);
  return useMemo(
    () =>
      new Proxy({} as AppState, {
        get: (_target, key) => {
          t.used.add(key);
          return store.get()[key as keyof AppState];
        },
        has: (_target, key) => key in store.get(),
        // Spread whole, it reads every field.
        ownKeys: () => {
          const keys = Reflect.ownKeys(store.get());
          for (const k of keys) t.used.add(k);
          return keys;
        },
        getOwnPropertyDescriptor: (_target, key) => {
          const d = Reflect.getOwnPropertyDescriptor(store.get(), key);
          return d ? { ...d, configurable: true } : undefined;
        },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a new object when a field read changed (`version`): what depends on it runs again
    [store, t, version],
  );
}

/** Registers an open menu, dialog or panel, so Esc closes the topmost one. */
export function useLayer(kind: LayerKind, open: boolean, close: () => void): void {
  const { registerLayer } = useApp();
  const closeRef = useLatest(close);
  useEffect(() => {
    if (!open) return;
    return registerLayer(kind, () => closeRef.current());
  }, [open, kind, registerLayer, closeRef]);
}

const POLL_MS = 2000;

export function AppProvider({ client, children }: { client: Client; children: ReactNode }) {
  const preview = useMemo(() => previewState(), []);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [runs, setRuns] = useState<RunListItem[] | null>(null);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [syncedAt, setSyncedAt] = useState<number | null>(null);
  // The connection: ok, offline (with when the next try is due), or expired. See connection.ts.
  const [cs, dispatch] = useReducer(connStep, preview, connStart);
  const conn = cs.conn;
  const [now, setNow] = useState(() => Date.now());
  const [retrying, setRetrying] = useState(false);
  const [tick, setTick] = useState(0);
  const [runsTick, setRunsTick] = useState(0);
  const [feeds, setFeeds] = useState<Readonly<Record<string, number>>>({});
  const [live, setLive] = useState<LiveRun[]>([]);
  const [toastText, setToastText] = useState<{ id: number; text: string; kind: ToastKind; action?: ToastAction } | null>(null);
  const [jobs, setJobs] = useState<WatchedJob[]>([]);
  const [sideOpen, setSideOpen] = useState(false);
  const [palette, setPalette] = useState(false);
  const [help, setHelp] = useState(false);
  const [runCommands, setRunCommands] = useState<PaletteCommand[]>([]);
  const cursor = useRef<string | null>(null);
  const connRef = useLatest(conn);
  const previewOffline = useRef(preview === 'offline');

  const toast = useCallback((text: string, kind: ToastKind = 'notice', action?: ToastAction) => setToastText({ id: Date.now() + Math.random(), text, kind, ...(action ? { action } : {}) }), []);

  const goOffline = useCallback(() => dispatch({ type: 'unreachable', now: Date.now() }), []);

  const fail = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) dispatch({ type: 'expired' });
      else if (isUnreachable(err)) goOffline();
    },
    [goOffline],
  );

  // A later list means runs moved: `tick` and `runsTick` go up and every open run and panel loads again.
  // The page's first list (`first`) doesn't: what the page loads beside it is as new. A recording
  // that ended since the list before says so, on whatever page is open, once (two lists can arrive
  // out of order), unless a job this page follows made it: its drawer, or its own toast, says how.
  const jobsNow = useLatest(jobs);
  const listed = useRef<RunListItem[] | null>(null);
  const announced = useRef(new Set<string>());
  const loadRuns = useCallback(
    async (o: { first?: boolean } = {}) => {
      const list = await client.runs();
      const quiet = new Set([...announced.current, ...jobsNow.current.flatMap((w) => [...(w.job.runs ?? []), ...(w.job.newRunId ? [w.job.newRunId] : [])])]);
      const ended = endedRecordings(o.first ? null : listed.current, list, quiet);
      for (const e of ended) announced.current.add(e.runId);
      listed.current = list;
      setRuns(list);
      setLoadedAt(Date.now());
      setSyncedAt(Date.now());
      if (!o.first) {
        setTick((n) => n + 1);
        setRunsTick((n) => n + 1);
      }
      const said = recordingToast(ended);
      if (said) toast(said);
    },
    [client, jobsNow, toast],
  );

  // Where the change feed stands now, asked before a load of the run list so the poll after it
  // reloads only for what moved since (`feedCursor`). Without it the first poll would load the runs,
  // and every run, call and panel keyed on them, again, cancelling what was still on its way.
  const cursorNow = useCallback(async () => {
    if (client.exported) return null;
    try {
      return feedCursor(await client.changes(null));
    } catch {
      return null;
    }
  }, [client]);
  // The page's first cursor is asked for before anything the page shows: a layout effect runs before
  // the pages' own loads, which start in effects. A change that lands while they load is then after
  // the cursor, and the first poll reports it.
  const firstCursor = useRef<{ client: Client; at: Promise<string | null> } | null>(null);
  useLayoutEffect(() => {
    if (firstCursor.current?.client !== client) firstCursor.current = { client, at: cursorNow() };
  }, [client, cursorNow]);

  // The first load: meta, then the runs. An exported copy loads once and never polls. The
  // ?state=expired preview loads too, so its card covers a page, as an expiry does.
  useEffect(() => {
    let alive = true;
    client.meta().then(
      (m) => {
        if (!alive) return;
        setMeta(m);
        if (m.live) setLive(m.live);
      },
      (err: unknown) => alive && fail(err),
    );
    void (firstCursor.current?.client === client ? firstCursor.current.at : cursorNow()).then((at) => {
      if (!alive) return;
      // A poll that already ran has a newer cursor.
      if (at !== null && cursor.current === null) cursor.current = at;
      loadRuns({ first: true }).then(
        () => {
          if (!alive || !previewOffline.current) return;
          // ?state=offline: show the page as loaded, then the server as gone.
          previewOffline.current = false;
          goOffline();
        },
        (err: unknown) => alive && fail(err),
      );
    });
    return () => {
      alive = false;
    };
  }, [client, fail, loadRuns, cursorNow, preview, goOffline]);

  // Live updates: /api/changes when the server has it, else the run list itself (an ETag makes it cheap).
  useEffect(() => {
    if (client.exported || conn !== 'ok') return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A poll on its way: a tab shown again waits for it rather than sending a second.
    let busy = false;
    const poll = async () => {
      timer = undefined;
      busy = true;
      try {
        const ch = await client.changes(cursor.current);
        if (!alive) return;
        if (ch === null) await loadRuns();
        else {
          const first = cursor.current === null;
          cursor.current = feedCursor(ch);
          if (ch.live) setLive(ch.live);
          setSyncedAt(Date.now());
          // Runs moved: the list loads again. Only calls: the recordings growing, whose counts the
          // feed carries, so the list takes them as they are and pages of counts reload (`tick`); a
          // run's page reloads on its own calls alone.
          const moves = feedMoves(ch, first);
          if (moves === 'runs') await loadRuns();
          else if (moves === 'calls') {
            const live = ch.live;
            if (live) setRuns((list) => withLiveCalls(list, live) as RunListItem[] | null);
            setTick((n) => n + 1);
          }
          const moved = first ? [] : [...(ch.jobs ? ['jobs'] : []), ...(ch.other ?? [])];
          if (moved.length) setFeeds((f) => Object.fromEntries([...Object.entries(f), ...moved.map((k) => [k, (f[k] ?? 0) + 1] as const)]));
          // The counts in the status bar and the nav are the server's: they move with the runs.
          if (!first && ch.runs) void client.meta().then((m) => alive && setMeta(m), () => undefined);
        }
      } catch (err) {
        if (alive) fail(err);
        return;
      } finally {
        busy = false;
      }
      if (alive && connRef.current === 'ok') timer = setTimeout(() => void poll(), document.hidden ? POLL_MS * 5 : POLL_MS);
    };
    timer = setTimeout(() => void poll(), POLL_MS);
    // A hidden tab asks every 10 s; shown again, it asks at once, so a project switched to in another
    // tab (or a run that ended meanwhile) shows before anything is clicked here.
    const shown = () => {
      if (document.hidden || !alive || busy || connRef.current !== 'ok') return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void poll(), 0);
    };
    document.addEventListener('visibilitychange', shown);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', shown);
    };
  }, [client, conn, fail, loadRuns, connRef]);

  const reconnect = useCallback(async () => {
    setRetrying(true);
    try {
      const m = await client.meta();
      setMeta(m);
      const at = await cursorNow();
      await loadRuns();
      cursor.current = at;
      dispatch({ type: 'reconnected' });
      if (/[?&]state=offline/.test(location.search)) history.replaceState(history.state, '', `${location.pathname}${location.hash}`);
      toast(`Reconnected to ${m.address ?? location.host}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) dispatch({ type: 'expired' });
      else dispatch({ type: 'retry-failed', now: Date.now() });
    } finally {
      setRetrying(false);
    }
  }, [client, loadRuns, cursorNow, toast]);

  // Offline: a clock for the countdown, and the next try when it is due. The ?state=offline preview
  // moves through the same waits without reconnecting: only Retry now does.
  useEffect(() => {
    if (conn !== 'offline') return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [conn]);
  useEffect(() => {
    const next = onTick(cs, now, retrying);
    if (next === 'try') void reconnect();
    else if (next === 'advance') dispatch({ type: 'due', now });
  }, [cs, now, retrying, reconnect]);
  const retryIn = secondsLeft(cs, now);

  const retryNow = useCallback(() => void reconnect(), [reconnect]);

  const refresh = useCallback(() => {
    if (client.exported) return;
    loadRuns().catch(fail);
  }, [client, loadRuns, fail]);

  const reload = useCallback(async () => {
    if (client.exported) return;
    cursor.current = null;
    // Another project's runs: none of them ends here.
    listed.current = null;
    setRuns(null);
    try {
      const m = await client.meta();
      setMeta(m);
      setLive(m.live ?? []);
      const at = await cursorNow();
      await loadRuns();
      cursor.current = at;
    } catch (err) {
      fail(err);
    }
  }, [client, loadRuns, cursorNow, fail]);

  const readOnly = !!meta && !meta.static && (meta.readOnly === true || !meta.actions);
  const actionsOff = client.exported
    ? 'This is an exported copy: nothing runs from here.'
    : readOnly
      ? (meta?.readOnlyReason ??
        (meta?.readOnly ? 'This dashboard is read-only: it was started with --read-only.' : 'Actions run the CLI: start the dashboard with shadowlap dashboard.'))
      : conn === 'expired'
        ? 'This link’s session token isn’t this dashboard’s.'
        : null;
  const hasKind = useCallback((kind: string) => (meta?.jobKinds ? meta.jobKinds.includes(kind) : false), [meta]);
  const guard = useCallback(
    (fn: () => void) => {
      if (connRef.current === 'offline') toast('Actions are paused until the dashboard server is back.');
      else fn();
    },
    [connRef, toast],
  );

  // ---- jobs: each is followed to its end, whether or not its drawer is open. While the server is
  // unreachable the polls wait, and pick up once it is back; a job the server no longer has is lost.
  const following = useRef(new Map<string, string[]>());
  const follow = useCallback(
    (first: JobView) => {
      if (following.current.has(first.id)) return;
      following.current.set(first.id, first.lines);
      let count = first.total;
      let failures = 0;
      const lose = () => {
        following.current.delete(first.id);
        setJobs((list) => list.map((w) => (w.job.id === first.id ? { ...w, lost: true } : w)));
        const shown = jobsNow.current.find((w) => w.job.id === first.id);
        if (!shown?.open) toast(`${jobTitle(first)}: the dashboard server no longer has this job`, 'error');
      };
      const step = async () => {
        if (!following.current.has(first.id)) return;
        if (connRef.current === 'expired') return void following.current.delete(first.id);
        if (connRef.current !== 'ok') return void setTimeout(() => void step(), 1000);
        let next: JobView;
        try {
          next = await client.job(first.id, count);
          failures = 0;
        } catch (err) {
          failures += 1;
          fail(err);
          const what = afterPollError({ status: err instanceof ApiError ? err.status : null, unreachable: isUnreachable(err), failures });
          if (what === 'stop') following.current.delete(first.id);
          else if (what === 'lost') lose();
          else setTimeout(() => void step(), what === 'wait' ? 1000 : Math.min(8000, 500 * 2 ** failures));
          return;
        }
        count = next.total;
        const all = [...(following.current.get(first.id) ?? []), ...next.lines].slice(-2000);
        following.current.set(first.id, all);
        setJobs((list) => list.map((w) => (w.job.id === first.id ? { ...w, job: next, lines: all } : w)));
        if (!next.done) {
          setTimeout(() => void step(), 300);
          return;
        }
        following.current.delete(first.id);
        refresh();
        // An HTML copy and a HAR download as well as being written into the project (decision 5).
        if (next.code === 0 && (next.kind === JOB_KINDS.har || next.kind === JOB_KINDS.exportHtml)) for (const f of next.files ?? []) if (!f.directory) void client.downloadFile(f).catch(() => undefined);
        // A job whose drawer was closed early still says how it ended.
        const shown = jobsNow.current.find((w) => w.job.id === first.id);
        if (!shown?.open) toast(endToast(next, all), jobStatus(next, all).tone === 'err' ? 'error' : 'notice');
      };
      setTimeout(() => void step(), 200);
    },
    [client, refresh, toast, jobsNow, connRef, fail],
  );

  const watchJob = useCallback(
    (p: Promise<JobView>) => {
      p.then(
        (job) => {
          setJobs((list) => [...list.filter((w) => w.job.id !== job.id && !((w.job.done || w.lost) && !w.open)).map((w) => ({ ...w, open: false })), { job, lines: job.lines, open: true }].slice(-8));
          follow(job);
        },
        // The server refused to start it (the repairer changed, a fix moved on, a bad request): its
        // reason stays on screen, as an error.
        (err: unknown) => {
          fail(err);
          toast(errorText(err), 'error');
        },
      );
    },
    [follow, fail, toast],
  );

  const openJob = useCallback(
    (id: string) => {
      if (jobsNow.current.some((w) => w.job.id === id)) setJobs((list) => list.map((w) => ({ ...w, open: w.job.id === id })));
      else watchJob(client.job(id, 0));
    },
    [client, jobsNow, watchJob],
  );
  const closeJob = useCallback((id: string) => setJobs((list) => list.map((w) => (w.job.id === id ? { ...w, open: false } : w)).filter((w) => w.open || (!w.job.done && !w.lost))), []);
  const closeJobs = useCallback(() => setJobs((list) => (list.some((w) => w.open) ? list.filter((w) => !w.job.done && !w.lost).map((w) => ({ ...w, open: false })) : list)), []);

  // ---- layers: menus over dialogs over panels; Esc closes the topmost.
  const layers = useRef<Array<{ id: number; kind: LayerKind; close: () => void }>>([]);
  const registerLayer = useCallback((kind: LayerKind, close: () => void) => {
    const id = Math.random();
    layers.current.push({ id, kind, close });
    return () => {
      layers.current = layers.current.filter((l) => l.id !== id);
    };
  }, []);
  const closeTopLayer = useCallback(() => {
    for (const kind of ['menu', 'dialog', 'panel'] as const) {
      const top = [...layers.current].reverse().find((l) => l.kind === kind);
      if (top) {
        top.close();
        return true;
      }
    }
    return false;
  }, []);

  const blockingLayer = useCallback(() => layers.current.some((l) => l.kind === 'menu' || l.kind === 'dialog'), []);
  const runKeys = useRef<((e: KeyboardEvent) => boolean) | null>(null);

  const value = useMemo<AppState>(
    () => ({
      client,
      exported: client.exported,
      meta,
      runs,
      loadedAt,
      syncedAt,
      conn,
      retryIn,
      retrying,
      retryNow,
      tick,
      runsTick,
      feeds,
      live,
      refresh,
      reload,
      actionsOff,
      hasKind,
      guard,
      toast,
      toastText,
      watchJob,
      jobs,
      openJob,
      closeJob,
      closeJobs,
      registerLayer,
      closeTopLayer,
      blockingLayer,
      runKeys,
      sideOpen,
      setSideOpen,
      palette,
      setPalette,
      help,
      setHelp,
      runCommands,
      setRunCommands,
    }),
    [client, meta, runs, loadedAt, syncedAt, conn, retryIn, retrying, retryNow, tick, runsTick, feeds, live, refresh, reload, actionsOff, hasKind, guard, toast, toastText, watchJob, jobs, openJob, closeJob, closeJobs, registerLayer, closeTopLayer, blockingLayer, sideOpen, palette, help, runCommands],
  );
  // The state goes to the store, which tells the components that read what changed: the page
  // below is given once, so the provider's own re-render redraws none of it.
  const store = useRef<AppStore | null>(null);
  store.current ??= new AppStore(value);
  useLayoutEffect(() => store.current!.set(value), [value]);
  return <AppStoreContext.Provider value={store.current}>{children}</AppStoreContext.Provider>;
}
