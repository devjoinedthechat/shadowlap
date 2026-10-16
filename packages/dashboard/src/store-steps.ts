/**
 * The team store's setup in four steps, each unlocking the next, as the setup page shows them:
 * connect your bucket, push your runs, push from CI, bring your team. Which are done, and the next,
 * worked out from what the server knows. No imports: the browser's bundle uses this file as it is
 * (the setup page, Settings → Store, the palette), and the server for Needs a look.
 */

export const SETUP_STEPS = ['Connect your bucket', 'Push your runs', 'Push from CI', 'Bring your team'] as const;

export interface SetupFacts {
  /** The config names the store and its last check worked. */
  connected: boolean;
  /** This machine pushed to it. */
  pushed: boolean;
  /** Runs a push would send: none means there is nothing to push, so that step is done. */
  onlyLocal: number;
  /** Push from CI added or skipped. */
  ci: 'added' | 'skipped' | null;
  /** The setup was finished. */
  finished: boolean;
}

/** Each step done, in order: a step counts only once the ones before it are done. */
export function setupDone(f: SetupFacts): [boolean, boolean, boolean, boolean] {
  const connect = f.connected;
  const push = connect && (f.pushed || f.onlyLocal === 0);
  const ci = push && f.ci !== null;
  const team = ci && f.finished;
  return [connect, push, ci, team];
}

/** The step to do next, numbered from 1, or null once all four are done. */
export function nextSetupStep(f: SetupFacts): { step: number; title: (typeof SETUP_STEPS)[number] } | null {
  const i = setupDone(f).indexOf(false);
  return i === -1 ? null : { step: i + 1, title: SETUP_STEPS[i]! };
}

/** A step's title inside a sentence: "push from CI", "connect your bucket". */
export function stepWords(title: string): string {
  return title.charAt(0).toLowerCase() + title.slice(1);
}
