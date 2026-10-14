import { useCallback, useEffect, useRef, useState } from 'react';

/** Loads with `load`, then again every `intervalMs` while mounted (and whenever `key` changes). */
export function usePolling<T>(load: () => Promise<T>, key: string, intervalMs: number | null): { data: T | null; error: Error | null; reload: () => void; updatedAt: number | null } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  useEffect(() => {
    setData(null);
    setError(null);
  }, [key]);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      try {
        const value = await loadRef.current();
        if (!alive) return;
        setData(value);
        setError(null);
        setUpdatedAt(Date.now());
      } catch (err) {
        if (!alive) return;
        setError(err instanceof Error ? err : new Error(String(err)));
      }
      if (alive && intervalMs !== null) timer = setTimeout(run, document.hidden ? intervalMs * 5 : intervalMs);
    };
    void run();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [key, intervalMs, tick]);
  return { data, error, reload, updatedAt };
}

export function useKey(handler: (e: KeyboardEvent) => void, active = true): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!active) return;
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) && e.key !== 'Escape') return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      ref.current(e);
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [active]);
}

const THEME_KEY = 'shadowlap-dashboard-theme';
export type Theme = 'system' | 'light' | 'dark';

export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const t = localStorage.getItem(THEME_KEY);
      return t === 'light' || t === 'dark' ? t : 'system';
    } catch {
      return 'system';
    }
  });
  useEffect(() => {
    if (theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
    try {
      if (theme === 'system') localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, theme);
    } catch {
      // per-browser convenience only
    }
  }, [theme]);
  return [theme, setTheme];
}
