import type { CiWorkflowOptions, DivergenceView, FailureView, FoundCommit, GoldenRow, HistoryCell, TestsView } from './types.js';

/**
 * The Tests screen's words and choices, from the tests read model (`GET /api/tests`): the verdict's
 * line, a history cell's hover, the reports as the CLI prints them, which buttons a failure gets, and
 * what the Update golden dialog says. No DOM here: the tests import it.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number) => String(n).padStart(2, '0');

/** Oct 1, 10:02, local time. */
export function dayClock(ms: number): string {
  const d = new Date(ms);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Sep 30, from a date git or the store gives (ISO, or milliseconds); as given when it isn't one. */
export function shortDate(date: string | number): string {
  const ms = typeof date === 'number' ? date : Date.parse(date);
  if (!Number.isFinite(ms)) return String(date);
  const d = new Date(ms);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

const n = (count: number, word: string) => `${count.toLocaleString('en-US')} ${word}${count === 1 ? '' : 's'}`;

/**
 * The line under the verdict: the newest session's command, revision and time, how the goldens on
 * disk stand, and its upstream requests. `running` is whether a test job of this dashboard is still
 * going, which tells a session in progress from one whose process was killed.
 */
export function sessionLine(view: TestsView, running = false): { command: string; rest: string } | null {
  const v = view.verdict;
  if (!v) return null;
  const s = v.session;
  const parts = [s.revision ? `rev ${s.revision}` : 'no revision', dayClock(s.endedAt ?? s.startedAt), `${v.passing} passed, ${v.failing} failed${v.untested ? `, ${v.untested} not run yet` : ''}`, n(s.upstreamRequests, 'upstream request')];
  if (s.interrupted) parts.push('interrupted');
  else if (s.endedAt === null) parts.push(running ? 'running' : 'did not finish');
  return { command: s.command, rest: parts.join(' · ') };
}

/** A revision as the history's column names it: the short sha, with a + when it was tested with changes on top. */
export function revLabel(rev: string | null): string {
  if (!rev) return '—';
  const dirty = rev.endsWith('+dirty');
  const base = rev.replace(/\+dirty$/, '');
  return `${/^[0-9a-f]{8,}$/.test(base) ? base.slice(0, 7) : base.slice(0, 8)}${dirty ? '+' : ''}`;
}

/** How a golden did at one revision, for its history cell's hover: the title and one coloured row. */
export function historyTip(cell: HistoryCell, name: string): { title: string; label: string; value: string; color: string } {
  const title = `${cell.revision ?? 'no revision'} · ${name}`;
  if (cell.result === 'pass') return { title, label: 'passed', value: cell.updated ? 'updated here: re-recorded, its checks passed' : '', color: 'var(--o-rep)' };
  if (cell.result === 'fail') return { title, label: 'failed', value: cell.note ?? '', color: 'var(--err)' };
  return { title, label: 'not tested here', value: '', color: 'var(--line2)' };
}

/** Where a golden came from: a run in this store, or a pack made elsewhere. */
export function sourceText(row: GoldenRow): { runId: string } | { text: string } {
  if (row.source.kind === 'run') return { runId: row.source.runId };
  return { text: row.source.packedAt ? `packed ${shortDate(row.source.packedAt)}` : 'a pack made elsewhere' };
}

export type ReportTone = '' | 'no' | 'del' | 'add' | 'dim';

export interface ReportLine {
  text: string;
  tone: ReportTone;
}

/**
 * A divergence as `shadowlap test` prints it, line by line: the golden's line in red, a value that
 * was there before in red, the one sent now in lime.
 */
export function reportLines(text: string): ReportLine[] {
  return text.split('\n').map((line, i) => {
    const t = line.trimStart();
    if (i === 0 && t.startsWith('✗')) return { text: line, tone: 'no' };
    if (/^- /.test(t)) return { text: line, tone: 'del' };
    if (/^\+ /.test(t)) return { text: line, tone: 'add' };
    return { text: line, tone: '' };
  });
}

/**
 * Any other failure (a check, a non-zero exit, no calls, a golden that couldn't run) as the CLI
 * prints it under the golden's line, and `test --markdown` reports it: the checks, the details, and
 * the agent's last lines of output.
 */
export function failureLines(f: FailureView): ReportLine[] {
  const lines: ReportLine[] = [{ text: `✗ ${f.name}: ${f.reason}`, tone: 'no' }];
  for (const c of f.checks ?? []) lines.push({ text: `    ${c.ok ? `✓ ${c.label}` : `✗ ${c.label}: ${c.detail ?? 'failed'}`}`, tone: c.ok ? '' : 'no' });
  if (f.details) for (const l of f.details.replace(/\s+$/, '').split('\n')) lines.push({ text: `    ${l}`, tone: '' });
  if (f.output) for (const l of f.output.split('\n')) lines.push({ text: `    │ ${l}`, tone: 'dim' });
  return lines;
}

/** What a failure other than a divergence means, in one line under its report. */
export function failureHint(f: FailureView): string {
  switch (f.failure) {
    case 'check':
      return 'A failed check means the agent did something its checks in shadowlap.config.json rule out. Fix the agent; the golden is right.';
    case 'exit':
      return 'The agent exited with an error while it replayed: its last lines of output are above.';
    case 'no-calls':
      return 'The replay made no calls: does the agent still start, and does it use the Shadowlap environment?';
    default:
      return 'The golden could not be replayed.';
  }
}

/** The command to run, as a person would type it: `shadowlap test goldens/x --update`. */
export function commandText(args: readonly string[]): string {
  return `shadowlap ${args.map((a) => (/^[\w@%+=:,./*-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ')}`;
}

export interface DivergenceButtons {
  /**
   * Add normalizer and re-run: its label, whether it leads, and what it runs. `normalize` adds the
   * rules and tests the golden; `normalize-update` adds them and updates the golden, so it asks
   * first; `rerun` only tests it, the rules being in the config already.
   */
  normalize: { label: string; lead: boolean; run: 'normalize' | 'normalize-update' | 'rerun' } | null;
  update: { lead: boolean } | null;
  /** Find the commit, unless it already ran since this failure: with a range to start from, or asking for a good commit. */
  bisect: { range: boolean; live: boolean } | null;
  /** A changed id that may be a real change: the screen says so, and leads with neither fix. */
  maybeReal: boolean;
  /** A line above the buttons: why there is nothing to add, or that a changed id may be a real change. */
  note: 'maybe-real' | 'rules-added' | 'rules-added-update' | null;
}

/**
 * The buttons under a divergence. A value that surely changes every run is fixed by a normalizer,
 * so that button leads; a changed id that may be a real change gets both fixes side by side; any
 * other change is the golden's to update, if it was meant. Once the rules are in the config (added
 * for another golden), a re-run is what is left. Each shows only when the server runs it.
 */
export function divergenceButtons(d: DivergenceView, has: (kind: string) => boolean): DivergenceButtons {
  const steps = d.normalizeAndTest;
  const updates = !!steps && (steps.at(-1) ?? []).includes('--update');
  const lead = d.normalizerFixes && !d.maybeReal;
  let normalize: DivergenceButtons['normalize'] = null;
  if (steps && d.rulesAdded) normalize = updates || !has('test') ? null : { label: 'Re-run', lead, run: 'rerun' };
  else if (steps && has('normalize-and-test')) normalize = updates ? { label: 'Add normalizer and update…', lead, run: 'normalize-update' } : { label: 'Add normalizer and re-run', lead, run: 'normalize' };
  return {
    normalize,
    update: has('test-update') ? { lead: false } : null,
    bisect: d.found || !has('bisect') ? null : { range: !!d.bisect, live: !!d.bisect?.live },
    maybeReal: d.maybeReal,
    note: steps && d.rulesAdded ? (updates ? 'rules-added-update' : 'rules-added') : d.maybeReal && d.volatile ? 'maybe-real' : null,
  };
}

/** What Find the commit found, for the card above the buttons. */
export function foundLine(f: FoundCommit): { rev: string; subject: string; meta: string } {
  return { rev: f.rev, subject: f.subject, meta: [f.author, f.date ? shortDate(f.date) : null, n(f.tokens, 'token')].filter(Boolean).join(' · ') };
}

export interface UpdatePlan {
  title: string;
  text: string;
  goldens: Array<{ path: string; name: string; where: string }>;
  steps: Array<[string, string]>;
  /** The amber box: a value that changes every run diverged, so a normalizer is the lasting fix. */
  advise: { text: string; path: string | null; golden: string | null } | null;
  command: string;
  ok: string;
}

/**
 * The Update golden dialog, in the style of Remove project: the golden as a card (or the diverged
 * goldens as a list), What happens as numbered rows, the amber note when what diverged is a value
 * that changes every run, and the command. `paths` are the goldens to update.
 */
export function updatePlan(view: TestsView, paths: readonly string[]): UpdatePlan {
  const ds = paths.map((p) => view.divergences.find((d) => d.golden === p)).filter((d): d is DivergenceView => !!d);
  const rows = paths.map((p) => view.rows.find((r) => r.path === p));
  const goldens = paths.map((p, i) => {
    const d = ds.find((x) => x.golden === p);
    return { path: p, name: rows[i]?.name ?? p, where: d ? `diverged at call ${d.callNo}` : (rows[i]?.last.line ?? '') };
  });
  const one = goldens.length === 1;
  const checks = one ? (rows[0]?.checks.length ?? 0) : 0;
  const perRun = ds.filter((d) => d.volatile?.certain);
  let advise: UpdatePlan['advise'] = null;
  if (one && perRun[0]?.volatile) {
    const v = perRun[0].volatile;
    advise = { text: `${v.op === 'added' ? 'is new in every request and ' : ''}looks like ${v.looks}, which changes every run. Updating re-records it, and the next run diverges again.`, path: v.path, golden: perRun[0].golden };
  } else if (perRun.length) {
    const names = perRun.map((d) => d.name).join(', ');
    advise = { text: `${names} diverged on values that change every run. Updating re-records ${perRun.length === 1 ? 'it' : 'them'}, and the next run diverges again.`, path: null, golden: null };
  }
  return {
    title: one ? `Update ${goldens[0]!.name}?` : `Update ${goldens.length} diverged goldens?`,
    text: 'Use this when the change was intended. The new recording replaces the old one, and you review it in your pull request.',
    goldens,
    steps: [
      ['Re-recorded live', 'writes stubbed'],
      [one ? 'Its checks run' : 'Each one’s checks run', one ? (checks ? n(checks, 'check') : 'exit status') : 'per golden'],
      ['Replaced only if they pass', 'in your working tree'],
      ['You review the change', 'in your pull request'],
    ],
    advise,
    command: commandText(['test', ...paths, '--update']),
    ok: advise ? 'Update anyway' : 'Update',
  };
}

/** Settings → CI's options as `/api/ci/workflows` takes them in its query string; those left out take the server's defaults. */
export function ciQuery(o: Partial<CiWorkflowOptions> = {}): string {
  const q = new URLSearchParams();
  if (o.fix !== undefined) q.set('fix', o.fix ? 'on' : 'off');
  if (o.budget !== undefined) q.set('budget', o.budget);
  if (o.repairer !== undefined) q.set('repairer', o.repairer);
  if (o.onlyMain !== undefined) q.set('onlyMain', o.onlyMain ? 'on' : 'off');
  if (o.secret !== undefined) q.set('secret', o.secret);
  const text = q.toString();
  return text ? `?${text}` : '';
}
