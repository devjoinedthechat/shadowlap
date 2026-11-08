import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { tabbables } from './overlays/focus-back.js';
import { stripScroll } from './place.js';

/** An error that says what was read is gone: the server answered 404 (api.ts `ApiError`). */
const gone = (err: unknown): boolean => typeof err === 'object' && err !== null && (err as { status?: unknown }).status === 404;

/** The latest value, for callbacks that must not re-subscribe when it changes. */
export function useLatest<T>(value: T): { readonly current: T } {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

export interface Loaded<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  reload: () => void;
}

/**
 * Loads `load()` whenever `key` changes, and again whenever `refresh` changes, keeping what it had
 * while it reloads, and when the reload fails, unless it failed because what it read is gone (a 404:
 * a run deleted while its page is open), which drops it. A different key starts empty. `load`
 * returning null skips the request.
 */
export function useLoad<T>(load: () => Promise<T> | null, key: string, refresh: unknown = 0): Loaded<T> {
  const [state, setState] = useState<{ key: string; data: T | null; error: Error | null; loading: boolean }>({ key, data: null, error: null, loading: true });
  const loadRef = useLatest(load);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  useEffect(() => {
    let alive = true;
    const p = loadRef.current();
    if (!p) {
      setState((s) => (s.key === key && s.data === null && !s.error && !s.loading ? s : { key, data: null, error: null, loading: false }));
      return;
    }
    // A reload keeps what it had; a new key starts empty.
    setState((s) => (s.key === key ? s : { key, data: null, error: null, loading: true }));
    p.then(
      // An unchanged answer (a 304 hands back the same object) changes nothing, so nothing redraws.
      (data) => alive && setState((s) => (s.key === key && s.data === data && !s.error && !s.loading ? s : { key, data, error: null, loading: false })),
      (err: unknown) => alive && setState((s) => ({ key, data: s.key === key && !gone(err) ? s.data : null, error: err instanceof Error ? err : new Error(String(err)), loading: false })),
    );
    return () => {
      alive = false;
    };
  }, [key, refresh, tick, loadRef]);
  const fresh = state.key === key;
  return { data: fresh ? state.data : null, error: fresh ? state.error : null, loading: fresh ? state.loading : true, reload };
}

/** Calls `fn` every `ms` while mounted; null pauses it. */
export function useInterval(fn: () => void, ms: number | null): void {
  const ref = useLatest(fn);
  useEffect(() => {
    if (ms === null) return;
    const t = setInterval(() => ref.current(), ms);
    return () => clearInterval(t);
  }, [ms, ref]);
}

/** Whether a media query matches, following changes. */
export function useMedia(query: string): boolean {
  const [on, setOn] = useState(() => (typeof matchMedia === 'function' ? matchMedia(query).matches : false));
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const m = matchMedia(query);
    const change = () => setOn(m.matches);
    change();
    m.addEventListener('change', change);
    return () => m.removeEventListener('change', change);
  }, [query]);
  return on;
}

/**
 * A pane that scrolls and holds no control of its own takes the focus, so the keyboard can scroll it
 * too (a dialog's body, the shortcuts on a phone, a results matrix's band, which scrolls sideways:
 * `axis` 'x'), and only while it scrolls: one that fits is no stop. Measured after every render and
 * as the window or the pane changes size.
 */
export function useScrollStop(ref: RefObject<HTMLElement | null>, axis: 'x' | 'y' = 'y'): void {
  const set = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const scrolls = axis === 'x' ? el.scrollWidth > el.clientWidth + 1 : el.scrollHeight > el.clientHeight + 1;
    if (scrolls && !tabbables(el).length) el.tabIndex = 0;
    else if (el.getAttribute('tabindex') === '0') el.removeAttribute('tabindex');
  }, [ref, axis]);
  useLayoutEffect(set);
  useEffect(() => {
    if (!ref.current || typeof ResizeObserver !== 'function') return;
    const sized = new ResizeObserver(set);
    sized.observe(ref.current);
    return () => sized.disconnect();
  }, [ref, set]);
}

/** A per-browser convenience kept in localStorage; it works without storage, for this page only. */
export function useStored<T extends string>(key: string, initial: T, valid: (v: string) => v is T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const v = localStorage.getItem(key);
      return v !== null && valid(v) ? v : initial;
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (v: T) => {
      setValue(v);
      try {
        localStorage.setItem(key, v);
      } catch {
        // storage unavailable: the choice lasts for this page
      }
    },
    [key],
  );
  return [value, set];
}

/** The time, ticking every `ms`, for words like "synced just now". */
export function useNow(ms = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useInterval(() => setNow(Date.now()), ms);
  return now;
}

/**
 * A ref for a strip of tabs that scrolls sideways on a narrow screen (Settings' tabs, a run's views):
 * it shows its active tab (`aria-current="page"` or `aria-selected="true"`) when it mounts and
 * whenever `shown` (the tab shown) changes, by scrolling the strip alone, never the page.
 */
export function useActiveTabInView<E extends HTMLElement>(shown: unknown): RefObject<E | null> {
  const ref = useRef<E>(null);
  useLayoutEffect(() => {
    const strip = ref.current;
    const tab = strip?.querySelector<HTMLElement>('[aria-current="page"], [aria-selected="true"]');
    if (!strip || !tab) return;
    const s = strip.getBoundingClientRect();
    const t = tab.getBoundingClientRect();
    const to = stripScroll({ scrollLeft: strip.scrollLeft, width: strip.clientWidth }, { left: t.left - s.left + strip.scrollLeft, width: t.width });
    if (to !== null) strip.scrollLeft = to;
  }, [shown]);
  return ref;
}
