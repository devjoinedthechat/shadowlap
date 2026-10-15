import { useCallback, useEffect, useRef, useState } from 'react';

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
 * while it reloads. A different key starts empty. `load` returning null skips the request.
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
      setState({ key, data: null, error: null, loading: false });
      return;
    }
    setState((s) => (s.key === key ? { ...s, loading: true } : { key, data: null, error: null, loading: true }));
    p.then(
      (data) => alive && setState({ key, data, error: null, loading: false }),
      (err: unknown) => alive && setState((s) => ({ key, data: s.key === key ? s.data : null, error: err instanceof Error ? err : new Error(String(err)), loading: false })),
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
