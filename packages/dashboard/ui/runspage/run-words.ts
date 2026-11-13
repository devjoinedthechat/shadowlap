/**
 * What Runs' bulk bar and a run's page both offer: Add label…'s suggestions. Apart from the bulk
 * bar's own words (bulk.ts) and the runs an action took, in its toast (bulk-words.ts), so a run's page
 * loads none of them. No DOM here: the tests import it.
 */

/**
 * Add label…'s suggestions: every label the runs in memory carry (the newest 500), most used first,
 * ties in alphabetical order, `good` and `bad` among them. An older label is typed.
 */
export function labelSuggestions(runs: ReadonlyArray<{ labels?: readonly string[] | null }> | null): string[] {
  const uses = new Map<string, number>();
  for (const r of runs ?? []) for (const l of r.labels ?? []) uses.set(l, (uses.get(l) ?? 0) + 1);
  return [...uses].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([l]) => l);
}
