/**
 * What a test session and a verify came to, in the words of the command that gave each verdict:
 * what `shadowlap test` and `shadowlap verify` print, and what the dashboard's Verdicts says of each
 * change it lists. No imports: a page may bundle it as it is.
 */

/**
 * A test session's goldens by how they came out, as `shadowlap test` ends: `5 passed, 2 failed, 1
 * inconclusive`. An inconclusive golden is counted apart, neither passed nor failed, and only when
 * there is one.
 */
export function testTally(c: { passed: number; failed: number; inconclusive?: number }): string {
  return `${c.passed} passed, ${c.failed} failed${c.inconclusive ? `, ${c.inconclusive} inconclusive` : ''}`;
}

/**
 * What a verify found, run by run in their roles, as `shadowlap verify` says it after its verdict:
 * `fixes 1 of 1 target run, 2 of 2 held-out runs and keeps 2 of 2 good runs`. A run's `outcome` is
 * verify's word for it (`outcomeOf`, or a kept session's `fixed`, `not-fixed`, `kept`, `broken`):
 * fixed or kept held, and an inconclusive one is counted apart, `(1 inconclusive)`, neither held nor
 * one the change failed. `no runs` when it verified none.
 */
export function verifySentence(runs: ReadonlyArray<{ role: string; outcome: string }>): string {
  const count = (role: string) => {
    const of = runs.filter((x) => x.role === role);
    return { of: of.length, ok: of.filter((x) => x.outcome === 'fixed' || x.outcome === 'kept').length, unsure: of.filter((x) => x.outcome === 'inconclusive').length };
  };
  const t = count('target');
  const h = count('holdout');
  const g = count('good');
  const unsure = (c: { unsure: number }) => (c.unsure ? ` (${c.unsure} inconclusive)` : '');
  const runsOf = (n: number, what: string) => `${what} run${n === 1 ? '' : 's'}`;
  const parts = [
    t.of ? `fixes ${t.ok} of ${t.of} ${runsOf(t.of, 'target')}${unsure(t)}` : '',
    h.of ? `${t.of ? '' : 'fixes '}${h.ok} of ${h.of} ${runsOf(h.of, 'held-out')}${unsure(h)}` : '',
    g.of ? `keeps ${g.ok} of ${g.of} ${runsOf(g.of, 'good')}${unsure(g)}` : '',
  ].filter(Boolean);
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)!}` : (parts[0] ?? 'no runs');
}
