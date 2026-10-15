import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import { ApiError, type Client, type JobView, type LiveRun, type Meta, type RunListItem } from './api.js';
import { backoffSeconds, isUnreachable } from './backoff.js';
import { useLatest } from './hooks.js';
import { jobTitle, lastLine } from './jobs.js';
import type { PaletteGroup } from './palette.js';
import { previewState } from './router.js';

/**
 * The state every screen shares: the client, the server's meta and run list, the connection, the
 * layers on top of the page (menus, dialogs, panels), toasts and the jobs the dashboard started.
 */

export type Conn = 'ok' | 'offline' | 'expired';

/** An entry a screen adds to the palette (This run, and later Fixes, Tests, Projects). */
export interface PaletteCommand {
  group: PaletteGroup;
  label: string;
  hint: string;
  mono?: boolean;
  run: () => void;
}

export interface WatchedJob {
  job: JobView;
  lines: string[];
  open: boolean;
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
  /** Goes up whenever runs or calls may have changed: an open run reloads on it. */
  tick: number;
  live: LiveRun[];
  refresh: () => void;
  /** Why actions cannot run here, shown on the disabled control; null when they can. */
  actionsOff: string | null;
  /** Whether the server runs a job kind (`meta.jobKinds`); a server that lists none runs none of them. */
  hasKind: (kind: string) => boolean;
  /** Runs `fn`, or says why it cannot while the server is unreachable. */
  guard: (fn: () => void) => void;
  toast: (text: string) => void;
  toastText: { id: number; text: string } | null;
  /** Shows a started job in the drawer and follows it to the end. */
  watchJob: (p: Promise<JobView>) => void;
  jobs: WatchedJob[];
  closeJob: (id: string) => void;
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

const AppContext = createContext<AppState | null>(null);

export function useApp(): AppState {
  const app = useContext(AppContext);
  if (!app) throw new Error('useApp outside AppProvider');
  return app;
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
  const [conn, setConn] = useState<Conn>(preview === 'expired' ? 'expired' : 'ok');
  const [attempt, setAttempt] = useState(0);
  const [retryIn, setRetryIn] = useState(backoffSeconds(0));
  const [retrying, setRetrying] = useState(false);
  const [tick, setTick] = useState(0);
  const [live, setLive] = useState<LiveRun[]>([]);
  const [toastText, setToastText] = useState<{ id: number; text: string } | null>(null);
  const [jobs, setJobs] = useState<WatchedJob[]>([]);
  const [sideOpen, setSideOpen] = useState(false);
  const [palette, setPalette] = useState(false);
  const [help, setHelp] = useState(false);
  const [runCommands, setRunCommands] = useState<PaletteCommand[]>([]);
  const cursor = useRef<string | null>(null);
  const connRef = useLatest(conn);
  const previewOffline = useRef(preview === 'offline');

  const toast = useCallback((text: string) => setToastText({ id: Date.now() + Math.random(), text }), []);

  const fail = useCallback((err: unknown) => {
    if (err instanceof ApiError && err.status === 401) setConn('expired');
    else if (isUnreachable(err)) {
      setConn((c) => {
        if (c === 'ok') {
          setAttempt(0);
          setRetryIn(backoffSeconds(0));
        }
        return c === 'expired' ? c : 'offline';
      });
    }
  }, []);

  const loadRuns = useCallback(async () => {
    const list = await client.runs();
    setRuns(list);
    setLoadedAt(Date.now());
    setSyncedAt(Date.now());
    setTick((n) => n + 1);
  }, [client]);

  // The first load: meta, then the runs. An exported copy loads once and never polls.
  useEffect(() => {
    if (preview === 'expired') return;
    let alive = true;
    client.meta().then(
      (m) => {
        if (!alive) return;
        setMeta(m);
        if (m.live) setLive(m.live);
      },
      (err: unknown) => alive && fail(err),
    );
    loadRuns().then(
      () => {
        if (!alive || !previewOffline.current) return;
        // ?state=offline: show the page as loaded, then the server as gone.
        previewOffline.current = false;
        setAttempt(0);
        setRetryIn(backoffSeconds(0));
        setConn('offline');
      },
      (err: unknown) => alive && fail(err),
    );
    return () => {
      alive = false;
    };
  }, [client, fail, loadRuns, preview]);

  // Live updates: /api/changes when the server has it, else the run list itself (an ETag makes it cheap).
  useEffect(() => {
    if (client.exported || conn !== 'ok') return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const ch = await client.changes(cursor.current);
        if (!alive) return;
        if (ch === null) await loadRuns();
        else {
          const first = cursor.current === null;
          cursor.current = ch.cursor ?? (ch.version !== undefined ? String(ch.version) : null);
          if (ch.live) setLive(ch.live);
          setSyncedAt(Date.now());
          if (first || ch.changed !== false) {
            if (first || ch.runs || ch.calls || ch.changed) await loadRuns();
          }
        }
      } catch (err) {
        if (alive) fail(err);
        return;
      }
      if (alive && connRef.current === 'ok') timer = setTimeout(poll, document.hidden ? POLL_MS * 5 : POLL_MS);
    };
    timer = setTimeout(poll, POLL_MS);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [client, conn, fail, loadRuns, connRef]);

  const reconnect = useCallback(async () => {
    setRetrying(true);
    try {
      const m = await client.meta();
      setMeta(m);
      await loadRuns();
      cursor.current = null;
      setConn('ok');
      setAttempt(0);
      if (/[?&]state=offline/.test(location.search)) history.replaceState(history.state, '', `${location.pathname}${location.hash}`);
      toast(`Reconnected to ${m.address ?? location.host}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setConn('expired');
      else {
        setAttempt((a) => {
          setRetryIn(backoffSeconds(a + 1));
          return a + 1;
        });
      }
    } finally {
      setRetrying(false);
    }
  }, [client, loadRuns, toast]);

  // Offline: count down to the next try, backing off 5, 10, 20, then 30 s.
  useEffect(() => {
    if (conn !== 'offline' || retrying) return;
    const t = setInterval(() => {
      setRetryIn((s) => {
        if (s > 1) return s - 1;
        void reconnect();
        return 0;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [conn, retrying, reconnect, attempt]);

  const retryNow = useCallback(() => void reconnect(), [reconnect]);

  const refresh = useCallback(() => {
    if (client.exported) return;
    loadRuns().catch(fail);
  }, [client, loadRuns, fail]);

  const readOnly = !!meta && !meta.static && (meta.readOnly === true || !meta.actions);
  const actionsOff = client.exported
    ? 'This is an exported copy: nothing runs from here.'
    : readOnly
      ? meta?.readOnly
        ? 'This dashboard is read-only: it was started with --read-only.'
        : 'Actions run the CLI: start the dashboard with shadowlap dashboard.'
      : conn === 'expired'
        ? 'This link has expired.'
        : null;
  const hasKind = useCallback((kind: string) => (meta?.jobKinds ? meta.jobKinds.includes(kind) : false), [meta]);
  const guard = useCallback(
    (fn: () => void) => {
      if (connRef.current === 'offline') toast('Actions are paused until the dashboard server is back.');
      else fn();
    },
    [connRef, toast],
  );

  // ---- jobs: each is followed to its end, whether or not its drawer is open.
  const jobsNow = useLatest(jobs);
  const following = useRef(new Map<string, string[]>());
  const follow = useCallback(
    (first: JobView) => {
      if (following.current.has(first.id)) return;
      following.current.set(first.id, first.lines);
      let count = first.total;
      const step = async () => {
        let next: JobView;
        try {
          next = await client.job(first.id, count);
        } catch {
          if (following.current.has(first.id)) setTimeout(step, 1000);
          return;
        }
        count = next.total;
        const all = [...(following.current.get(first.id) ?? []), ...next.lines].slice(-2000);
        following.current.set(first.id, all);
        setJobs((list) => list.map((w) => (w.job.id === first.id ? { ...w, job: next, lines: all } : w)));
        if (!next.done) {
          setTimeout(step, 300);
          return;
        }
        following.current.delete(first.id);
        refresh();
        // A job whose drawer was closed early still says how it ended.
        const shown = jobsNow.current.find((w) => w.job.id === first.id);
        if (!shown?.open) toast(`${jobTitle(next)} finished${lastLine(all) ? ` · ${lastLine(all)}` : ''}`);
      };
      setTimeout(step, 200);
    },
    [client, refresh, toast, jobsNow],
  );

  const watchJob = useCallback(
    (p: Promise<JobView>) => {
      p.then(
        (job) => {
          setJobs((list) => [...list.filter((w) => w.job.id !== job.id && !(w.job.done && !w.open)).map((w) => ({ ...w, open: false })), { job, lines: job.lines, open: true }].slice(-8));
          follow(job);
        },
        (err: unknown) => {
          fail(err);
          toast(err instanceof Error ? err.message : String(err));
        },
      );
    },
    [follow, fail, toast],
  );

  const closeJob = useCallback((id: string) => setJobs((list) => list.map((w) => (w.job.id === id ? { ...w, open: false } : w)).filter((w) => w.open || !w.job.done)), []);

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
      live,
      refresh,
      actionsOff,
      hasKind,
      guard,
      toast,
      toastText,
      watchJob,
      jobs,
      closeJob,
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
    [client, meta, runs, loadedAt, syncedAt, conn, retryIn, retrying, retryNow, tick, live, refresh, actionsOff, hasKind, guard, toast, toastText, watchJob, jobs, closeJob, registerLayer, closeTopLayer, blockingLayer, sideOpen, palette, help, runCommands],
  );
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
