/**
 * What a test session and a verify came to, as a page says it beside the verdict's word: the
 * dashboard's Verdicts says each change it lists in these words, and its other pages say the same
 * verdicts in them. No imports: a page may bundle it as it is.
 */

/**
 * A test session's tally, counting what passed, as every tally on a page counts it: `2 of 7 goldens
 * passed`. (The session's own line keeps the CLI's `2 passed, 3 failed, 2 inconclusive`.)
 */
export function goldensPassed(passed: number, goldens: number): string {
  return `${passed} of ${goldens} golden${goldens === 1 ? '' : 's'} passed`;
}

/**
 * What a verify's verdict says of the runs it took, read from each run's role and how it came out
 * (`outcome`: verify's word for it, `outcomeOf`, or a kept session's hyphenated `not-fixed`):
 *
 * - accepted: `Fixes the run that failed, keeps the 2 that worked`, or `Every run it verified kept
 *   passing` when it took no run that failed;
 * - rejected: `The change broke a run that worked`, else `The change did not fix the run that
 *   failed` (`1 of the 3 runs that failed` when it fixed the others);
 * - incomplete: `Not every run settled`.
 *
 * A run that failed as recorded is a target or a held-out run; one that passed is a good run.
 */
export function verifyHead(verdict: 'accepted' | 'rejected' | 'incomplete', runs: ReadonlyArray<{ role: string; outcome: string }>): string {
  const failed = runs.filter((x) => x.role === 'target' || x.role === 'holdout').length;
  const worked = runs.filter((x) => x.role === 'good').length;
  const theFailed = failed === 1 ? 'the run that failed' : `the ${failed} runs that failed`;
  if (verdict === 'rejected') {
    const broken = runs.filter((x) => x.role === 'good' && x.outcome === 'broken').length;
    if (broken) return `The change broke ${broken === 1 ? 'a run' : `${broken} runs`} that worked`;
    const notFixed = runs.filter((x) => x.role !== 'good' && (x.outcome === 'not fixed' || x.outcome === 'not-fixed')).length;
    if (notFixed) return `The change did not fix ${notFixed === failed ? theFailed : `${notFixed} of the ${failed} runs that failed`}`;
    return 'Verify rejected the change';
  }
  if (verdict === 'incomplete') return 'Not every run settled';
  if (!runs.length) return 'No run verified';
  if (!failed) return 'Every run it verified kept passing';
  return `Fixes ${theFailed}${worked ? `, keeps the ${worked === 1 ? 'one' : worked} that worked` : ''}`;
}

/**
 * A fix's verify as its Verify step heads it, by the runs it checked (each run's `verdict`, verify's
 * `pass` or `fail`): an accepted one reads `Every failing run fixed, every good run kept` only when it
 * checked every failing run of the fix (`failing`), else what it did role by role, as repair's
 * Verified line does, `Fixes 1 of 1 target run, 1 of 1 held-out, keeps 1 of 1 good`; a rejected one
 * says it broke a run that worked, else that it did not fix the failing runs it checked; one that
 * didn't settle every run, `Not every run settled`. The same verify reads so wherever a fix's verify
 * is listed.
 */
export function fixVerifyHead(verdict: 'accepted' | 'rejected' | 'incomplete', runs: ReadonlyArray<{ runId: string; role: string; verdict: string }>, failing: readonly string[]): string {
  if (verdict === 'rejected') return runs.some((x) => x.role === 'good' && x.verdict === 'fail') ? 'The change broke a run that worked' : 'The change did not fix the failing runs it checked';
  if (verdict !== 'accepted') return 'Not every run settled';
  const checked = new Set(runs.filter((x) => x.role !== 'good').map((x) => x.runId));
  const good = runs.some((x) => x.role === 'good');
  if (failing.length && failing.every((id) => checked.has(id))) return good ? 'Every failing run fixed, every good run kept' : 'Every failing run fixed';
  const tally = (role: string) => {
    const of = runs.filter((x) => x.role === role);
    return { n: of.length, text: `${of.filter((x) => x.verdict === 'pass').length} of ${of.length}` };
  };
  const [t, h, g] = [tally('target'), tally('holdout'), tally('good')];
  const said = [t.n ? `fixes ${t.text} target run${t.n === 1 ? '' : 's'}` : '', h.n ? `${t.n ? '' : 'fixes '}${h.text} held-out` : '', g.n ? `keeps ${g.text} good` : ''].filter(Boolean).join(', ');
  return said ? `${said.charAt(0).toUpperCase()}${said.slice(1)}` : 'No runs checked';
}
