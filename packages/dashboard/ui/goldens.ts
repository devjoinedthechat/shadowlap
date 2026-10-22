import { href } from './route.js';
import type { BisectMiss, BisectRevision, CiWorkflowOptions, DivergenceView, FailureView, FoundCommit, GoldenCheck, GoldenRow, HistoryCell, InconclusiveView, TestsView } from './types.js';

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
 * The line under the verdict, all of it one session's: the newest that ran every golden (or runs
 * them now), its command, revision and time, its own passed and failed counts, and its upstream
 * requests; then, when goldens ran again since on their own (Add normalizer and re-run, Update
 * golden), how they did, with each one's result in `sinceTip`. A session that hasn't ended is
 * running while its process is (`live`, from the server, wherever it was started; `running`, a test
 * job of this tab's), and otherwise did not finish.
 */
export function sessionLine(view: TestsView, running = false): { command: string; rest: string; since: string | null; sinceTip: string | null } | null {
  const v = view.verdict;
  if (!v) return null;
  const s = v.session;
  const live = s.endedAt === null && !s.interrupted && (s.live || running);
  // Inconclusive goldens count apart, as the verdict's badge counts them.
  const counts = `${s.passed} passed, ${s.failed} failed${s.inconclusive ? `, ${s.inconclusive} inconclusive` : ''}`;
  const parts = [s.revision ? `rev ${s.revision}` : 'no revision', dayClock(s.endedAt ?? s.startedAt), `${counts}${live ? ' so far' : ''}`, n(s.upstreamRequests, 'upstream request')];
  if (s.interrupted) parts.push('interrupted');
  else if (s.endedAt === null) parts.push(live ? 'running' : 'did not finish');
  const since = v.since ?? [];
  // Each as it came out: an inconclusive one is neither passed nor failed (a result from before verdicts reads by `ok`).
  const word = (x: (typeof since)[number]) => x.verdict ?? (x.ok ? 'passed' : 'failed');
  const failed = since.filter((x) => word(x) === 'failed').length;
  const unsure = since.filter((x) => word(x) === 'inconclusive').length;
  const notPassed = [failed ? `${failed} failed` : '', unsure ? `${unsure} inconclusive` : ''].filter(Boolean).join(', ');
  const sinceText = !since.length ? null : since.length === 1 ? `since: ${since[0]!.name} ${word(since[0]!)}` : `since: ${since.length} goldens ran again, ${notPassed || 'all passed'}`;
  const sinceTip = since.length ? since.map((x) => `${x.name} ${word(x)}${x.revision ? ` at ${x.revision}` : ''}, ${dayClock(x.at)}`).join('\n') : null;
  return { command: s.command, rest: parts.join(' · '), since: sinceText, sinceTip };
}

/**
 * The jobs that replay or rewrite the goldens on disk, by what each is doing, as the server tells
 * them apart: while one runs in a project, another is refused there (409), so its button waits.
 * Find the commit counts when it searches a golden; on a run, it touches no golden.
 */
const TEST_FAMILY = new Map<string, string>([
  ['test', 'a test session'],
  ['test-update', 'an update of goldens'],
  ['normalize-and-test', 'a normalizer and its re-run'],
  ['pack-test', 'a new golden being packed and tested'],
  ['bisect', 'find the commit'],
]);

type FamilyJob = { kind?: string | undefined; args?: readonly string[] | undefined; done: boolean; project?: { id: string } | undefined };

const inFamily = (x: FamilyJob): boolean => (x.kind === 'bisect' ? !!x.args?.[1] && !/^[0-9A-Z]{26}$/.test(x.args[1]) : !!x.kind && TEST_FAMILY.has(x.kind));

/**
 * Why a Tests action that replays or rewrites goldens waits, as the server would refuse it: one of
 * those jobs is running in this project (`projectId`, null on a dashboard serving one store). `verb`
 * is what to do once it is done. Null when it can start.
 */
export function testsBusy(jobs: ReadonlyArray<FamilyJob>, verb: string, projectId: string | null = null): string | null {
  const j = jobs.find((x) => !x.done && inFamily(x) && (x.project?.id ?? null) === projectId);
  const doing = j?.kind ? TEST_FAMILY.get(j.kind)! : null;
  return doing ? `${doing.charAt(0).toUpperCase()}${doing.slice(1)} is running: ${verb} once it is done.` : null;
}

/**
 * Why a Tests action waits for a test session, or error-path presets on goldens, running wherever it
 * was started (a terminal, another dashboard, a job, which `testsBusy` names first), as the server
 * says it: by its command. Null when none runs.
 */
export function sessionWait(view: (Pick<TestsView, 'running'> & Partial<Pick<TestsView, 'chaosRunning'>>) | null, verb: string): string | null {
  const live = view?.running ?? view?.chaosRunning;
  if (!live) return null;
  return `${live.command.length > 60 ? `${live.command.slice(0, 59)}…` : live.command} is running: ${verb} once it is done.`;
}

/** The running test job among these, for the palette's Run the tests to open rather than start another. */
export function runningTests<T extends { kind?: string | undefined; done: boolean }>(jobs: readonly T[]): T | null {
  return jobs.find((x) => !x.done && x.kind === 'test') ?? null;
}

/**
 * The commits Find the commit's dialog offers as good ones, newest first, as the mock words them:
 * `c91d0f4 · Escalate refunds above the limit`, with how the golden did there when it didn't pass
 * under today's checks: failed, inconclusive (neither passed nor failed), or passed under others. `initial` is the one to start on: the newest that passed under them, older
 * than `tried` when a search from that one named no first bad commit (it already failed there); ''
 * when none is known, for the dialog to ask for any commit.
 */
export function revisionChoices(revisions: readonly BisectRevision[], tried: string | null = null): { options: Array<{ value: string; label: string }>; initial: string } {
  const options = revisions.map((r) => {
    const how = r.verdict === 'inconclusive' ? ' · inconclusive here' : r.result === 'fail' ? ' · failed here' : r.sameChecks ? '' : ' · passed under other checks';
    return { value: r.rev, label: `${revLabel(r.rev)} · ${r.subject || shortDate(r.at)}${how}` };
  });
  const at = tried ? revisions.findIndex((r) => r.rev === tried || r.rev.startsWith(tried) || tried.startsWith(r.rev)) : -1;
  // Nothing older than the one tried is known: the dialog starts on a field for any commit ('').
  const older = at >= 0 ? revisions.slice(at + 1) : revisions;
  const initial = older.find((r) => r.result === 'pass' && r.sameChecks)?.rev ?? older[0]?.rev ?? '';
  return { options, initial };
}

/** A revision as the history's column names it: the short sha, with a + when it was tested with changes on top. */
export function revLabel(rev: string | null): string {
  if (!rev) return '—';
  const dirty = rev.endsWith('+dirty');
  const base = rev.replace(/\+dirty$/, '');
  return `${/^[0-9a-f]{8,}$/.test(base) ? base.slice(0, 7) : base.slice(0, 8)}${dirty ? '+' : ''}`;
}

/**
 * How a golden did at one revision, for its history cell's hover: the title and one coloured row. A
 * pass says when it was updated there, and a connection the network guard blocked in its replay.
 */
export function historyTip(cell: HistoryCell, name: string): { title: string; label: string; value: string; color: string } {
  const title = `${cell.revision ?? 'no revision'} · ${name}`;
  // Run again on its own with changes on top of this commit (Add normalizer and re-run): said, as it isn't the commit alone.
  const again = cell.tested && cell.tested !== cell.revision ? `run again at ${cell.tested}` : null;
  // Neither passed nor failed: amber, with the attempts it ran.
  if (cell.verdict === 'inconclusive') return { title, label: 'inconclusive', value: [again, cell.rate ? `${cell.rate.passes} of ${cell.rate.attempts} attempts passed` : null, cell.note].filter(Boolean).join(' · '), color: 'var(--warn)' };
  if (cell.result === 'pass') return { title, label: 'passed', value: [cell.updated ? 'updated here: re-recorded, its checks passed' : null, again, cell.note].filter(Boolean).join(' · '), color: 'var(--o-rep)' };
  if (cell.result === 'fail') return { title, label: 'failed', value: [again, cell.updated ? `updated here, then ${cell.note ?? 'failed'}` : cell.note].filter(Boolean).join(' · '), color: 'var(--err)' };
  return { title, label: 'not tested here', value: '', color: 'var(--line2)' };
}

/**
 * A check as the table names it, in the screen's words: `issue_refund never called`, `send_email
 * called once`, `input tokens ≤ 6,000`, `cost ≤ $0.02`. Any other label stays as the CLI wrote it,
 * as the reports under the table print them.
 */
export function checkWords(label: string): string {
  let m = /^(.+) called 0 times$/.exec(label);
  if (m) return `${m[1]} never called`;
  m = /^(.+) called 1 time$/.exec(label);
  if (m) return `${m[1]} called once`;
  m = /^at (most|least) (\d+) (input|output) tokens?$/.exec(label);
  if (m) return `${m[3]} tokens ${m[1] === 'most' ? '≤' : '≥'} ${Number(m[2]).toLocaleString('en-US')}`;
  m = /^cost at (most|least) (\$[\d.]+)$/.exec(label);
  if (m) return `cost ${m[1] === 'most' ? '≤' : '≥'} ${m[2]}`;
  return label;
}

/** Each status's mark, as the CLI's reports draw them: passed, failed, inconclusive, not applicable. */
export const CHECK_MARK: Readonly<Record<NonNullable<GoldenCheck['status']>, string>> = { passed: '✓', failed: '✗', inconclusive: '?', 'not-applicable': '–' };

/** A status as words: the four verdict words. */
const STATUS_WORD: Readonly<Record<NonNullable<GoldenCheck['status']>, string>> = { passed: 'passed', failed: 'failed', inconclusive: 'inconclusive', 'not-applicable': 'not applicable' };

/** The colour of each status's mark, as the history's cells and the verdict use them. */
const STATUS_COLOR: Readonly<Record<NonNullable<GoldenCheck['status']>, string>> = { passed: 'var(--ok)', failed: 'var(--err)', inconclusive: 'var(--warn)', 'not-applicable': 'var(--faint)' };

export interface CheckMarkView {
  /** ✓ ✗ ? or –, and the class that colours it (`passed`, `failed`, `inconclusive`, `not-applicable`); null with no result. */
  mark: string | null;
  status: GoldenCheck['status'];
  /** The status in words, for a screen reader and the hover: `failed`, `not run yet`. */
  word: string;
  /** The check, as the table names it. */
  text: string;
  /** A line under it: what failed and in how many attempts, why it couldn't be decided, or where a judge's verdict came from. */
  sub: string | null;
  /** The hover: the status and the check, and one row saying why. */
  tip: { title: string; label: string; value: string; color: string };
}

/**
 * A check in the table, marked by how the golden's last result came out on it: ✓ passed, ✗ failed
 * (for a golden run more than once, how many attempts passed it and what the others did), ? in amber
 * when it couldn't be decided (and why), – when it didn't apply, and no mark before a result exists
 * or for a check the last result didn't judge. `ran`: the golden has a last result.
 */
export function checkMark(c: GoldenCheck, ran: boolean): CheckMarkView {
  const text = checkWords(c.label);
  const t = c.attempts;
  if (!c.status) {
    const word = ran ? 'not judged' : 'not run yet';
    return { mark: null, status: null, word, text, sub: null, tip: { title: `${word} · ${c.label}`, label: word, value: ran ? 'its last result ran under other checks, or couldn’t run' : 'its golden hasn’t run yet', color: 'var(--line2)' } };
  }
  const word = STATUS_WORD[c.status];
  const detail = c.detail ?? '';
  let sub: string | null = null;
  let value = '';
  if (c.status === 'failed') {
    sub = t ? `${t.passed} of ${t.of} attempts passed · the others: ${detail || 'failed'}` : detail || null;
    value = t ? `${t.passed} of ${t.of} attempts passed; the others: ${detail || 'failed'}` : detail || 'failed';
  } else if (c.status === 'inconclusive') {
    sub = detail || null;
    value = detail || 'it could not be decided';
  } else if (c.status === 'not-applicable') {
    sub = 'not applicable';
    value = detail || 'its condition never held';
  } else {
    // A judge's verdict says where it came from; a check over several attempts, how many passed it.
    sub = t && t.passed < t.of ? `${t.passed} of ${t.of} attempts passed` : c.source === 'recording' ? 'judged from the recording' : c.source === 'live' ? `judged live${t ? ` in ${t.of} attempts` : ''}` : null;
    value = [c.reason ? `“${c.reason}”` : null, t ? (t.passed === t.of ? `passed in every attempt, ${t.of} of ${t.of}` : `passed in ${t.passed} of ${t.of} attempts`) : null].filter(Boolean).join(' · ') || 'passed';
  }
  return { mark: CHECK_MARK[c.status], status: c.status, word, text, sub, tip: { title: `${word} · ${c.label}`, label: word, value, color: STATUS_COLOR[c.status] } };
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
  for (const c of f.checks ?? []) lines.push(checkReportLine(c));
  if (f.details) for (const l of f.details.replace(/\s+$/, '').split('\n')) lines.push({ text: `    ${l}`, tone: '' });
  if (f.output) for (const l of f.output.split('\n')) lines.push({ text: `    │ ${l}`, tone: 'dim' });
  return lines;
}

/**
 * A check under a golden's line, as the CLI prints it: `✓ label`, `✗ label: detail`, `? label:
 * inconclusive · detail` or `– label: not applicable · detail`, with a judge's reason after it. A
 * result kept before checks had a status reads as its `ok` says.
 */
export function checkReportLine(c: NonNullable<FailureView['checks']>[number]): ReportLine {
  const status = c.status ?? (c.ok ? 'passed' : 'failed');
  const reason = c.reason ? ` · ${c.reason}` : '';
  const text =
    status === 'passed'
      ? `✓ ${c.label}${reason}`
      : status === 'failed'
        ? `✗ ${c.label}: ${c.detail ?? 'failed'}${reason}`
        : status === 'inconclusive'
          ? `? ${c.label}: inconclusive · ${c.detail ?? ''}${reason}`
          : `– ${c.label}: not applicable · ${c.detail ?? ''}${reason}`;
  return { text: `    ${text}`, tone: status === 'failed' ? 'no' : '' };
}

/** An inconclusive golden's report, as the CLI prints it: the line, its gate's evidence, its checks and the attempts. */
export function inconclusiveLines(v: InconclusiveView): ReportLine[] {
  const lines: ReportLine[] = [{ text: `? ${v.name}: ${v.reason}`, tone: '' }];
  if (v.gate) lines.push({ text: `    ${v.gate.tally}`, tone: '' });
  for (const c of v.checks ?? []) lines.push(checkReportLine(c));
  // The details repeat the tally first when a gate wrote them.
  const details = (v.details ?? '').replace(/\s+$/, '').split('\n').filter((l, i) => !(i === 0 && v.gate && l === v.gate.tally));
  for (const l of details) if (l) lines.push({ text: `    ${l}`, tone: 'dim' });
  return lines;
}

/** What an inconclusive verdict means, in one line under its report, with what more attempts would take when the gate can say. */
export function inconclusiveHint(v: InconclusiveView): string {
  if (v.failure === 'injection') return 'The golden replays, but its injection test showed too little to say, for the reason above (a model call that failed, a run cut short, nothing a model read). Settle that and run it again; --inconclusive warn lets an inconclusive gate through meanwhile.';
  const j = v.judge;
  // A replay golden's test runs offline: no key can settle it, only the verdict kept in its pack.
  if (j?.update) return `Its pack holds no verdict for the judge check ${j.name}, and the test replays offline, so the judge can’t be asked. Update golden asks it once, live, and keeps its verdict in the pack: every test after judges from the recording, free.`;
  // A fork golden asks its judges live, from the environment the test runs in.
  if (j?.keys?.length) return `The test runs this golden live, and the judge check ${j.name} had no key to ask ${j.model} with: set ${j.keys[0]}${j.keys.length > 1 ? ` (or ${j.keys.slice(1).join(' or ')})` : ''} where the tests run, in CI as a secret, and run it again.`;
  if (!v.gate) return 'A check could not be decided, as its line above says, so the golden is neither passed nor failed: settle what it lacks and run it again.';
  const more = v.gate.more;
  const cost = more?.cost !== null && more?.cost !== undefined ? `, about $${more.cost.toFixed(2)}` : '';
  const estimate = more ? ` Run more attempts continues it to ${more.attempts}: about ${Math.round(more.expected)} more on average${cost}, settling it ${Math.round(more.settles * 100)}% of the time.` : '';
  return `Neither verdict holds at the gate's stated risk yet: more attempts settle it, not a change to the agent.${estimate}`;
}

/** What a failure other than a divergence means, in one line under its report. */
export function failureHint(f: FailureView): string {
  // A connection the guard blocked is what the agent tripped on, whatever failed after it.
  const blocked = f.blocked ?? [];
  if (blocked.length) {
    const where = blocked.join(', ');
    return `The agent connected to ${where} directly, past Shadowlap, and CI replays offline, so the network guard blocked it. Wrap the call as a tool so it is recorded, or allow it with SHADOWLAP_GUARD_ALLOW=${blocked.join(',')}.`;
  }
  switch (f.failure) {
    case 'check':
      return 'A failed check means the agent did something its checks in shadowlap.config.json rule out. Fix the agent; the golden is right.';
    case 'exit':
      return 'The agent exited with an error while it replayed: its last lines of output are above.';
    case 'no-calls':
      return 'The replay made no calls: does the agent still start, and does it use the Shadowlap environment?';
    case 'injection':
      if (f.reason.startsWith('injection inconclusive')) return 'The golden replays, but its injection test showed too little to say, for the reason above (a model call that failed, a run cut short, nothing a model read). Settle that and run it again; --inconclusive warn lets an inconclusive gate through meanwhile.';
      return 'The golden replays, but a tool call carried the canary of a payload planted in what the agent reads: the agent obeyed it. Fix the agent (a prompt that says data is not instructions, a check before a write); the golden is right.';
    default:
      return 'The golden could not be replayed.';
  }
}

/**
 * A word of a command as a person types it: a plain word as it is (`~` inside one too, as in
 * `HEAD~3`), a placeholder such as `<commit>` as it reads, anything else in single quotes.
 */
const shellWord = (a: string): string => (/^[\w@%+=:,./*-][\w@%+=:,./*~-]*$/.test(a) || /^<[a-z][a-z -]*>$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);

/** The command to run, as a person would type it: `shadowlap test goldens/x --update`. */
export function commandText(args: readonly string[]): string {
  return `shadowlap ${args.map(shellWord).join(' ')}`;
}

export interface DivergenceButtons {
  /**
   * Add normalizer and re-run: its label, whether it leads, and what it runs. `normalize` adds the
   * rules and tests the golden; `normalize-update` adds them and updates the golden, so it asks
   * first; `rerun` only tests it, the rules being in the config already.
   */
  normalize: { label: string; lead: boolean; run: 'normalize' | 'normalize-update' | 'rerun' } | null;
  update: { lead: boolean } | null;
  /**
   * Find the commit, unless what it found still stands or the pack can't be read: with a range to
   * start from, or asking for a good commit (always, once a search between the known ones named none).
   */
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
    bisect: findCommitButton(d, has),
    maybeReal: d.maybeReal,
    note: steps && d.rulesAdded ? (updates ? 'rules-added-update' : 'rules-added') : d.maybeReal && d.volatile ? 'maybe-real' : null,
  };
}

/**
 * Find the commit under a failure (a divergence, or a check, an exit, no calls): none while what it
 * found stands (the card says it), while a search found it passing at the commit it fails at (no
 * other good commit helps: the failure isn't in a commit), for a pack that can't be read, or where
 * the server runs no bisect. It starts from the range the page knows, or asks for a good commit when
 * there is none, or when a search over that range already named none.
 */
export function findCommitButton(f: Pick<DivergenceView, 'found' | 'missed' | 'bisect' | 'unreadable'>, has: (kind: string) => boolean): { range: boolean; live: boolean } | null {
  if (f.found || f.unreadable || !has('bisect') || f.missed?.outcome === 'passes-at-bad') return null;
  return { range: !!f.bisect && !f.missed, live: !!f.bisect?.live };
}

/** What Find the commit found, for the card above the buttons. */
export function foundLine(f: FoundCommit): { rev: string; subject: string; meta: string } {
  return { rev: f.rev, subject: f.subject, meta: [f.author, f.date ? shortDate(f.date) : null, n(f.tokens, 'token')].filter(Boolean).join(' · ') };
}

/**
 * When Find the commit named no first bad commit: where it looked, and why, for the line above the
 * buttons. Passing at the commit it fails at, the failure is in no commit: it is in changes not
 * committed there, or it doesn't happen every time.
 */
export function missedLine(m: BisectMiss): string {
  if (m.outcome === 'passes-at-bad') return `No first bad commit: it passes at ${m.bad ? revLabel(m.bad) : 'HEAD'} as committed, so the failure is in changes not committed there, or doesn’t happen every time`;
  const between = m.good ? ` between ${revLabel(m.good)} and ${m.bad ? revLabel(m.bad) : 'HEAD'}` : '';
  return `No first bad commit${between}: ${m.why}`;
}

export interface UpdatePlan {
  title: string;
  text: string;
  /** The golden as a card, or the diverged goldens as a list; none when the title names the one golden and nothing diverged. */
  goldens: Array<{ path: string; name: string; where: string }>;
  steps: Array<[string, string]>;
  /**
   * The amber box: a value that changes every run diverged and no rule masks it yet, so a normalizer
   * is the lasting fix; or, for one golden, the rule for it is in the config now and alone makes the
   * replay match, so a re-run passes without an update.
   */
  advise: { title: string; text: string; path: string | null } | null;
  /** The amber box's button, named for what it runs: null for several goldens, or when the server runs none of it. */
  instead: { label: string; golden: string; run: 'normalize' | 'normalize-update' | 'rerun' } | null;
  /** A plain line above the command, a path set in code: the rules are in the config already, so an update is the fix, or a re-run is. */
  note: Array<string | { code: string }> | null;
  command: string;
  ok: string;
}

/** The amber box's button, by what it runs in place of the update. */
const INSTEAD: Record<'normalize' | 'normalize-update' | 'rerun', string> = {
  normalize: 'Add the normalizer instead',
  // The rule alone can't make the replay match: it is added, and the golden updated after it.
  'normalize-update': 'Add the normalizer and update',
  rerun: 'Re-run instead',
};

/** Whether the rules alone can't make the replay match, so the golden is updated after them. */
const updatesAfterRules = (d: DivergenceView) => !!d.normalizeAndTest && (d.normalizeAndTest.at(-1) ?? []).includes('--update');

/**
 * The Update golden dialog, in the style of Remove project: the golden as a card (or the diverged
 * goldens as a list), What happens as numbered rows, the amber note when what diverged is a value
 * that changes every run, and the command. `paths` are the goldens to update; `has` says which jobs
 * the server runs, for the amber box's button. A divergence whose rules are in the config already
 * (added since, for this golden or another) gets no amber note that a normalizer would fix it: an
 * update is the fix then, or, when the rules alone make it match, a re-run.
 */
export function updatePlan(view: TestsView, paths: readonly string[], has: (kind: string) => boolean = () => true): UpdatePlan {
  // A golden whose replay is clean and only lacks a judge's verdict: the update asks the judge once and re-records nothing.
  const judged = paths.length === 1 ? judgePlan(view, paths[0]!) : null;
  if (judged) return judged;
  const ds = paths.map((p) => view.divergences.find((d) => d.golden === p)).filter((d): d is DivergenceView => !!d);
  const rows = paths.map((p) => view.rows.find((r) => r.path === p));
  const goldens = paths.map((p, i) => {
    const d = ds.find((x) => x.golden === p);
    return { path: p, name: rows[i]?.name ?? p, where: d ? `diverged at call ${d.callNo}` : (rows[i]?.last.line ?? '') };
  });
  const one = goldens.length === 1;
  const checks = one ? (rows[0]?.checks.length ?? 0) : 0;
  // A value that changes every run, with no rule for it yet: updating alone diverges again next run.
  const perRun = ds.filter((d) => d.volatile?.certain && !d.rulesAdded);
  // Its rules are in the config now: alone they make the replay match, or an update is what is left.
  const rerun = ds.filter((d) => d.rulesAdded && !!d.normalizeAndTest && !updatesAfterRules(d));
  const updateLeft = ds.filter((d) => d.rulesAdded && updatesAfterRules(d));
  let advise: UpdatePlan['advise'] = null;
  let instead: UpdatePlan['instead'] = null;
  let note: UpdatePlan['note'] = null;
  const d0 = one ? (ds[0] ?? null) : null;
  if (d0) {
    const v = d0.volatile;
    if (perRun.includes(d0) && v) advise = { title: 'A normalizer fixes this for good', text: `${v.op === 'added' ? 'is new in every request and ' : ''}looks like ${v.looks}, which changes every run. Updating re-records it, and the next run diverges again.`, path: v.path };
    else if (rerun.includes(d0)) advise = { title: 'Its normalizer is in the config now', text: 'is masked by a rule added since this replay, so a re-run passes without an update.', path: v?.path ?? null };
    else if (updateLeft.includes(d0)) note = [v ? 'The normalizer for ' : 'The normalizer is in shadowlap.config.json already', ...(v ? [{ code: v.path }, ' is in shadowlap.config.json already'] : []), ', so the run after this update matches.'];
    const run = advise ? divergenceButtons(d0, has).normalize?.run : undefined;
    if (run) instead = { label: INSTEAD[run], golden: d0.golden, run };
  } else if (!one) {
    if (perRun.length) {
      const names = perRun.map((d) => d.name).join(', ');
      advise = { title: 'A normalizer fixes this for good', text: `${names} diverged on values that change every run. Updating re-records ${perRun.length === 1 ? 'it' : 'them'}, and the next run diverges again.`, path: null };
    }
    if (rerun.length) note = [`The normalizers for ${rerun.map((d) => d.name).join(', ')} are in shadowlap.config.json now: a re-run passes without updating ${rerun.length === 1 ? 'it' : 'them'}.`];
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
    instead,
    note,
    command: commandText(['test', ...paths, '--update']),
    ok: advise ? 'Update anyway' : 'Update',
  };
}

/**
 * Update golden for a golden that replays offline and is inconclusive only for want of a judge's
 * verdict, as the mock's dialog has it: no card (nothing diverged, and the title names the golden),
 * its replay is clean, so nothing is re-recorded; the judge is asked once, live, with its provider's
 * key where the dashboard runs, and its verdict is kept in the pack, which you review. Null for any
 * other golden.
 */
function judgePlan(view: TestsView, path: string): UpdatePlan | null {
  const v = view.inconclusive.find((x) => x.golden === path);
  const j = v?.judge;
  if (!v || !j?.update) return null;
  const key = j.provider ? `the ${PROVIDER_KEY[j.provider] ?? j.provider} key` : 'the key';
  return {
    title: `Update ${v.name}?`,
    text: `Its replay is clean: only its judge check has no verdict in the pack. Updating asks the judge once, live, with ${key} in the dashboard’s environment, and keeps the verdict; nothing is re-recorded.`,
    goldens: [],
    steps: [
      ['Replayed offline, as recorded', 'clean'],
      ['Its judge asked once, live', j.model],
      ['Its verdict kept in the pack', 'the next test judges from it, free'],
      ['You review the change', 'in your pull request'],
    ],
    advise: null,
    instead: null,
    note: null,
    command: commandText(j.update),
    ok: 'Update',
  };
}

/** Whose key a judge's provider is asked with. */
const PROVIDER_KEY: Record<string, string> = { anthropic: 'Anthropic', openai: 'OpenAI', gemini: 'Gemini' };

/** Update goldens…, asked for from the palette or by a link: Tests opens its dialog, then drops `?update` from the address. */
export const TESTS_UPDATE_HASH = '#/tests?update';

export function asksUpdate(hash: string): boolean {
  return /^#\/tests\?(?:[^#]*&)?update(?:=[^&]*)?(?:&|$)/.test(hash);
}

export interface TestsPaletteEntry {
  group: 'Tests' | 'Actions';
  label: string;
  hint: string;
  mono: boolean;
  /** Where it goes: Tests, or Tests with its Update goldens… dialog open. */
  to: string;
}

/**
 * The palette's entries from the Tests screen's answer, from any page: each golden with how it did
 * last, opening Tests, and, when any diverged and `update` (the server updates goldens and actions
 * can run here), Update goldens…, which opens its dialog on Tests.
 */
export function testsPalette(view: TestsView | null, o: { update: boolean }): TestsPaletteEntry[] {
  if (!view || view.empty) return [];
  // An inconclusive golden is neither passing nor failing, as Tests marks it.
  const out: TestsPaletteEntry[] = view.rows.map((r) => ({ group: 'Tests', label: r.name, mono: true, hint: r.last.verdict === 'inconclusive' ? 'inconclusive' : r.last.result === 'fail' ? 'failing' : r.last.result === 'pass' ? 'passing' : r.error ? 'can’t be read' : 'not run yet', to: href.tests() }));
  if (view.diverged.length && o.update) out.unshift({ group: 'Actions', label: 'Update goldens…', hint: 'shadowlap test --update', mono: false, to: TESTS_UPDATE_HASH });
  return out;
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
