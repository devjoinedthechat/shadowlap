/**
 * The commits just before the first bad one that Find breaking commit could not test (they would
 * not check out, or `--build` failed there), as every place that names the commit says them: the
 * CLI's answer and Tests' card on its line (`line`, each commit as the place names it), Revert's
 * dialog as its Untested row's quiet part (`row`, the commits its value).
 */
export const UNTESTED_WORDS = {
  line: (commits: readonly string[]): string => `or one just before it, which could not be tested: ${commits.join(', ')}`,
  row: 'just before it: the first bad commit may be among them',
} as const;
