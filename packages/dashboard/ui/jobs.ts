import { isObject } from '../../engine/src/is-object.js';
import { fixJobStatus } from './fixes/model.js';
import { ACTIONS, doneWords, type JobEnd } from './labels.js';

/**
 * What the job drawer says about a CLI run the dashboard started: its title, how each output line
 * is coloured, and how it ended. No DOM here: the tests import it.
 */

export interface JobLike {
  args: string[];
  done: boolean;
  code: number | null;
  title?: string;
  kind?: string;
  /** What the command reported as its outcome (what `--json` would print). */
  result?: unknown;
  /** Someone asked it to stop. */
  stopped?: boolean;
}

/** What following a job does after a poll for it failed. */
export type AfterPollError = 'retry' | 'wait' | 'stop' | 'lost';

/**
 * After a failed poll: wait while the server is unreachable and pick the job up again once it is
 * back; stop when the link expired (the page says so); call the job lost when the server no longer
 * has it (it was restarted) or keeps refusing to say.
 */
export function afterPollError(e: { status: number | null; unreachable: boolean; failures: number }): AfterPollError {
  if (e.status === 401) return 'stop';
  if (e.status === 404) return 'lost';
  if (e.unreachable) return 'wait';
  return e.failures >= 5 ? 'lost' : 'retry';
}

/** The replay options that change the run at a call: a replay with one of them is a fork. */
const FORK_FLAGS = ['--inject', '--override', '--fail-at', '--model', '--prompt-from', '--diverge-at', '--live-tool', '--inject-result', '--set', '--live-input'];

/** A command's own options: what follows `--` is the agent's command, with flags of its own. */
function ownArgs(args: readonly string[]): readonly string[] {
  const end = args.indexOf('--');
  return end < 0 ? args : args.slice(0, end);
}

/** Whether a replay's options fork it at a call (`--inject 17=…`, `--fail-at=19=529`). */
function forks(args: readonly string[]): boolean {
  return ownArgs(args).some((a) => FORK_FLAGS.includes(a.split('=')[0]!));
}

/**
 * A Replay: `replay <run>` with nothing that forks it and no `--repeat`. A policy for the writes or
 * the reads keeps it one (Replay with writes stubbed), and so does the command a capture is replayed with.
 */
export function isPlainReplay(job: Pick<JobLike, 'args'>): boolean {
  const own = ownArgs(job.args);
  return own[0] === 'replay' && !own.includes('--repeat') && !forks(job.args);
}

/** The drawer's title for a command a job runs with no title of its own: the -ing form of its action's name. */
const DOING: Readonly<Record<string, string>> = {
  pack: ACTIONS.packRun.doing,
  normalize: ACTIONS.addNormalizer.doing,
  redact: ACTIONS.addRedactionRule.doing,
  blame: ACTIONS.runBlame.doing,
  repair: ACTIONS.runRepair.doing,
  verify: ACTIONS.runVerify.doing,
  test: ACTIONS.runTests.doing,
  import: ACTIONS.importCapture.doing,
  calibrate: ACTIONS.calibrate.doing,
  bisect: ACTIONS.findBreakingCommit.doing,
  gc: 'Cleaning up',
  rm: 'Deleting',
};

/** Each export's, by what it exports. */
const EXPORTING: Readonly<Record<string, string>> = { html: ACTIONS.exportHtml.doing, har: ACTIONS.exportHar.doing, otel: ACTIONS.exportTrace.doing, dataset: ACTIONS.exportDataset.doing };

/** What the drawer calls a job: "Replaying", "Forking", "Packing", the server's title when it sends one. */
export function jobTitle(job: JobLike): string {
  if (job.title) return job.title;
  const [cmd, sub] = job.args;
  if (cmd === 'replay') return ownArgs(job.args).includes('--repeat') ? ACTIONS.repeat.doing : forks(job.args) ? 'Forking' : ACTIONS.replay.doing;
  if (cmd === 'export') return EXPORTING[sub ?? ''] ?? 'Exporting';
  return DOING[cmd ?? ''] ?? 'Running';
}

/** The command as typed, for the drawer's first line. */
export function jobCommand(args: readonly string[]): string {
  return `shadowlap ${args.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ')}`;
}

export type LineTone = '' | 'p' | 'ok' | 'y' | 'no';

/** How the drawer colours an output line, from the marks the CLI prints. */
export function lineTone(line: string): LineTone {
  const t = line.trimStart();
  if (t.startsWith('$ ')) return 'p';
  if (/^(✓|●)/.test(t)) return 'ok';
  if (/^(✗|error\b|Error\b)/.test(t)) return 'no';
  if (/^(⑂|⚠|!|warning\b)/.test(t)) return 'y';
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
 * How a job ended, in the drawer's status line: the outcome first, then the exit code. Worked out
 * from the CLI's own words when the server sends no structured result.
 */
export function jobStatus(job: JobLike, lines: readonly string[], lost = false): { text: string; tone: '' | 'ok' | 'warn' | 'err' } {
  if (lost && !job.done) return { text: 'lost · the dashboard server no longer has this job', tone: 'err' };
  if (!job.done) return { text: job.stopped ? 'stopping' : 'running', tone: '' };
  // Stopped on request: that is how it ended, whatever its exit code says.
  if (job.stopped) return { text: job.code === null ? 'stopped' : `stopped · exit ${job.code}`, tone: 'warn' };
  // Blame, repair and fix apply say how they came out in their result.
  const fixes = fixJobStatus(job);
  if (fixes) return fixes;
  // So do Score a model and Export pairs (Training).
  const training = trainingJobStatus(job);
  if (training) return training;
  const all = lines.join('\n');
  const code = job.code;
  if (code === null) return { text: 'stopped', tone: 'err' };
  const exit = `exit ${code}`;
  // A Replay whose request differed from the recording didn't reproduce the run, whatever the agent
  // did once it went live, so that leads: amber when the agent ended well, red when it didn't.
  const diverged = replayDivergence(job, lines);
  if (diverged) return { text: `diverged at #${diverged.callNo}${diverged.live ? ' · went live' : ''} · ${exit}`, tone: code === 0 ? 'warn' : 'err' };
  // So did a fork that left the recording before the call its flag acts on.
  const early = forkDivergedEarly(job, lines);
  if (early) return { text: `diverged at #${early.callNo}, before ${FORK_WORDS[early.target.flag]!} at #${early.target.callNo}${early.live ? ' · went live' : ''} · ${exit}`, tone: code === 0 ? 'warn' : 'err' };
  // Find breaking commit: whether bisect named the first bad commit.
  if (/^✓ first bad commit /m.test(all)) return { text: `found · ${exit}`, tone: 'ok' };
  if (/^✗ no first bad commit/m.test(all)) return { text: `not found · ${exit}`, tone: 'warn' };
  // `shadowlap test` (Run tests, Update golden, Add normalizer and re-run): the last totals it printed.
  const totals = [...all.matchAll(/^(\d+) passed, (\d+) failed(, \d+ not run: interrupted)?/gm)].at(-1);
  if (totals) {
    // Stopped: the goldens after the one it was replaying didn't run, so the counts are no verdict.
    if (totals[3] || code === 130 || code === 143) return { text: `interrupted · ${exit}`, tone: 'warn' };
    const failed = Number(totals[2]);
    return failed ? { text: `${failed} failed · ${exit}`, tone: 'err' } : { text: `${totals[1]!} passed · ${exit}`, tone: code === 0 ? 'ok' : 'err' };
  }
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
  if (/Diverged at call/.test(all) && !/Forked at call/.test(all)) return { text: `diverged · ${exit}`, tone: 'err' };
  if (/the agent process exited with an error|--fail-at/.test(all)) return { text: `agent exited ${code}`, tone: 'warn' };
  return { text: exit, tone: 'err' };
}

/** The last line worth repeating in a toast when a job finishes behind a closed drawer. */
export function lastLine(lines: readonly string[]): string {
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i]!.replace(/^[\s✓✗⑂●!]+/, '').trim();
    if (t) return t.length > 70 ? `${t.slice(0, 69)}…` : t;
  }
  return '';
}

/**
 * How a job came out, by its drawer's status: in lime, it did what its title says; refused before it
 * ran, killed, or failing with nothing but an exit code, it never did; any other way, it ran and came
 * out badly (tests failed, a replay diverged, a search found nothing, nothing was scored).
 */
function jobEnd(status: { text: string; tone: string }): JobEnd {
  if (status.tone === 'ok') return 'ok';
  return /^(refused\b|stopped$|lost\b|exit \d+$)/.test(status.text) ? 'not' : 'ran';
}

/**
 * What the toast says when a job ends behind a closed drawer: its title in the past tense, where that
 * claims no more than happened, and how it came out, in the drawer's status words ("Ran tests · 1
 * failed · exit 1", "Tried repairing · no fix found · exit 1", "Tried importing capture ·
 * shadowlap: x.har is not a HAR file"), a status that only repeats the verb left out ("Forked · exit
 * 0"). When those say no more than the exit code, the last line the job printed says it instead. One
 * stopped says so ("Running tests stopped"): it ended on no outcome to say in the past.
 */
export function endToast(job: JobLike, lines: readonly string[]): string {
  if (job.stopped) return `${jobTitle(job)} stopped`;
  const st = jobStatus(job, lines);
  const status = st.text;
  const done = doneWords(jobTitle(job), jobEnd(st), status);
  const last = lastLine(lines);
  const said = /^(finished · )?exit \d+$/.test(status) && last ? last : status.replace(/^finished · /, '');
  // What it said that only repeats the title goes: "Forked · exit 0", "Found breaking commit · exit 0",
  // "Packed share/x · 14 calls", "Applied fix · tests failed · exit 1", "Marked the fix applied · exit 0".
  const words = done.toLowerCase().split(' ');
  const verb = words[0] ?? '';
  const repeated = [verb, words.at(-1) ?? ''].find((w) => said.startsWith(`${w} · `));
  if (repeated) return `${done} · ${said.slice(repeated.length + 3)}`;
  return !done.includes(' ') && said.startsWith(`${verb} `) ? `${done} ${said.slice(verb.length + 1)}` : `${done} · ${said}`;
}

/**
 * Whether a job of one of `kinds` (the jobs that run the goldens) is still running, as far as this
 * page follows it: the palette offers no second session meanwhile. A job the server lost is over.
 */
export function jobRunning(jobs: ReadonlyArray<{ job: Pick<JobLike, 'done' | 'kind'>; lost?: boolean }>, kinds: ReadonlySet<string>): boolean {
  return jobs.some((w) => !w.job.done && !w.lost && kinds.has(w.job.kind ?? ''));
}

/** A job as Stop and the top bar's chip read it: whether it runs, and how it uses its working tree. */
export interface RunningJob {
  id: string;
  done: boolean;
  args?: readonly string[];
  title?: string;
  kind?: string;
  stopped?: boolean;
  /** When it started: the chip opens the newest. */
  startedAt?: number;
  worktree?: { use: 'reads' | 'writes'; doing: string } | null;
}

/**
 * What Stop asks first, for a job that holds the working tree (a repair verifying candidates made
 * from it, a patch being applied): stopped part way, the tree is what it says. Null for any other job, which
 * Stop stops at once, as Ctrl-C would: a run it was making ends as interrupted.
 */
export function stopAsk(job: RunningJob): { title: string; text: string; ok: string } | null {
  if (job.done || job.worktree?.use !== 'writes') return null;
  const [command, sub] = job.args ?? [];
  if (command === 'repair')
    return { title: 'Stop the repair?', text: 'It is verifying candidates in temporary worktrees, never in your working tree, which it leaves as it is. Stopped, it reports what it found so far, as Ctrl-C does.', ok: 'Stop the repair' };
  if (command === 'fix' && sub === 'apply')
    return { title: 'Stop applying the patch?', text: 'It is changing your working tree. Stopped part way, the patch may be in while the fix isn’t marked applied: Apply it again to finish.', ok: 'Stop applying' };
  const doing = job.worktree.doing;
  return { title: `Stop ${(job.title ?? 'this job').toLowerCase()}?`, text: `${doing.charAt(0).toUpperCase()}${doing.slice(1)}. Stopped part way, the tree is left as it is then.`, ok: 'Stop it' };
}

/**
 * The top bar's chip while jobs run (`1 job running`), and the job a click reopens: the newest one
 * running whose drawer isn't open. None while nothing runs, or while the only job running has its
 * drawer open already. A job stopping still runs. The server lists jobs newest first, but one this
 * tab has just started may not be in its list yet, so they go by when they started.
 */
export function runningChip(jobs: readonly RunningJob[], open: string | null): { count: number; label: string; opens: string; title: string } | null {
  const running = jobs.filter((j) => !j.done).sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  const opens = running.find((j) => j.id !== open);
  if (!opens) return null;
  const n = running.length;
  const names = running.map((j) => jobTitle({ args: [...(j.args ?? [])], done: false, code: null, ...(j.title ? { title: j.title } : {}) }));
  return { count: n, label: `${n} ${n === 1 ? 'job' : 'jobs'} running`, opens: opens.id, title: `${[...new Set(names)].join(', ')}: open ${n === 1 ? 'its' : 'the newest one’s'} drawer` };
}
