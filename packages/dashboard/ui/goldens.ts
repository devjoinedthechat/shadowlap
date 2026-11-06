import { approx } from './format.js';
import { ACTIONS, confirmWords } from './labels.js';
import { rateBound } from '../../engine/src/stats.js';
import { twoDigits as pad } from '../../engine/src/words.js';
import { href } from './route.js';
import { noteText, UNGUARDED_FIX } from './run/note-words.js';
import type { BisectMiss, CiWorkflowOptions, DivergenceView, FailureView, FoundCommit, GoldenCheck, GoldenRow, InconclusiveView, TestsView } from './types.js';

/**
 * The Tests screen's words and choices, from the tests read model (`GET /api/tests`): the verdict's
 * line, a history cell's hover, the reports as the CLI prints them, which buttons a failure gets, and
 * what the Update golden dialog says. No DOM here: the tests import it.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Oct 1, 10:02, local time. */
export function dayClock(ms: number): string {
  const d = new Date(ms);
  return `${MONTHS[d.getMonth()]!} ${d.getDate()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Sep 30, from a date git or the store gives (ISO, or milliseconds); as given when it isn't one. */
export function shortDate(date: string | number): string {
  const ms = typeof date === 'number' ? date : Date.parse(date);
  if (!Number.isFinite(ms)) return String(date);
  const d = new Date(ms);
  return `${MONTHS[d.getMonth()]!} ${d.getDate()}`;
}

export const n = (count: number, word: string) => `${count.toLocaleString('en-US')} ${word}${count === 1 ? '' : 's'}`;

/**
 * The line under the verdict, all of it one session's: the newest that ran every golden (or runs
 * them now), its command, revision and time, its own passed and failed counts, and its upstream
 * requests; then, when goldens ran again since on their own (Add normalizer and re-run, Update
 * golden), how they did, with each one's result in `sinceTip`. A session that hasn't ended is
 * running while its process is (`live`, from the server, wherever it was started; `running`, a test
 * job of this tab's), and otherwise did not finish.
 */
export function sessionLine(view: { verdict: Pick<NonNullable<TestsView['verdict']>, 'session' | 'since'> | null }, running = false): { command: string; rest: string; since: string | null; sinceTip: string | null; live: boolean } | null {
  const v = view.verdict;
  if (!v) return null;
  const s = v.session;
  const live = s.endedAt === null && !s.interrupted && (s.live || running);
  // Inconclusive goldens count apart, as the verdict's badge counts them.
  const counts = `${s.passed} passed, ${s.failed} failed${s.inconclusive ? `, ${s.inconclusive} inconclusive` : ''}`;
  // While it runs: just now, so far, and no upstream requests, which a session counts as it ends; the verdict's word says it runs.
  const parts = [s.revision ? `rev ${s.revision}` : 'no revision', live ? 'just now' : dayClock(s.endedAt ?? s.startedAt), `${counts}${live ? ' so far' : ''}`, ...(live ? [] : [n(s.upstreamRequests, 'upstream request')])];
  if (s.interrupted) parts.push('interrupted');
  else if (s.endedAt === null && !live) parts.push('did not finish');
  const since = v.since ?? [];
  // Each as it came out: an inconclusive one is neither passed nor failed (a result from before verdicts reads by `ok`).
  const word = (x: (typeof since)[number]) => x.verdict ?? (x.ok ? 'passed' : 'failed');
  const failed = since.filter((x) => word(x) === 'failed').length;
  const unsure = since.filter((x) => word(x) === 'inconclusive').length;
  const notPassed = [failed ? `${failed} failed` : '', unsure ? `${unsure} inconclusive` : ''].filter(Boolean).join(', ');
  const sinceText = !since.length ? null : since.length === 1 ? `since: ${since[0]!.name} ${word(since[0]!)}` : `since: ${since.length} goldens ran again, ${notPassed || 'all passed'}`;
  const sinceTip = since.length ? since.map((x) => `${x.name} ${word(x)}${x.revision ? ` at ${x.revision}` : ''}, ${dayClock(x.at)}`).join(' · ') : null;
  return { command: s.command, rest: parts.join(' · '), since: sinceText, sinceTip, live };
}

/**
 * The jobs that replay or rewrite the goldens on disk, by what each is doing, as the server tells
 * them apart: while one runs in a project, another is refused there (409), so its button waits.
 * Find breaking commit counts when it searches a golden; on a run, it touches no golden.
 */
const TEST_FAMILY = new Map<string, string>([
  ['test', 'a test session'],
  ['test-update', 'an update of goldens'],
  ['normalize-and-test', 'a normalizer and its re-run'],
  ['pack-test', 'a new golden being packed and tested'],
  ['bisect', confirmWords(ACTIONS.findBreakingCommit.label).toLowerCase()],
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

/** A revision as the history's column names it: the short sha, with a + when it was tested with changes on top; `no rev` for none, never a dash. */
export function revLabel(rev: string | null): string {
  if (!rev) return 'no rev';
  const dirty = rev.endsWith('+dirty');
  const base = rev.replace(/\+dirty$/, '');
  return `${/^[0-9a-f]{8,}$/.test(base) ? base.slice(0, 7) : base.slice(0, 8)}${dirty ? '+' : ''}`;
}

/**
 * A check as the table names it, in the screen's words: `issue_refund never called`, `send_email
 * called once`, `input tokens ≤ 6,000`, `cost ≤ $0.02`. Any other label stays as the CLI wrote it,
 * as the reports under the table print them.
 */
export function checkWords(label: string): string {
  let m = /^(.+) called 0 times$/.exec(label);
  if (m) return `${m[1]!} never called`;
  m = /^(.+) called 1 time$/.exec(label);
  if (m) return `${m[1]!} called once`;
  m = /^at (most|least) (\d+) (input|output) tokens?$/.exec(label);
  if (m) return `${m[3]!} tokens ${m[1] === 'most' ? '≤' : '≥'} ${Number(m[2]).toLocaleString('en-US')}`;
  m = /^cost at (most|least) (\$[\d.]+)$/.exec(label);
  if (m) return `cost ${m[1] === 'most' ? '≤' : '≥'} ${m[2]!}`;
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
  /** The status in words, for a screen reader and the hover: `failed`, `not tested yet`. */
  word: string;
  /** The check, as the table names it. */
  text: string;
  /** A line under it: what failed and in how many attempts, why it couldn't be decided, where a judge's verdict came from, or that it was added since. */
  sub: string | null;
  /** The hover: the status and the check, and one row saying why. */
  tip: { title: string; label: string; value: string; color: string };
}

/**
 * A check in the table, marked by how the golden's last result came out on it: ✓ passed (a judge's,
 * where its verdict came from: the recording, free, or live, at what cost), ✗ failed (for a golden
 * run more than once, how many attempts passed it and what the others did), ? in amber when it
 * couldn't be decided (and why), – when it didn't apply, and no mark on a check not tested yet: before
 * a result exists, when the last test couldn't run the golden, or when it was added since, as the mock
 * says it. `ran`: the golden has a last result.
 */
export function checkMark(c: GoldenCheck, ran: boolean): CheckMarkView {
  const text = checkWords(c.label);
  const t = c.attempts;
  if (!c.status) {
    const word = 'not tested yet';
    const value = c.added ? 'Added to shadowlap.config.json since its last test: its next test judges it' : ran ? 'its last test couldn’t run the golden, so no check has a result' : 'its golden hasn’t run yet';
    return { mark: null, status: null, word, text, sub: c.added ? 'added since its last test' : null, tip: { title: `${word} · ${c.label}`, label: word, value, color: 'var(--line2)' } };
  }
  const word = STATUS_WORD[c.status];
  const detail = c.detail ?? '';
  let sub: string | null;
  let value: string;
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
    // A check over several attempts says how many passed it; a judge's verdict, where it came from.
    sub = t && t.passed < t.of ? `${t.passed} of ${t.of} attempts passed` : judgedLine(c);
    value = [c.reason ? `“${c.reason}”` : null, t ? (t.passed === t.of ? `passed in every attempt, ${t.of} of ${t.of}` : `passed in ${t.passed} of ${t.of} attempts`) : null].filter(Boolean).join(' · ') || 'passed';
  }
  return { mark: CHECK_MARK[c.status], status: c.status, word, text, sub, tip: { title: `${word} · ${c.label}`, label: word, value, color: STATUS_COLOR[c.status] } };
}

/**
 * Where a judge check's verdict came from, as the CLI's check line says it: from the recording, free,
 * or live, with what asking it cost when that is known (`judged live in 5 attempts · ≈$0.0021`). Null
 * for any other check.
 */
function judgedLine(c: GoldenCheck): string | null {
  if (c.source === 'recording') return 'judged from the recording · free';
  if (c.source !== 'live') return null;
  return c.live ? `judged live${c.live.asked > 1 ? ` in ${c.live.asked} attempts` : ''} · ${approx(c.live.cost)}` : 'judged live';
}

/** Where a golden came from: a run in this store, or a pack made elsewhere. */
export function sourceText(row: GoldenRow): { runId: string } | { text: string } {
  if (row.source.kind === 'run') return { runId: row.source.runId };
  return { text: row.source.packedAt ? `packed ${shortDate(row.source.packedAt)}` : 'a pack made elsewhere' };
}

/** A report line's colour: a failure red (`no`, `del`), what is sent now lime (`add`), what couldn't be decided amber (`y`), the rest quiet. */
export type ReportTone = '' | 'no' | 'del' | 'add' | 'dim' | 'y';

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
  // Failed in red, inconclusive in amber, as every report and page colours them.
  return { text: `    ${text}`, tone: status === 'failed' ? 'no' : status === 'inconclusive' ? 'y' : '' };
}

/** An inconclusive golden's report, as the CLI prints it: the line, its gate's evidence, its checks and the attempts. */
export function inconclusiveLines(v: InconclusiveView): ReportLine[] {
  const lines: ReportLine[] = [{ text: `? ${v.name}: ${v.reason}`, tone: 'y' }];
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
  // A replay golden's test runs offline: no key can settle it, only a verdict kept in its pack that answers what the replay asks.
  if (j?.update) {
    if (j.held === 'older') return `The verdict its pack holds for the judge check ${j.name} was given to an older form of the judge’s request, which a replay no longer sends, and the test replays offline, so the judge can’t be asked. Update golden asks it once, live, and keeps its verdict in the pack: every test after judges from the recording, free.`;
    // What the judge reads changed: a value made anew on every run changes it again, so its normalizer comes first.
    if (j.held === 'material') return `The verdict its pack holds for the judge check ${j.name} was given on other material than the replay reads now, as its line above says, and the test replays offline, so the judge can’t be asked. If what changed is a value that changes every run, such as an id the agent prints, a normalizer for it is the lasting fix: add it first, since a verdict on one run’s value answers no other, and the next test would read not judged again. Update golden then asks the judge once, live, and keeps its verdict in the pack.`;
    return `Its pack holds no verdict for the judge check ${j.name}, and the test replays offline, so the judge can’t be asked. Update golden asks it once, live, and keeps its verdict in the pack: every test after judges from the recording, free.`;
  }
  // A fork golden asks its judges live, from the environment the test runs in.
  if (j?.keys?.length) return `The test runs this golden live, and the judge check ${j.name} had no key to ask ${j.model} with: set ${j.keys[0]!}${j.keys.length > 1 ? ` (or ${j.keys.slice(1).join(' or ')})` : ''} where the tests run, in CI as a secret, and run it again.`;
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
    case 'guard':
      // A process ran that the guard can't watch (the Claude Code CLI): what shadowlap doctor says to do about it.
      if (/^The network guard could not watch every process of the agent/.test(f.reason)) return `A process the network guard can’t watch ran while the golden replayed, and under --guard block that fails it, whatever else the replay did: the line above says which. ${noteText(UNGUARDED_FIX)}`;
      // Under --guard block, a replay no preload loaded in proves nothing, whatever else came out of it.
      return 'No Shadowlap preload loaded in the agent’s processes while the golden replayed, so the network guard never watched it, and under --guard block that fails it, whatever else the replay did: the line above says what the command shows of why. Run the agent on Node or Python with the environment shadowlap gives it (shadowlap doctor says what keeps a preload from loading), or test with --guard warn to let a replay the guard can’t watch through.';
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
   * Find breaking commit, unless what it found still stands or the pack can't be read: with a range to
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
  else if (steps && has('normalize-and-test')) normalize = updates ? { label: ACTIONS.addNormalizerAndUpdate.label, lead, run: 'normalize-update' } : { label: ACTIONS.addNormalizerAndRerun.label, lead, run: 'normalize' };
  return {
    normalize,
    update: has('test-update') ? { lead: false } : null,
    bisect: findCommitButton(d, has),
    maybeReal: d.maybeReal,
    note: steps && d.rulesAdded ? (updates ? 'rules-added-update' : 'rules-added') : d.maybeReal && d.volatile ? 'maybe-real' : null,
  };
}

/**
 * Find breaking commit under a failure (a divergence, or a check, an exit, no calls): none while what it
 * found stands (the card says it), while a search found it passing at the commit it fails at (no
 * other good commit helps: the failure isn't in a commit), for a pack that can't be read, or where
 * the server runs no bisect. It starts from the range the page knows, or asks for a good commit when
 * there is none, or when a search over that range already named none.
 */
export function findCommitButton(f: Pick<DivergenceView, 'found' | 'missed' | 'bisect' | 'unreadable'>, has: (kind: string) => boolean): { range: boolean; live: boolean } | null {
  if (f.found || f.unreadable || !has('bisect') || f.missed?.outcome === 'passes-at-bad') return null;
  return { range: !!f.bisect && !f.missed, live: !!f.bisect?.live };
}

/** What Find breaking commit found, for the card above the buttons. */
export function foundLine(f: FoundCommit): { rev: string; subject: string; meta: string } {
  return { rev: f.rev, subject: f.subject, meta: [f.author, f.date ? shortDate(f.date) : null, n(f.tokens, 'token')].filter(Boolean).join(' · ') };
}

/**
 * When Find breaking commit named no first bad commit: where it looked, and why, for the line above the
 * buttons. Passing at the commit it fails at, the failure is in no commit: it is in changes not
 * committed there, or it doesn't happen every time.
 */
export function missedLine(m: BisectMiss): string {
  if (m.outcome === 'passes-at-bad') return `No first bad commit: it passes at ${m.bad ? revLabel(m.bad) : 'HEAD'} as committed, so the failure is in changes not committed there, or doesn’t happen every time`;
  const between = m.good ? ` between ${revLabel(m.good)} and ${m.bad ? revLabel(m.bad) : 'HEAD'}` : '';
  return `No first bad commit${between}: ${m.why}`;
}

/** Update goldens, asked for from the palette or by a link: Tests opens its dialog, then drops `?update` from the address. */
export const TESTS_UPDATE_HASH = '#/tests?update';

export function asksUpdate(hash: string): boolean {
  return /^#\/tests\?(?:[^#]*&)?update(?:=[^&]*)?(?:&|$)/.test(hash);
}

export interface TestsPaletteEntry {
  group: 'Tests' | 'Actions';
  label: string;
  hint: string;
  mono: boolean;
  /** Update goldens: it opens what starts a job, paused while the server can't be reached. */
  job?: boolean;
  /** Where it goes: Tests, or Tests with its Update goldens dialog open. */
  to: string;
}

/**
 * A golden's hint in the palette, in the verdict words Tests uses (decision 9): passed, failed or
 * inconclusive, and for a gate's verdict its tally and Wilson bound ("passed · 12 of 12 · rate >=
 * 0.76 (95%)"); with no result, why its pack can't be read, how its error-path presets came out
 * when only they ran ("presets failed"), or not run yet.
 */
export function goldenHint(r: Pick<GoldenRow, 'last' | 'error' | 'presets'>): string {
  const verdict = r.last.verdict ?? (r.last.result === 'pass' ? 'passed' : r.last.result === 'fail' ? 'failed' : null);
  if (!verdict) return r.error ? 'can’t be read' : r.presets ? `presets ${r.presets.verdict}` : 'not run yet';
  const g = r.last.gate;
  if (!g || g.attempts === 0) return verdict;
  if (g.clean) return `${verdict} · a clean replay`;
  return [verdict, `${g.passes} of ${g.attempts}`, rateBound(g)].filter(Boolean).join(' · ');
}

/**
 * The palette's entries from the Tests screen's answer, from any page: each golden with how it did
 * last, opening Tests, and, when any diverged and `update` (the server updates goldens and actions
 * can run here), Update goldens, which opens its dialog on Tests.
 */
export function testsPalette(view: TestsView | null, o: { update: boolean }): TestsPaletteEntry[] {
  if (!view || view.empty) return [];
  // An inconclusive golden neither passed nor failed, as Tests marks it.
  const out: TestsPaletteEntry[] = view.rows.map((r) => ({ group: 'Tests', label: r.name, mono: true, hint: goldenHint(r), to: href.tests() }));
  if (view.diverged.length && o.update) out.unshift({ group: 'Actions', label: ACTIONS.updateGoldens.label, hint: 'shadowlap test --update', mono: false, job: true, to: TESTS_UPDATE_HASH });
  return out;
}

/** Settings → CI's options as `/api/ci/workflows` takes them in its query string; those left out take the server's defaults. */
export function ciQuery(o: Partial<CiWorkflowOptions> = {}): string {
  const q = new URLSearchParams();
  if (o.fix !== undefined) q.set('fix', o.fix ? 'on' : 'off');
  if (o.alerts !== undefined) q.set('alerts', o.alerts ? 'on' : 'off');
  if (o.budget !== undefined) q.set('budget', o.budget);
  if (o.repairer !== undefined) q.set('repairer', o.repairer);
  if (o.onlyMain !== undefined) q.set('onlyMain', o.onlyMain ? 'on' : 'off');
  if (o.secret !== undefined) q.set('secret', o.secret);
  if (o.inconclusive !== undefined) q.set('inconclusive', o.inconclusive);
  const text = q.toString();
  return text ? `?${text}` : '';
}
