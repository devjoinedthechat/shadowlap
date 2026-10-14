import { formatTokens, safeText, type DivergenceType } from '@shadowlap/engine';

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
  ok: boolean;
  /** One line: why the pack failed. */
  message: string | null;
  /** The divergence report and run summary, as the terminal shows them. */
  details: string | null;
  /** The last lines the agent printed, for a failure. */
  output: string | null;
  seconds: number;
  calls: { total: number; replayed: number; live: number; blocked: number; stubbed: number } | null;
  upstreamRequests: number | null;
  tokensNotRespent: number | null;
  divergence: { type: DivergenceType; callNo: number; kind: string; name: string } | null;
  /** Outcome checks from shadowlap.config.json for the attempt shown: the first failure, or the last pass. Null without checks. */
  checks: Array<{ ok: boolean; label: string; detail: string | null }> | null;
  /** For a recording that repeats: how many attempts ran, passed and had to pass. */
  attempts: { total: number; passed: number; required: number } | null;
}

export interface TestReport {
  version: 1;
  passed: number;
  failed: number;
  results: PackResult[];
}

export function testReport(results: PackResult[]): TestReport {
  const failed = results.filter((r) => !r.ok).length;
  return { version: 1, passed: results.length - failed, failed, results };
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

/** The result cell for a passing recording. */
function passedLabel(r: PackResult): string {
  const parts = [r.divergence ? `forked at call ${r.divergence.callNo}` : 'clean'];
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
    const replayed = r.calls ? `${r.calls.replayed}/${r.calls.total}` : '';
    const tokens = r.tokensNotRespent !== null ? formatTokens(r.tokensNotRespent) : '';
    lines.push(`| ${r.ok ? '✅' : '❌'} | \`${cell(r.name)}\` | ${r.ok ? cell(passedLabel(r)) : cell(r.message ?? 'failed')} | ${replayed} | ${tokens} |`);
  }
  for (const r of report.results.filter((x) => !x.ok)) {
    lines.push('', `<details open><summary><b>${cell(r.name)}</b>: ${cell(r.message ?? 'failed')}</summary>`, '');
    if (r.checks?.length) lines.push(...r.checks.map((c) => `- ${c.ok ? '✅' : '❌'} ${cell(c.label)}${c.ok ? '' : `: ${cell(c.detail ?? '')}`}`), '');
    if (r.details) lines.push(fence(r.details), '');
    if (r.output) lines.push('Agent output, last lines:', '', fence(r.output), '');
    lines.push('</details>');
  }
  const failures = report.results.filter((r) => !r.ok);
  if (failures.some((r) => r.divergence && !r.checks?.some((c) => !c.ok))) {
    lines.push(
      '',
      'An intended change fails the test on purpose. Re-record the run and pack it over the old recording, then review the new recording in this pull request: `shadowlap run -- <command>`, then `shadowlap pack <run> <dir>`. A date or id in a prompt needs a normalizer instead; the report suggests one. To keep the recording and judge the change by what the agent does, mark it `fork` and give it checks under `tests` in `shadowlap.config.json`.',
    );
  }
  if (failures.some((r) => r.checks?.some((c) => !c.ok))) {
    lines.push('', 'A failed check means the agent did something its recording\'s checks in `shadowlap.config.json` rule out.');
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

/** One `::error` per failed pack, pointing at its run.json. */
export function githubAnnotations(report: TestReport): string {
  return report.results
    .filter((r) => !r.ok)
    .map((r) => {
      const file = `${r.dir.replace(/\\/g, '/').replace(/\/+$/, '')}/run.json`;
      const failedChecks = (r.checks ?? []).filter((c) => !c.ok).map((c) => `✗ ${safeText(c.label)}: ${safeText(c.detail ?? '')}`);
      const body = [r.message ?? 'failed', ...(failedChecks.length ? ['', ...failedChecks] : []), ...(r.details ? ['', ...safeText(r.details).split('\n').slice(0, 30)] : [])].join('\n');
      return `::error file=${escapeProperty(file)},title=${escapeProperty(`Shadowlap: ${safeText(r.name)}`)}::${escapeData(body)}`;
    })
    .join('\n');
}
