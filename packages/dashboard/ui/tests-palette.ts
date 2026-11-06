import { testsPalette } from './goldens.js';
import type { TestsView } from './types.js';

/**
 * The palette's Tests group and its Update goldens, on any page: each golden opens Tests, and
 * Update goldens opens Tests with its dialog (`#/tests?update`). What it lists is the goldens as the
 * server last listed them: the Tests page keeps that current (`keepTests`), and opening the palette
 * loads it again, once at a time; when what it lists changes, `onTestsChanged` hears of it, so an
 * open palette gains the group as soon as the answer lands. `palette-actions.ts` registers it, and
 * loads with the palette. No DOM here, and nothing that needs it: the tests drive it with a stand-in app.
 */

/** What the source needs of the app (`AppState`). */
export interface TestsPaletteApp {
  exported: boolean;
  client: { exported: boolean; tests(): Promise<TestsView> };
  actionsOff: string | null;
  guard(fn: () => void): void;
}

export interface TestsPaletteCommand {
  group: 'Tests' | 'Actions';
  label: string;
  hint: string;
  mono: boolean;
  /** It opens what starts a job (Update goldens): paused while the server can't be reached. */
  job?: boolean;
  run: () => void;
}

let known: TestsView | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

/** What the palette shows of an answer: a new one with the same names, results and divergences changes nothing there. */
const paletteKey = (v: TestsView | null) => (v ? JSON.stringify([v.rows.map((r) => [r.name, r.last.result, !!r.error]), v.diverged]) : '');

export function onTestsChanged(on: () => void): () => void {
  listeners.add(on);
  return () => {
    listeners.delete(on);
  };
}

/** The goldens as last listed, from the Tests page or the palette's own load. */
export function keepTests(view: TestsView): void {
  const before = paletteKey(known);
  known = view;
  if (paletteKey(view) !== before) for (const on of listeners) on();
}

/** Loads the goldens again, once at a time; a failure leaves what was there. */
export function loadTests(client: TestsPaletteApp['client']): Promise<void> {
  if (client.exported) return Promise.resolve();
  loading ??= client
    .tests()
    .then(keepTests, () => undefined)
    .finally(() => {
      loading = null;
    });
  return loading;
}

/**
 * The palette's entries, read each time it opens, which also loads the goldens again. `update`: the
 * server updates goldens (Update goldens is offered only then, and only where actions can run).
 */
export function testsPaletteCommands(app: TestsPaletteApp, go: (to: string) => void, o: { update: boolean }): TestsPaletteCommand[] {
  if (app.exported) return [];
  void loadTests(app.client);
  return testsPalette(known, { update: o.update && !app.actionsOff }).map((e) => ({
    group: e.group,
    label: e.label,
    hint: e.hint,
    mono: e.mono,
    ...(e.job ? { job: true } : {}),
    run: () => (e.group === 'Actions' ? app.guard(() => go(e.to)) : go(e.to)),
  }));
}
