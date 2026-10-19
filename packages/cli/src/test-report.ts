import { aboutUsd, formatTokens, safeText, type DivergenceType, type JudgeSummary, type StoredCheck, type TestFailure } from '@shadowlap/engine';
import { judgeSource } from './judge-results.js';

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
  ok: boolean;
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
  /**
   * Outcome checks from shadowlap.config.json for the attempt shown: the first failure, or the last
   * pass. Null without checks. A judge check's has its `status`, the judge's `reason` and `judge`.
   */
  checks: StoredCheck[] | null;
  /** For a recording that repeats: how many attempts ran, passed and had to pass. */
  attempts: { total: number; passed: number; required: number } | null;
  /** Its checks as written under `tests` in the config (`expect`), for tools that act on a failed check, such as the GitHub Action's fix on failure. */
  expect: Record<string, unknown> | null;
  /** `--update` re-recorded it: the run it replaced, the new one, its calls, and what the agent sends differently. */
  updated: { from: string | null; to: string; calls: number; changes?: string[] } | null;
  /** Its judge checks' calls over every attempt, apart from the agent's: how many came from the recording, how many went live, and what they cost. Null without one (always printed). */
  judge?: JudgeSummary | null;
}

export interface TestReport {
  version: 1;
  /** The test session in the store's history, and the revision it tested. */
  session: string | null;
  revision: string | null;
  passed: number;
  failed: number;
  /** A signal stopped the session: `results` has the goldens that finished before it. */
  interrupted: boolean;
  results: PackResult[];
}

export function testReport(results: PackResult[], session: { id: string; revision: string | null; interrupted?: boolean } | null = null): TestReport {
  const failed = results.filter((r) => !r.ok).length;
  return { version: 1, session: session?.id ?? null, revision: session?.revision ?? null, passed: results.length - failed, failed, interrupted: !!session?.interrupted, results };
}

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

/** A check as a Markdown list item: a judge check's with its verdict, reason and where it came from. */
function checkItem(c: StoredCheck): string {
  if (c.status === 'inconclusive') return `- ❔ ${cell(c.label)}: inconclusive, ${cell(c.detail ?? '')}`;
  if (!c.judge) return `- ${c.ok ? '✅' : '❌'} ${cell(c.label)}${c.ok ? '' : `: ${cell(c.detail ?? '')}`}`;
  const source = judgeSource(c.judge);
  return `- ${c.ok ? '✅' : '❌'} ${cell(c.label)}: ${cell(c.detail ?? '')}${source ? ` (${cell(source)})` : ''}`;
}

/** What the judges cost across the session, apart from the agents: `3 judge calls: 2 from the recordings, free; 1 live, ≈$0.0004`. */
function judgeTotals(results: readonly PackResult[]): string | null {
  const parts = results.flatMap((r) => (r.judge ? [r.judge] : []));
  if (!parts.length) return null;
  const calls = parts.reduce((n, j) => n + j.calls, 0);
  const replayed = parts.reduce((n, j) => n + j.replayed, 0);
  const live = parts.reduce((n, j) => n + j.live, 0);
  const spent = parts.reduce((n, j) => n + j.spent, 0);
  const said = [replayed ? `${replayed} from the recordings, free` : null, live ? `${live} live${spent ? `, ${aboutUsd(spent)}` : ''}` : null].filter(Boolean);
  return `${calls} judge call${calls === 1 ? '' : 's'}${said.length ? `: ${said.join('; ')}` : ''}, apart from the agents' calls above.`;
}

/** The result cell for a passing recording. */
function passedLabel(r: PackResult): string {
  const parts = [r.updated ? 'updated' : r.divergence ? `${r.divergence.type === 'ended_early' ? 'ended early' : 'forked'} at call ${r.divergence.callNo}` : 'clean'];
  if (r.checks?.length) parts.push(`${r.checks.length} check${r.checks.length === 1 ? '' : 's'} passed`);
  if (r.attempts) parts.push(`${r.attempts.passed}/${r.attempts.total} attempts`);
  return parts.join(', ');
}

export function markdownReport(report: TestReport): string {
  const lines: string[] = [];
  const total = report.results.length;
  lines.push(
    report.failed === 0
      ? `### Shadowlap: ${total} recording${total === 1 ? '' : 's'} passed`
      : `### Shadowlap: ${report.failed} of ${total} recording${total === 1 ? '' : 's'} failed`,
    '',
    '| | Recording | Result | Replayed | Input tokens not re-spent |',
    '|---|---|---|---:|---:|',
  );
  for (const r of report.results) {
    // Out of the recording for one that stopped short of it, so it never reads as whole.
    const of = r.divergence?.type === 'ended_early' && r.divergence.recorded !== undefined ? r.divergence.recorded : r.calls?.total;
    const replayed = r.calls ? `${r.calls.replayed}/${of}` : '';
    const tokens = r.tokensNotRespent !== null ? formatTokens(r.tokensNotRespent) : '';
    lines.push(`| ${r.ok ? '✅' : '❌'} | \`${cell(r.name)}\` | ${r.ok ? cell(passedLabel(r)) : cell(r.message ?? 'failed')} | ${replayed} | ${tokens} |`);
  }
  // A judge's verdict and reason are worth reading on a recording that passed too.
  const judged = report.results.filter((r) => r.ok && r.checks?.some((c) => c.judge));
  if (judged.length) {
    lines.push('', 'Judge checks:', '');
    for (const r of judged) lines.push(...r.checks!.filter((c) => c.judge).map((c) => checkItem(c).replace(/^- /, `- \`${cell(r.name)}\` `)));
  }
  const totals = judgeTotals(report.results);
  if (totals) lines.push('', totals);
  for (const r of report.results.filter((x) => !x.ok)) {
    lines.push('', `<details open><summary><b>${cell(r.name)}</b>: ${cell(r.message ?? 'failed')}</summary>`, '');
    if (r.checks?.length) lines.push(...r.checks.map(checkItem), '');
    const details = moreThanMessage(r);
    if (details) lines.push(fence(details), '');
    if (r.output) lines.push('Agent output, last lines:', '', fence(r.output), '');
    lines.push('</details>');
  }
  const failures = report.results.filter((r) => !r.ok);
  const diverged = failures.filter((r) => r.failure === 'diverged' || (r.divergence && !r.checks?.some((c) => !c.ok)));
  if (diverged.length) {
    const dirs = diverged.map((r) => r.dir.replace(/\\/g, '/').replace(/\/+$/, '')).map((d) => (/^[\w./*@%+=:,-]+$/.test(d) ? d : `'${d.replace(/'/g, `'\\''`)}'`));
    lines.push(
      '',
      `An intended change fails the test on purpose. Once you mean it, update the golden${diverged.length === 1 ? '' : 's'}: \`shadowlap test ${safeText(dirs.join(' '))} --update\` re-records ${diverged.length === 1 ? 'it' : 'each'} live with writes stubbed, and replaces ${diverged.length === 1 ? 'it' : 'each'} when ${diverged.length === 1 ? 'its' : 'their'} checks pass; review the new recording in this pull request. A value that changes every run, such as a date or a request id, needs a normalizer instead; the report suggests one. To keep the recording and judge the change by what the agent does, mark it \`fork\` and give it checks under \`tests\` in \`shadowlap.config.json\`.`,
    );
  }
  if (failures.some((r) => r.checks?.some((c) => !c.ok))) {
    lines.push('', 'A failed check means the agent did something its recording\'s checks in `shadowlap.config.json` rule out.');
  }
  if (report.interrupted) lines.push('', 'The session was interrupted: only the recordings above finished, and the rest did not run.');
  const updated = report.results.filter((r) => r.updated);
  if (updated.length) {
    lines.push('', `Updated: ${updated.map((r) => `\`${cell(r.name)}\``).join(', ')}, re-recorded live with writes stubbed and replaced because ${updated.length === 1 ? 'its checks pass' : 'their checks pass'}. Review the new recording${updated.length === 1 ? '' : 's'} in this pull request.`);
  }
  return lines.join('\n') + '\n';
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
      const failedChecks = (r.checks ?? []).filter((c) => !c.ok).map((c) => (c.status === 'inconclusive' ? `? ${safeText(c.label)}: inconclusive, ${safeText(c.detail ?? '')}` : `✗ ${safeText(c.label)}: ${safeText(c.detail ?? '')}`));
      const details = moreThanMessage(r);
      const body = [r.message ?? 'failed', ...(failedChecks.length ? ['', ...failedChecks] : []), ...(details ? ['', ...safeText(details).split('\n').slice(0, 30)] : [])].join('\n');
      return `::error file=${escapeProperty(file)},title=${escapeProperty(`Shadowlap: ${safeText(r.name)}`)}::${escapeData(body)}`;
    })
    .join('\n');
}
