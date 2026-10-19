import { checkStatus, formatTokens, safeText, statusTally, type CheckStatus, type DivergenceType, type StoredCheck, type TestFailure } from '@shadowlap/engine';

/**
 * `shadowlap test` results for machines and for pull requests: a JSON report other tools read (the
 * GitHub Action sets its outputs from it), a Markdown report for a CI job summary, and GitHub
 * Actions annotations that put a failed recording on the pull request's checks.
 */

export interface PackResult {
  /** The pack directory's name. */
  name: string;
  /** The pack directory as given on the command line. */
  dir: string;
  /** The golden as the store's test history names it: the pack directory relative to the project. */
  golden: string;
  /** `replay` must send the requests it recorded; `fork` may diverge and passes on its checks. */
  mode: 'replay' | 'fork';
  /** Whether CI lets it through: it passed. */
  ok: boolean;
  /**
   * How it came out: `passed`, `failed`, or `inconclusive` when all it fell short on is checks that
   * could not be decided. Every report this version writes has it; one made before reads as `ok` says.
   */
  verdict?: 'passed' | 'failed' | 'inconclusive';
  /** Why it failed: `diverged`, `check` (an outcome check), `exit`, `no-calls` or `error`. Null when it passed. */
  failure: TestFailure | null;
  /** One line: why the pack failed. */
  message: string | null;
  /** The divergence report and run summary, as the terminal shows them. */
  details: string | null;
  /** The last lines the agent printed, for a failure. */
  output: string | null;
  seconds: number;
  /** The replay shown (the passing attempt, or the one that failed), and every attempt's run. */
  runId: string | null;
  runs: Array<{ runId: string; ok: boolean }>;
  /** The recording that was replayed. */
  goldenRunId: string | null;
  calls: { total: number; replayed: number; live: number; blocked: number; stubbed: number } | null;
  upstreamRequests: number | null;
  tokensNotRespent: number | null;
  /** `recorded`: for one that ended early, how many calls the recording holds. */
  divergence: { type: DivergenceType; callNo: number; kind: string; name: string; recorded?: number } | null;
  /** Outcome checks from shadowlap.config.json for the attempt shown: the first failure, or the last pass. Each has its `status` (passed, failed, inconclusive, not-applicable). Null without checks. */
  checks: StoredCheck[] | null;
  /** For a recording that repeats: how many attempts ran, passed and had to pass. */
  attempts: { total: number; passed: number; required: number } | null;
  /** Its checks as written under `tests` in the config (`expect`), for tools that act on a failed check, such as the GitHub Action's fix on failure. */
  expect: Record<string, unknown> | null;
  /** `--update` re-recorded it: the run it replaced, the new one, its calls, and what the agent sends differently. */
  updated: { from: string | null; to: string; calls: number; changes?: string[] } | null;
}

export interface TestReport {
  version: 1;
  /** The test session in the store's history, and the revision it tested. */
  session: string | null;
  revision: string | null;
  /** Packs by what CI does with them: an inconclusive one counts as failed. */
  passed: number;
  failed: number;
  /** Packs whose verdict is inconclusive, counted among `failed` too. */
  inconclusive: number;
  /** A signal stopped the session: `results` has the goldens that finished before it. */
  interrupted: boolean;
  results: PackResult[];
}

export function testReport(results: PackResult[], session: { id: string; revision: string | null; interrupted?: boolean } | null = null): TestReport {
  const failed = results.filter((r) => !r.ok).length;
  const inconclusive = results.filter((r) => r.verdict === 'inconclusive').length;
  return { version: 1, session: session?.id ?? null, revision: session?.revision ?? null, passed: results.length - failed, failed, inconclusive, interrupted: !!session?.interrupted, results };
}

/** A pack's verdict, as `ok` says for a result made before results had one. */
const verdictOf = (r: Pick<PackResult, 'verdict' | 'ok'>): NonNullable<PackResult['verdict']> => r.verdict ?? (r.ok ? 'passed' : 'failed');

/** A pack's mark in a report: passed, failed, or inconclusive (amber). */
const mark = (r: Pick<PackResult, 'verdict' | 'ok'>) => ({ inconclusive: '🟡', passed: '✅', failed: '❌' })[verdictOf(r)];

/** Text safe to put in a Markdown table cell: no control characters, pipes or line breaks. */
function cell(s: string): string {
  return safeText(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/** A fenced block whose fence is longer than any backtick run inside it. */
function fence(text: string, lang = 'text'): string {
  const longest = Math.max(2, ...[...safeText(text).matchAll(/`+/g)].map((m) => m[0].length));
  const f = '`'.repeat(longest + 1);
  return `${f}${lang}\n${safeText(text).replace(/\s+$/, '')}\n${f}`;
}

/** The result cell for a passing recording. */
function passedLabel(r: PackResult): string {
  const parts = [r.updated ? 'updated' : r.divergence ? `${r.divergence.type === 'ended_early' ? 'ended early' : 'forked'} at call ${r.divergence.callNo}` : 'clean'];
  if (r.checks?.length) parts.push(statusTally(r.checks));
  if (r.attempts) parts.push(`${r.attempts.passed}/${r.attempts.total} attempts`);
  return parts.join(', ');
}

export function markdownReport(report: TestReport): string {
  const lines: string[] = [];
  const total = report.results.length;
  const recordings = `recording${total === 1 ? '' : 's'}`;
  // Inconclusive ones are counted apart: they fail the run, but nothing failed in them.
  const failed = report.results.filter((r) => verdictOf(r) === 'failed').length;
  const inconclusive = report.results.filter((r) => verdictOf(r) === 'inconclusive').length;
  const head = !failed && !inconclusive ? `${total} ${recordings} passed` : !failed ? `${inconclusive} of ${total} ${recordings} ${inconclusive === 1 ? 'is' : 'are'} inconclusive` : `${failed} of ${total} ${recordings} failed${inconclusive ? `, ${inconclusive} inconclusive` : ''}`;
  lines.push(`### Shadowlap: ${head}`, '', '| | Recording | Result | Replayed | Input tokens not re-spent |', '|---|---|---|---:|---:|');
  for (const r of report.results) {
    // Out of the recording for one that stopped short of it, so it never reads as whole.
    const of = r.divergence?.type === 'ended_early' && r.divergence.recorded !== undefined ? r.divergence.recorded : r.calls?.total;
    const replayed = r.calls ? `${r.calls.replayed}/${of}` : '';
    const tokens = r.tokensNotRespent !== null ? formatTokens(r.tokensNotRespent) : '';
    lines.push(`| ${mark(r)} | \`${cell(r.name)}\` | ${r.ok ? cell(passedLabel(r)) : cell(r.message ?? 'failed')} | ${replayed} | ${tokens} |`);
  }
  for (const r of report.results.filter((x) => !x.ok)) {
    lines.push('', `<details open><summary><b>${cell(r.name)}</b>: ${cell(r.message ?? 'failed')}</summary>`, '');
    if (r.checks?.length) lines.push(...r.checks.map(markdownCheck), '');
    const details = moreThanMessage(r);
    if (details) lines.push(fence(details), '');
    if (r.output) lines.push('Agent output, last lines:', '', fence(r.output), '');
    lines.push('</details>');
  }
  const failures = report.results.filter((r) => !r.ok);
  const diverged = failures.filter((r) => verdictOf(r) !== 'inconclusive' && (r.failure === 'diverged' || (r.divergence && !r.checks?.some((c) => !c.ok))));
  if (diverged.length) {
    const dirs = diverged.map((r) => r.dir.replace(/\\/g, '/').replace(/\/+$/, '')).map((d) => (/^[\w./*@%+=:,-]+$/.test(d) ? d : `'${d.replace(/'/g, `'\\''`)}'`));
    lines.push(
      '',
      `An intended change fails the test on purpose. Once you mean it, update the golden${diverged.length === 1 ? '' : 's'}: \`shadowlap test ${safeText(dirs.join(' '))} --update\` re-records ${diverged.length === 1 ? 'it' : 'each'} live with writes stubbed, and replaces ${diverged.length === 1 ? 'it' : 'each'} when ${diverged.length === 1 ? 'its' : 'their'} checks pass; review the new recording in this pull request. A value that changes every run, such as a date or a request id, needs a normalizer instead; the report suggests one. To keep the recording and judge the change by what the agent does, mark it \`fork\` and give it checks under \`tests\` in \`shadowlap.config.json\`.`,
    );
  }
  if (failures.some((r) => r.checks?.some((c) => checkStatus(c) === 'failed'))) {
    lines.push('', 'A failed check means the agent did something its recording\'s checks in `shadowlap.config.json` rule out.');
  }
  if (failures.some((r) => r.checks?.some((c) => checkStatus(c) === 'inconclusive'))) {
    lines.push('', 'An inconclusive check could not be decided, such as a judge check with no recorded verdict and no key to ask for one, or a condition whose value the run does not have: it never passes, and it fails the run.');
  }
  if (report.interrupted) lines.push('', 'The session was interrupted: only the recordings above finished, and the rest did not run.');
  const updated = report.results.filter((r) => r.updated);
  if (updated.length) {
    lines.push('', `Updated: ${updated.map((r) => `\`${cell(r.name)}\``).join(', ')}, re-recorded live with writes stubbed and replaced because ${updated.length === 1 ? 'its checks pass' : 'their checks pass'}. Review the new recording${updated.length === 1 ? '' : 's'} in this pull request.`);
  }
  return lines.join('\n') + '\n';
}

/** Each verdict as a job summary shows it: the same four words as everywhere, and a mark GitHub renders. */
const MARKDOWN_MARK: Record<CheckStatus, string> = { passed: '✅', failed: '❌', inconclusive: '🟡', 'not-applicable': '➖' };

/** A check as a line of the summary's list: its mark, what was expected, and for anything but a pass what happened; a judge's reason after it. */
function markdownCheck(c: StoredCheck): string {
  const status = checkStatus(c);
  const reason = c.reason ? ` · ${cell(c.reason)}` : '';
  const word = status === 'inconclusive' ? 'inconclusive · ' : status === 'not-applicable' ? 'not applicable · ' : '';
  return `- ${MARKDOWN_MARK[status]} ${cell(c.label)}${status === 'passed' ? '' : `: ${word}${cell(c.detail ?? '')}`}${reason}`;
}

/** Escapes for GitHub workflow commands: data and property values have different rules. */
function escapeData(s: string): string {
  return s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}
function escapeProperty(s: string): string {
  return escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

/**
 * A failure's details when they say more than its message: a pack that could not be replayed at all
 * (no run.json, say) has the one sentence for both, which a report says once.
 */
function moreThanMessage(r: PackResult): string | null {
  return r.details && r.details.trim() !== (r.message ?? '').trim() ? r.details : null;
}

/** One `::error` per failed pack, pointing at its run.json. */
export function githubAnnotations(report: TestReport): string {
  return report.results
    .filter((r) => !r.ok)
    .map((r) => {
      const file = `${r.dir.replace(/\\/g, '/').replace(/\/+$/, '')}/run.json`;
      const failedChecks = (r.checks ?? []).filter((c) => !c.ok).map((c) => (checkStatus(c) === 'inconclusive' ? `? ${safeText(c.label)}: inconclusive · ${safeText(c.detail ?? '')}` : `✗ ${safeText(c.label)}: ${safeText(c.detail ?? '')}`));
      const details = moreThanMessage(r);
      const body = [r.message ?? 'failed', ...(failedChecks.length ? ['', ...failedChecks] : []), ...(details ? ['', ...safeText(details).split('\n').slice(0, 30)] : [])].join('\n');
      return `::error file=${escapeProperty(file)},title=${escapeProperty(`Shadowlap: ${safeText(r.name)}`)}::${escapeData(body)}`;
    })
    .join('\n');
}
