import { isObject, testsEntryFor } from '@shadowlap/engine';
import { parseWork, type OutcomeWork } from './run-outcome.js';
import type { GoldenRow } from './tests.js';

/**
 * Tests' goldens whose tests entry sets their error-path presets (a `"chaos"` object), decorated
 * beside testsView so src/tests.ts doesn't grow: before they have run, such a row says so and offers
 * Run error-path presets…, on its recording here. One that says `"chaos": false` offers nothing.
 */
declare module './tests.js' {
  interface GoldenRow {
    /** Its tests entry sets its error-path presets, and none has run yet (withPresetsEntries). */
    presetsEntry?: true;
  }
}

/** A row flagged so; what the UI imports to see the flag. */
export type PresetsEntryRow = Pick<GoldenRow, 'presetsEntry'>;

/** Its tests entry gives `"chaos"` an object (parseTests has read each entry's with parseChaosFields, as the CLI does). */
function setsPresets(tests: Record<string, unknown>, key: string | null): boolean {
  const entry = key === null ? undefined : tests[key];
  return isObject(entry) && isObject(entry.chaos);
}

/**
 * Tests' rows, each golden recorded here whose presets haven't run flagged when its tests entry sets
 * them. A config the CLI would refuse offers nothing: every command refuses it.
 */
export function withPresetsEntries<V extends { rows: GoldenRow[] }>(view: V, work: OutcomeWork | null): V {
  const parsed = parseWork(work);
  const tests = work?.tests;
  if (!work || !parsed || parsed.error || !isObject(tests)) return view;
  const rows = view.rows.map((row) => (row.presets || row.source.kind !== 'run' || !setsPresets(tests, testsEntryFor(parsed.entries, row.path, work.dir)?.recording ?? null) ? row : { ...row, presetsEntry: true as const }));
  return { ...view, rows };
}
