/**
 * The hover of a link to failed runs on Runs: the first ids it lists, how many more, and where it
 * leads. Fixes' failing runs and a golden's Failed runs → say it alike.
 */
export function failedRunsWords(ids: readonly string[], count: number): string {
  const listed = ids.join(', ') + (count > ids.length ? ` and ${count - ids.length} more` : '');
  return `${ids.length ? `${listed}. ` : ''}${count === 1 ? 'Opens it' : 'Opens them'} on Runs, under Failed`;
}
