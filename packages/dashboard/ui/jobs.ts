import type { FactWords } from './actions.js';
import { isObject } from '../../engine/src/is-object.js';
import { fixJobStatus } from './fixes/model.js';
import { jobEnding, type JobWords } from './job-ending.js';
import { isPlainReplay, jobTitle, ownArgs, type JobChipView, type JobLike, type RunningJob } from './job-title.js';
import { doneWords, type JobEnd } from './labels.js';
import { cutClean } from './format.js';

export { afterPollError, draftCommand, isPlainReplay, jobCommand, jobRunning, jobTitle, quoteArg, type AfterPollError, type JobLike, type RunningJob } from './job-title.js';

/**
 * What the job drawer says about a CLI run the dashboard started: how each output line is coloured,
 * and how it ended. It loads with the drawer; what the first look needs of a job is `job-title.ts`'s.
 * No DOM here: the tests import it.
 */

export type LineTone = '' | 'p' | 'ok' | 'y' | 'no' | 'dim';

/** How the drawer colours an output line, from the marks the CLI prints. */
export function lineTone(line: string): LineTone {
  const t = line.trimStart();
  if (t.startsWith('$ ')) return 'p';
  if (/^(✓|●)/.test(t)) return 'ok';
  if (/^(✗|error\b|Error\b)/.test(t)) return 'no';
  // `?` an inconclusive golden, `–` a check that doesn't apply.
  if (/^(⑂|⚠|!|\? |warning\b)/.test(t)) return 'y';
  if (t.startsWith('– ')) return 'dim';
  // Training: a `tasks score` attempt that missed a check ("3 · ✓ … · ✗ … · 0.33"), as the mock marks it.
  if (/^\d+ · /.test(t) && t.includes('✗')) return 'y';
  return '';
}

/**
 * Where a Replay stopped matching its recording, from the CLI's report: the call it names ("✗
 * Diverged at call 3 (api POST /v1/messages)…"), and whether the replay went on live from there
 * ("⑂ Forked at call 3: 2 calls replayed, then 22 live…"), as `replay` does. Null while it runs,
 * for a replay that stayed clean, and for every other job: a fork diverges where its flag changed
 * the run, which is what it was asked for.
 */
export function replayDivergence(job: JobLike, lines: readonly string[]): { callNo: number; live: boolean } | null {
  if (!job.done || !isPlainReplay(job)) return null;
  return divergedAt(lines);
}

/** Where a replay's report says it left the recording, and whether it went on live from there. */
function divergedAt(lines: readonly string[]): { callNo: number; live: boolean } | null {
  const all = lines.join('\n');
  const at = [...all.matchAll(/^\s*(?:✗\s*)?Diverged at call (\d+)/gm)].at(-1) ?? [...all.matchAll(/^\s*(?:⑂\s*)?Forked at call (\d+)/gm)].at(-1);
  if (!at) return null;
  return { callNo: Number(at[1]), live: /^\s*(?:⑂\s*)?Forked at call \d+/m.test(all) };
}

/** What a fork's flag changes, in the drawer's words. */
const FORK_WORDS: Record<string, string> = {
  '--inject': 'the inject',
  '--override': 'the override',
  '--fail-at': 'the failure',
  '--inject-result': 'the planted instruction',
  '--model': 'the model switch',
  '--set': 'the setting',
  '--prompt-from': 'the changed prompt',
  '--diverge-at': 'the fork',
};

/**
 * The first call a fork's flags act on, as the run it forks numbers it, and that flag: `--inject
 * 17=…` acts on #17, `--model 15:claude-opus-5` from #15, `--fail-at=19=529` on #19. Null when no
 * flag names a call: `--live-tool`, `--live-input`, a `--model` or `--set` for every call.
 */
export function forkTarget(args: readonly string[]): { callNo: number; flag: string } | null {
  const own = ownArgs(args);
  let first: { callNo: number; flag: string } | null = null;
  for (let i = 0; i < own.length; i++) {
    const arg = own[i]!;
    const eq = arg.indexOf('=');
    const flag = eq < 0 ? arg : arg.slice(0, eq);
    if (!(flag in FORK_WORDS)) continue;
    const m = /^(\d+)(?:[=:]|$)/.exec((eq < 0 ? own[i + 1] : arg.slice(eq + 1)) ?? '');
    if (m && (!first || Number(m[1]) < first.callNo)) first = { callNo: Number(m[1]), flag };
  }
  return first;
}

/**
 * A fork that left the recording before the call its flag acts on: the calls before that one didn't
 * replay (a value made anew on every run, a change in the code), so the run went live early and
 * what the flag changed is not the only difference. The drawer says so, as it does for a Replay,
 * instead of "forked". Null while it runs, for a fork that left the recording where its flag acted
 * (or after, for a tool result the next model call reads), and for every other job.
 */
export function forkDivergedEarly(job: JobLike, lines: readonly string[]): { callNo: number; live: boolean; target: { callNo: number; flag: string } } | null {
  const own = ownArgs(job.args);
  if (!job.done || own[0] !== 'replay' || own.includes('--repeat') || isPlainReplay(job)) return null;
  const target = forkTarget(job.args);
  const at = target ? divergedAt(lines) : null;
  return target && at && at.callNo < target.callNo ? { ...at, target } : null;
}

/**
 * A Replay or a fork that stopped before its recording did, from the CLI's report ("✗ Ended early at
 * call 11: 10 of 30 recorded calls replayed"): the recording's first call it never made, and a fork's
 * flag that acts there or after, which never got to change the run. Null while it runs, for one that
 * left its recording otherwise, and for a repeat, whose attempts say where each ended.
 */
export function replayEndedEarly(job: JobLike, lines: readonly string[]): { callNo: number; target: { callNo: number; flag: string } | null } | null {
  const own = ownArgs(job.args);
  if (!job.done || own[0] !== 'replay' || own.includes('--repeat')) return null;
  const at = [...lines.join('\n').matchAll(/^\s*(?:✗\s*)?Ended early at call (\d+)/gm)].at(-1);
  if (!at) return null;
  const callNo = Number(at[1]);
  const target = forkTarget(job.args);
  return { callNo, target: target && target.callNo >= callNo ? target : null };
}

/** The line `replay` ends a replay that made no call with, and `run` a recording (engine report.ts `formatSummary`). */
const NO_CALLS = /^\s*(?:⚠\s*)?(?:Recorded|Replayed) \S+: no calls were made/m;

/** The line `run` ends a recording that holds calls with, and how many (engine report.ts `formatSummary`). */
const RECORDED = /^\s*(?:●\s*)?Recorded \S+: (\d+) calls/m;

/** The line a replay's summary says the agent's own failure with: what its exit code is then. */
const AGENT_FAILED = /the agent process exited with an error/;

/** Amber where the agent ended well (0; 3, a check that could not be decided), red where it didn't. */
const agentTone = (code: number): JobWords['tone'] => (code === 0 || code === 3 ? 'warn' : 'err');

/**
 * How a Replay or a fork left its recording, which leads its status whatever the agent did after: it
 * made no call at all; a Replay diverged, and went live, or ended early; a fork left it, or stopped,
 * before the call its flag acts on, or ended early. Null where it left it nowhere it wasn't asked to.
 */
function leftStatus(job: JobLike, lines: readonly string[], code: number): JobWords | null {
  const exit = `exit ${code}`;
  const own = ownArgs(job.args);
  if (own[0] === 'replay' && !own.includes('--repeat') && NO_CALLS.test(lines.join('\n'))) return { text: `no calls were made · ${exit}`, tone: agentTone(code) };
  const diverged = replayDivergence(job, lines);
  if (diverged) return { text: `diverged at #${diverged.callNo}${diverged.live ? ' · went live' : ''} · ${exit}`, tone: agentTone(code) };
  const early = forkDivergedEarly(job, lines);
  if (early) return { text: `diverged at #${early.callNo}, before ${FORK_WORDS[early.target.flag]!} at #${early.target.callNo}${early.live ? ' · went live' : ''} · ${exit}`, tone: agentTone(code) };
  const ended = replayEndedEarly(job, lines);
  return ended ? { text: `ended early at #${ended.callNo}${ended.target ? `, before ${FORK_WORDS[ended.target.flag]!} at #${ended.target.callNo}` : ''} · ${exit}`, tone: agentTone(code) } : null;
}

/** A run as the run list has it: enough to walk from a replay to the recording it came from. */
export type RunLink = { runId: string; parentRunId: string | null; mode: string; status: string; imported: boolean };

/**
 * The recording Calibrate replays after a Replay diverged: the run replayed when it is a recording,
 * else the recording its replays came from. Null when there is none Calibrate takes: a capture or a
 * pack's run (no command recorded here), one that didn't end, or one this list doesn't have. The
 * server's calibrate job checks again.
 */
export function calibrationTarget(runId: string | null | undefined, runs: readonly RunLink[]): string | null {
  const byId = new Map(runs.map((r) => [r.runId, r]));
  let r = runId ? byId.get(runId) : undefined;
  for (let hops = 0; r && r.mode !== 'record' && hops < 100; hops++) r = r.parentRunId ? byId.get(r.parentRunId) : undefined;
  if (!r || r.mode !== 'record' || r.imported) return null;
  return r.status === 'completed' || r.status === 'failed' ? r.runId : null;
}

/**
 * A replay the CLI refused before anything ran, as every command that replays a run does when its
 * model called a tool Shadowlap never recorded that writes, or may (its effect unknown): what the
 * tool does, in the CLI's words (`an unrecorded tool may write`). A fix's rerun carries no
 * --allow-unrecorded, so its job ends here, the CLI's lines after it saying how to run it.
 */
export function unrecordedRefused(lines: readonly string[]): string | null {
  for (const l of lines) {
    const m = /holds model calls of (a tool|tools) Shadowlap never recorded, which (writes|write, or may|may write|write):/.exec(l);
    if (m) return `${m[1] === 'a tool' ? 'an unrecorded tool' : 'unrecorded tools'} ${m[2]!}`;
  }
  return null;
}

const count = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

/**
 * How a recording ended, from what `run` prints: the calls it holds, and that its agent failed where
 * it did, the run holding that failure; none made, in amber, as `run` warns. Null for any other job,
 * and for a recording that held nothing to say so (its command never started), whose exit code
 * says it.
 */
function recordedStatus(job: JobLike, lines: readonly string[], code: number): JobWords | null {
  if (ownArgs(job.args)[0] !== 'run') return null;
  const all = lines.join('\n');
  const exit = `exit ${code}`;
  if (NO_CALLS.test(all)) return { text: `no calls were made · ${exit}`, tone: agentTone(code) };
  const held = RECORDED.exec(all);
  if (!held) return null;
  const calls = count(Number(held[1]), 'call');
  if (code === 0) return { text: `${calls} · ${exit}`, tone: 'ok' };
  return AGENT_FAILED.test(all) ? { text: `${calls} · agent exited ${code}`, tone: 'warn' } : null;
}

/**
 * The run a recording is making, for its drawer's Watch live while it records (the run's page, where
 * its calls arrive, as the setup's Record step offers it), once the CLI has named it. Null for any
 * other job, and once it ended, when Open run takes its place.
 */
export function recordingLive(job: Pick<JobLike, 'done' | 'args' | 'kind'> & { newRunId?: string | null }): string | null {
  return !job.done && ownArgs(job.args)[0] === 'run' && job.newRunId ? job.newRunId : null;
}

/**
 * How a Training job ended, in the job drawer's status line, from the result it reports: Score a model
 * by the tasks it scored (`scored · mean 0.87`; `3 of 4 tasks scored` when a golden no longer replays
 * up to its takeover or was skipped; `nothing scored`), Export pairs by the pairs it wrote. Null for
 * other jobs, or one that sent no result: the drawer then reads the CLI's words.
 */
export function trainingJobStatus(job: { kind?: string; code: number | null; result?: unknown }): { text: string; tone: 'ok' | 'warn' | 'err' } | null {
  const r = job.result;
  if (job.code === null || !isObject(r)) return null;
  const exit = `exit ${job.code}`;
  if (job.kind === 'score') {
    const tasks = Array.isArray(r.tasks) ? r.tasks.filter(isObject) : [];
    const total = tasks.length + (Array.isArray(r.skipped) ? r.skipped.length : 0);
    const scored = tasks.filter((t) => Array.isArray(t.attempts) && t.attempts.length > 0).length;
    if (typeof r.mean !== 'number' || !scored) return { text: `nothing scored · ${exit}`, tone: 'err' };
    if (job.code === 0 && scored === total) return { text: `scored · mean ${r.mean.toFixed(2)} · ${exit}`, tone: 'ok' };
    return { text: `${scored} of ${count(total, 'task')} scored · ${exit}`, tone: 'warn' };
  }
  if (job.kind === 'pairs' && typeof r.pairs === 'number') {
    return r.pairs ? { text: `${count(r.pairs, 'pair')} written · ${exit}`, tone: job.code === 0 ? 'ok' : 'err' } : { text: `nothing exported · ${exit}`, tone: 'warn' };
  }
  return null;
}

/**
 * A Revert stopped on request once git had reverted the commit, or left conflicts: its status says
 * what is in your working tree, as one that ended on its own does, never only that it stopped.
 */
const leftInTree = (job: JobLike): boolean => job.kind === 'revert' && (job.git === 'done' || job.git === 'conflicts');

/** Stopped on request: that is how it ended, whatever its exit code says, after what a Revert left in your working tree. */
function stoppedStatus(job: JobLike): JobWords {
  const exit = job.code === null ? '' : ` · exit ${job.code}`;
  if (job.kind === 'revert' && job.git === 'done') return { text: `reverted · test stopped${exit}`, tone: 'warn' };
  if (job.kind === 'revert' && job.git === 'conflicts') return { text: `conflicts left in your working tree · stopped${exit}`, tone: 'err' };
  return { text: `stopped${exit}`, tone: 'warn' };
}

/**
 * How a job ended, in the drawer's status line: the outcome first, then the exit code. Worked out
 * from the CLI's own words when the server sends no structured result.
 */
export function jobStatus(job: JobLike, lines: readonly string[], lost = false): JobWords {
  if (lost && !job.done) return { text: 'lost · the dashboard server no longer has this job', tone: 'err' };
  if (!job.done) return { text: job.stopped ? 'stopping' : 'running', tone: '' };
  if (job.stopped) return stoppedStatus(job);
  // Blame, repair and fix apply say how they came out in their result.
  const fixes = fixJobStatus(job);
  if (fixes) return fixes;
  // So do Score a model and Export pairs (Training).
  const training = trainingJobStatus(job);
  if (training) return training;
  const all = lines.join('\n');
  const code = job.code;
  // Killed from outside, by a signal it never got to answer: it stopped before it ended, as a run its
  // recorder left is interrupted, though nobody asked it to.
  if (code === null) return { text: 'interrupted', tone: 'warn' };
  const exit = `exit ${code}`;
  // A Replay that didn't reproduce the run, or a fork that left it before its flag acted, whatever the
  // agent did after (leftStatus); a recording, the calls it holds (recordedStatus).
  const left = leftStatus(job, lines, code) ?? recordedStatus(job, lines, code);
  if (left) return left;
  // A session, an update, a search, a verify or a repeat: in the words of its kind.
  const ending = jobEnding(job, all, code);
  if (ending) return ending;
  // Refused before it ran anything: why, never a bare exit code.
  const refused = code !== 0 ? unrecordedRefused(lines) : null;
  if (refused) return { text: `refused · ${refused} · ${exit}`, tone: 'err' };
  if (code === 0) {
    if (/check(s)? passed/i.test(all)) return { text: `check passed · ${exit}`, tone: 'ok' };
    if (/Replay clean|Reproduced exactly/.test(all)) return { text: `reproduced · ${exit}`, tone: 'ok' };
    if (/Forked at call/.test(all)) return { text: `forked · ${exit}`, tone: 'ok' };
    return { text: `finished · ${exit}`, tone: 'ok' };
  }
  if (/check(s)? failed/i.test(all)) return { text: `check failed · ${exit}`, tone: 'err' };
  // A Replay or a fork ends 3 on a check that could not be decided, its agent having ended well.
  if (code === 3 && ownArgs(job.args)[0] === 'replay' && !AGENT_FAILED.test(all)) return { text: `inconclusive · ${exit}`, tone: 'warn' };
  if (/Diverged at call/.test(all) && !/Forked at call/.test(all)) return { text: `diverged · ${exit}`, tone: 'err' };
  // The agent's own exit, as a replay's summary says it (after a failure --fail-at played in, say); never a command the CLI refused before it ran.
  if (AGENT_FAILED.test(all)) return { text: `agent exited ${code}`, tone: 'warn' };
  return { text: exit, tone: 'err' };
}

/** The last line worth repeating in a toast when a job finishes behind a closed drawer. */
export function lastLine(lines: readonly string[]): string {
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i]!.replace(/^[\s✓✗⑂●!]+/, '').trim();
    if (t) return cutClean(t, 70);
  }
  return '';
}

/**
 * How a job came out, by its drawer's status: in lime, it did what its title says; refused before it
 * ran, killed, or failing with nothing but an exit code, it never did; any other way, it ran and came
 * out badly (tests failed, a replay diverged, a search found nothing, nothing was scored).
 */
export function jobEnd(status: { text: string; tone: string }): JobEnd {
  if (status.tone === 'ok') return 'ok';
  return /^(refused\b|stopped$|interrupted$|lost\b|exit \d+$)/.test(status.text) ? 'not' : 'ran';
}

/**
 * What the toast says when a job ends behind a hidden drawer: its title in the past tense, where that
 * claims no more than happened, and how it came out, in the drawer's status words ("Ran tests · failed
 * · 2 of 7 goldens passed · exit 1", "Tried repairing · no fix found · exit 1", "Tried importing
 * capture · shadowlap: x.har is not a HAR file"), a status that only repeats the verb left out
 * ("Forked · exit 0"). When those say no more than the exit code, the last line the job printed says
 * it instead. One stopped says so ("Running tests stopped"): it ended on no outcome to say in the past,
 * unless it left something in your working tree (a Revert's revert), which it says as one that ended does.
 */
export function endToast(job: JobLike, lines: readonly string[]): string {
  if (job.stopped && !leftInTree(job)) return `${jobTitle(job)} stopped`;
  const st = jobStatus(job, lines);
  const status = st.text;
  const done = doneWords(jobTitle(job), jobEnd(st), status);
  const last = lastLine(lines);
  const said = /^(finished · )?exit \d+$/.test(status) && last ? last : status.replace(/^finished · /, '');
  // "Packed share/x · 14 calls", where it said that goes on from the title's one word.
  const verb = done.toLowerCase().split(' ')[0] ?? '';
  const left = withoutRepeat(done, said);
  return left === said && !done.includes(' ') && said.startsWith(`${verb} `) ? `${done} ${said.slice(verb.length + 1)}` : `${done} · ${left}`;
}

/**
 * What a job said beside its past-tense title, less what only repeats the title: "Forked · exit 0",
 * "Applied fix · tests failed · exit 1", "Marked the fix applied · exit 0".
 */
function withoutRepeat(done: string, said: string): string {
  const words = done.toLowerCase().split(' ');
  const repeated = [words[0] ?? '', words.at(-1) ?? ''].find((w) => said.startsWith(`${w} · `));
  return repeated ? said.slice(repeated.length + 3) : said;
}

/**
 * The drawer's header and the status bar's chip: what it does or did, how that stands and in what
 * colour. Running, its -ing title. Ended, its past tense, where that claims no more than happened,
 * the same words its toast leads with, and a status that doesn't repeat them. A job stopped by hand
 * or lost keeps its -ing title: it ended on no outcome to say in the past, unless it left something
 * in your working tree (`leftInTree`).
 */
export function jobHeader(job: JobLike, lines: readonly string[], lost = false): JobWords & { title: string } {
  const title = jobTitle(job);
  const st = jobStatus(job, lines, lost);
  if (!job.done || (job.stopped && !leftInTree(job))) return { title, ...st };
  const done = doneWords(title, jobEnd(st), st.text);
  return { title: done, text: withoutRepeat(done, st.text), tone: st.tone };
}

/**
 * What Stop asks first, for a job that holds the working tree (a repair verifying candidates made
 * from it, a patch being applied): stopped part way, the tree is what it says. Null for any other job, which
 * Stop stops at once, as Ctrl-C would: a run it was making ends as interrupted.
 */
export function stopAsk(job: RunningJob): { title: string; lead: string; facts: readonly FactWords[]; ok: string } | null {
  if (job.done || job.worktree?.use !== 'writes') return null;
  const [command, sub] = job.args ?? [];
  if (command === 'repair') return { title: 'Stop repair', lead: 'Stops the repair, which reports what it found so far.', facts: [{ label: 'Changes', value: 'nothing in your working tree' }], ok: 'Stop repair' };
  if (command === 'fix' && sub === 'apply') return { title: 'Stop applying patch?', lead: 'Stops applying the patch, which may leave it in your working tree with the fix not marked applied.', facts: [{ label: 'Then', value: 'Apply fix again to finish' }], ok: 'Stop applying' };
  const name = (job.title ?? 'this job').toLowerCase();
  return { title: `Stop ${name}?`, lead: `Stops ${name}, which leaves the tree as it is then.`, facts: [], ok: 'Stop job' };
}

/** What a job's way on calls the run it made: the replay, the fork, or just the run. */
export function openRunWords(job: Pick<JobLike, 'args'>): string {
  if (job.args[0] !== 'replay') return 'Open run';
  return isPlainReplay(job) ? 'Open replay' : 'Open fork';
}

/** A job's way on where it has no drawer drawn to take it from: its first primary link, or the run it made. */
export function wayOnOf(job: JobLike & { links?: ReadonlyArray<{ label: string; href: string; secondary?: boolean }>; newRunId?: string | null }, here: (href: string) => boolean = () => false): { label: string; href: string } | null {
  // Never the page on the screen, as the drawer never links to it.
  const links = (job.links ?? []).filter((l) => !here(l.href));
  const first = links.find((l) => !l.secondary) ?? links[0];
  if (first) return { label: first.label, href: first.href };
  const run = job.newRunId ? `#/run/${job.newRunId}` : null;
  return run && !here(run) ? { label: openRunWords(job), href: run } : null;
}

/** The status bar's chip for a hidden job that ended: what it did and how, in its verdict's colour. */
export function endChip(w: { job: JobLike & { id: string }; lines: readonly string[]; lost?: boolean | undefined }): JobChipView {
  const end = jobHeader(w.job, w.lines, !!w.lost);
  return { label: `${end.title} · ${end.text}`, name: `Show job: ${end.title}, ${end.text.replace(/ · /g, ', ')}`, opens: w.job.id, running: false, tone: end.tone };
}
