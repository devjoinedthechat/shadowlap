import { useEffect, useState, type ComponentType, type JSX, type ReactNode } from 'react';

/**
 * A component whose code waits in a script of its own until it first shows. esbuild splits the
 * bundle at each `import()` (ui-bundles.mjs), so what holds it opens without that code, and the
 * script loads the first time it is drawn, `waiting` in its place meanwhile (nothing unless given).
 * Once the script is in, it draws at once wherever it shows. `preload` loads it ahead: a page warms
 * what it is likely to show next once it has drawn, so that draws at once too.
 *
 * The shell's pages load this way (pages/lazy.tsx), and so does a part of a page heavy enough to wait
 * for a script of its own, such as a run's views but Calls (pages/Run.tsx). A part is declared beside
 * the page that shows it, never in pages/lazy.tsx: an exported copy, one script with the pages it
 * shows (main-copy.tsx), then holds the parts they show and none of the dashboard's other pages.
 * The bundle size test holds each page's and each part's script to a budget of its own
 * (test/ui-bundle-size.test.ts).
 */
export interface OnShow<P> {
  (props: P): JSX.Element;
  /** Loads its script now, ahead of its first showing. */
  preload(): void;
}

export function onShow<P extends object>(load: () => Promise<ComponentType<P>>, waiting: ReactNode = null): OnShow<P> {
  let loaded: ComponentType<P> | null = null;
  let loading: Promise<ComponentType<P> | null> | null = null;
  // One load for every place it shows. One that failed (the dashboard stopped, or was updated since
  // the page opened) leaves `waiting` where it shows, rather than the page blank, and is asked again
  // the next time it shows.
  const fetch = () =>
    (loading ??= load().then(
      (c) => (loaded = c),
      () => ((loading = null), null),
    ));
  function Shown(props: P) {
    const [Loaded, setLoaded] = useState(() => loaded);
    useEffect(() => {
      if (Loaded) return;
      let shown = true;
      void fetch().then((c) => {
        if (shown && c) setLoaded(() => c);
      });
      return () => {
        shown = false;
      };
    }, [Loaded]);
    return Loaded ? <Loaded {...props} /> : <>{waiting}</>;
  }
  return Object.assign(Shown, { preload: () => void fetch() });
}
