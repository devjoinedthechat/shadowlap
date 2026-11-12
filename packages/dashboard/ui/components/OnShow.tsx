import { useEffect, useState, type ComponentType, type JSX, type ReactNode } from 'react';

/**
 * A component whose code waits in a script of its own until it first shows. esbuild splits the
 * bundle at each `import()` (ui-bundles.mjs), so what holds it opens without that code, and the
 * script loads the first time it is drawn, `waiting` in its place meanwhile (nothing unless given).
 * Once the script is in, it draws at once wherever it shows. `preload` loads it ahead, on a sign that
 * it is about to show (the pointer or the focus reaching the tabs that switch to it), so that draws
 * at once too. A page never loads one as it opens: what opening a page loads is the page's own code,
 * which the bundle size test holds to the page's budget.
 *
 * A script that fails to come (the dashboard stopped, or was updated since the page opened) leaves
 * `failed` in its place, wherever it shows, for as long as the page is open: a browser keeps a
 * script's failure and never asks for it again, so only loading the page again brings it
 * (`LoadFailed`'s Retry, components/bits.tsx). A part that opens on a press draws nothing in its
 * place and says it in an error toast instead, with that Retry (pages/served.tsx).
 *
 * The shell's pages load this way (pages/lazy.tsx), its shortcuts sheet (shell/Shell.tsx), and each
 * part of a page heavy enough to wait for a script of its own: a run's views but Calls
 * (pages/Run.tsx), and what a run's page rarely opens, which keeps it within its budget: Share's
 * menu with its rows' words (pages/served.tsx, run/share.ts: the page's header, steps and keys read
 * theirs from run/share-steps.ts) and its Export dataset… and Export OpenTelemetry trace…
 * (run/ShareMenu.tsx), a finding's diff (run/InspectorPanel.tsx), the words of a run's notes
 * (run/RunNotes.tsx, with run/note-lines.ts: the page decides which notes a run has, run/notes.ts),
 * Run blame's dialogs and their check (fixes/RunBlameAsks.tsx), the fork menu (run/ForkMenu.tsx),
 * and the header's … with Delete run's helper (run/MoreMenu.tsx). So must the structural diff
 * (components/JsonDiff.tsx), the results matrix (components/ResultsMatrix.tsx), the check builder
 * (checks/) and each Changes tab (changes/): test/ui-bundle-size.test.ts fails when one of them is in
 * the first look or loads with a page. A part is declared beside the page that shows it, never in
 * pages/lazy.tsx: an exported copy, one script with the pages it shows (main-copy.tsx), then holds
 * the parts they show and none of the dashboard's other pages. A part a copy never draws, such as
 * Share's menu with the dialogs it opens (Export dataset…, Export OpenTelemetry trace… and the
 * Security report), the fork menu and the header's … (a copy forks nothing and draws none of the
 * header's actions), Run blame's dialogs, the check builder (which only Add check… opens), an
 * injection test's results (a copy keeps no results), the dialogs a run's steps ask in
 * (run/StepDialogs.tsx: a copy draws no step that asks), Revert's dialog or the first bad commit's
 * change box, the dialog a run's action asks in (run/ActionDialog.tsx), Find breaking commit's and
 * Delete run's (run/RunDialogs.tsx), a diverged test's (run/DivergedDialogs.tsx) and Edit and
 * fork's (run/EditDialog.tsx), the shell's palette, the job's drawer with the words of a job's kind
 * (jobs.ts) and Remove project's dialog, or the page that says another project holds what a link
 * names (pages/Elsewhere.tsx, which the page list shows too), is the exception: the served entry
 * hands it in (served-parts.ts, from pages/served.tsx), so a copy's script holds none of it, and a
 * test pins what keeps each one undrawn there (test/ui-exported-copy.test.ts,
 * test/ui-revert-copy.test.ts). The bundle size test holds each page's and each part's script to a
 * budget of its own. What a fork did differently waits so too, a finding of a fork's page alone,
 * asked for with the differences (run/FindingsBar.tsx).
 */
export interface OnShow<P> {
  (props: P): JSX.Element;
  /** Loads its script now, ahead of its first showing. One that failed is not asked for again. */
  preload(): void;
  /** Where its script is: not asked for, on its way, in, or failed for as long as the page is open. */
  readonly script: 'idle' | 'loading' | 'loaded' | 'failed';
}

export interface OnShowOptions<P = never> {
  /** What shows in its place while its script comes: nothing unless given. */
  waiting?: ReactNode;
  /**
   * What shows in its place once its script failed to come: nothing unless given. Given as a function,
   * it is drawn from the part's props, which say how a part that opens on a press closes (pages/served.tsx).
   */
  failed?: ReactNode | ((props: P) => ReactNode);
}

export function onShow<P extends object>(load: () => Promise<ComponentType<P>>, { waiting = null, failed = null }: OnShowOptions<P> = {}): OnShow<P> {
  let script: OnShow<P>['script'] = 'idle';
  let loaded: ComponentType<P> | null = null;
  let loading: Promise<void> | null = null;
  // One load for every place it shows, and what came of it kept, a failure too, as the browser keeps it.
  const fetch = (): Promise<void> => {
    if (!loading) {
      script = 'loading';
      loading = load().then(
        (c) => {
          loaded = c;
          script = 'loaded';
        },
        () => {
          script = 'failed';
        },
      );
    }
    return loading;
  };
  function Shown(props: P) {
    // From its first frame: the part once its script is in, and `failed` once it failed.
    const [Loaded, setLoaded] = useState(() => loaded);
    const [lost, setLost] = useState(() => script === 'failed');
    useEffect(() => {
      if (Loaded || lost) return;
      let shown = true;
      void fetch().then(() => {
        if (!shown) return;
        if (loaded) setLoaded(() => loaded);
        else setLost(true);
      });
      return () => {
        shown = false;
      };
    }, [Loaded, lost]);
    return Loaded ? <Loaded {...props} /> : <>{!lost ? waiting : typeof failed === 'function' ? failed(props) : failed}</>;
  }
  return Object.defineProperties(Shown, {
    preload: { value: () => void fetch() },
    script: { get: () => script },
  }) as OnShow<P>;
}
