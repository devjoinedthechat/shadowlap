import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Command, InvalidArgumentError } from 'commander';
import { links } from '@shadowlap/dashboard';
import {
  countPairs,
  findPairs,
  formatTokens,
  formatUsd,
  judgeLine,
  listingInput,
  listModelChoices,
  mainRefusal,
  matchTask,
  modelReach,
  PAIR_FORMATS,
  PAIR_SHAPES,
  pairRows,
  projectPath,
  recordEvent,
  resolveAuthor,
  safeLine,
  type PairFormat,
  type ReadPolicy,
  type Store,
  type TaskStatus,
} from '@shadowlap/engine';
import { STOP_SIGNALS } from '../agent-signals.js';
import { formatBudget } from '../attempts.js';
import { loadConfig } from '../config.js';
import { EXIT, interruptedStatus, stoppedBy } from '../exit-codes.js';
import { emitJobEvent } from '../job-events.js';
import { type GuardMode } from '../run-agent.js';
import { serveTasks } from '../serve-tasks.js';
import { openStore, parseChoice, parseIntArg, readStore, type GlobalOpts } from '../shared.js';
import { resolveTarget, targetVia, type ModelTarget } from '../takeover.js';
import { addJudge, cannotScore, keepScores, loadTasks, notStarted, scoreTask, type KeptScores, type LoadedTask, type ScoredAttempt, type TaskScore } from '../tasks.js';
import { palette as p, quoteArgv, shortId } from '../ui.js';

/**
 * Training: preference pairs read from the attempts blame, verify and --repeat left in the store,
 * goldens as tasks a model is scored on, and the HTTP endpoint a training loop asks for rewards.
 * Nothing is collected for any of it, and nothing leaves the machine until it is exported.
 */

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const STATUS: Record<TaskStatus, string> = { ready: 'ready', blocked: 'blocked', 'not-a-task': 'not a task', 'no-golden': 'no golden' };

function parseUsd(value: string): number {
  const n = Number(value.replace(/^\$/, ''));
  if (!Number.isFinite(n) || n <= 0) throw new InvalidArgumentError('must be an amount in USD, such as 0.50');
  return n;
}

function parsePort(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new InvalidArgumentError('must be a port number');
  return n;
}

/** The redaction line every export of pairs prints. */
function redactionLine(rules: number, skipped: boolean): string {
  if (skipped) return p.yellow('  redaction skipped (--no-redact): the copy holds what was recorded');
  if (!rules) return p.yellow('  no redaction rules: the copy holds what was recorded (shadowlap redact add)');
  return `  redaction: ${plural(rules, 'rule')} applied to the copy (rules without a path to every string, path rules to the message fields kept); the store is unchanged`;
}

function author(): string | null {
  return resolveAuthor({ cwd: process.cwd() });
}

/** `fn` on the store; `read` for what only reads it, which leaves no store behind where there is none. */
function withStore<T>(opts: GlobalOpts, fn: (store: Store) => T, read = false): T {
  const store = read ? readStore(opts) : openStore(opts);
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

/** The calls before a takeover at #k, which replay from the recording: `#1–#4`, `#1`, or null for none. */
export function replayedBefore(k: number): string | null {
  return k <= 1 ? null : k === 2 ? '#1' : `#1–#${k - 1}`;
}

/** The goldens a list of paths names: each one, or every golden in a folder (`.` is the project). */
function under(root: string, goldens: readonly string[], all: LoadedTask[]): Array<{ given: string; tasks: LoadedTask[] }> {
  return goldens.map((g) => {
    const path = projectPath(root, g);
    return { given: g, tasks: path === '.' ? all : all.filter((t) => t.golden === path || t.golden.startsWith(`${path}/`)) };
  });
}

/** A task as `shadowlap tasks` lists it. */
function describeRow(t: LoadedTask): string[] {
  const status = t.status === 'ready' ? p.green('ready') : t.status === 'blocked' ? p.yellow('blocked') : p.dim(STATUS[t.status]);
  const lines = [`  ${safeLine(t.golden)}  ${status}${t.note ? p.dim(` · ${safeLine(t.note)}`) : ''}`];
  // Which scope the model plays matters only when another one answers too, as a simulated user does.
  const scope = t.scope !== null && t.scopes.length > 1 ? ` · plays scope ${safeLine(t.scope)}` : '';
  if (t.takeover) {
    const first = replayedBefore(t.takeover.callNo);
    lines.push(p.dim(`      takes over at #${t.takeover.callNo} · ${safeLine(t.takeover.why)}${scope} · ${first ? `${first} ${t.takeover.callNo === 2 ? 'replays' : 'replay'} free` : 'nothing replays first'}`));
  }
  if (t.rewards) lines.push(p.dim(`      rewards: ${safeLine(t.rewards)}`));
  const checks = t.checks.filter((c) => !c.cap);
  if (t.status === 'ready' || t.status === 'blocked') lines.push(p.dim(`      scored by: the agent exits 0${checks.map((c) => `; ${safeLine(c.label)}`).join('')}`));
  if (t.after.live.length || t.after.stubbed.length) lines.push(p.dim(`      after the takeover: ${[...t.after.live.map((n) => `${safeLine(n)} live`), ...t.after.stubbed.map((n) => `${safeLine(n)} stubbed`)].join(', ')}`));
  // Its test passes, but forks before the takeover: re-recorded as the agent runs now, a model can take over.
  if (t.fork) lines.push(p.dim(`      update it: shadowlap test ${safeLine(quoteArgv([t.golden]))} --update`));
  return lines;
}

/** What became of a model's earlier score on a task, when it had one. */
export function keptLine(s: TaskScore, k: KeptScores, asked: number): string | null {
  const name = s.task.split('/').at(-1) ?? s.task;
  const mean = (rows: Array<{ score: number }>) => (rows.reduce((x, r) => x + r.score, 0) / rows.length).toFixed(2);
  if (k.outcome === 'replaced') return `${name}: replaced ${plural(k.before.length, 'earlier attempt')} (${mean(k.before)}) with ${s.attempts.length === 1 ? 'this one' : `these ${s.attempts.length}`}`;
  if (k.outcome === 'kept') return `${name}: kept the earlier score (${mean(k.before)} over ${plural(k.before.length, 'attempt')}): this one stopped after ${s.attempts.length} of ${asked}`;
  return null;
}

function checkLine(a: ScoredAttempt): string {
  return a.checks.map((c) => (c.pass ? `${p.green('✓')} ${safeLine(c.check)}` : `${p.red('✗')} ${safeLine(c.check)}`)).join(' · ');
}

/** What became of the model's score on each task: `new`, `replaced`, the earlier one `kept` (this one stopped short), or `none` (nothing was scored). */
const STORED: Record<KeptScores['outcome'], string> = { new: 'new', replaced: 'replaced', kept: 'kept-earlier', none: 'none' };

/**
 * What `tasks score --json` prints. `spent` is what the attempts' own calls cost; what their judge
 * checks' calls did and cost is `judge`, apart, at each level (null without a judge call), as test
 * and verify report it. The budget counts both.
 */
function scoreJson(target: ModelTarget, via: string, session: string, scores: TaskScore[], skipped: Array<{ task: string; reason: string }>, kept: Map<TaskScore, KeptScores> = new Map()) {
  const all = scores.flatMap((s) => s.attempts);
  return {
    model: target.model,
    baseUrl: target.scoreBase,
    via,
    session,
    tasks: scores.map((s) => ({ task: s.task, takeover: s.takeover, why: s.why, replayed: s.prefix, attempts: s.attempts.map((a) => ({ attempt: a.attempt, run: a.runId, score: a.score, checks: a.checks, spent: a.spent, judge: a.judge, exitCode: a.exitCode })), mean: s.mean, spent: s.spent, judge: s.judge, stopped: s.stopped, dropped: s.dropped, stored: STORED[kept.get(s)?.outcome ?? 'none'] })),
    mean: all.length ? all.reduce((x, a) => x + a.score, 0) / all.length : null,
    attempts: all.length,
    spent: scores.reduce((x, s) => x + s.spent, 0),
    judge: scores.reduce<TaskScore['judge']>((j, s) => addJudge(j, s.judge), null),
    unknownModels: [...new Set(scores.flatMap((s) => s.unknownModels))],
    skipped,
  };
}

export function register(program: Command): void {
  // ---- export pairs, beside the other exports ----
  const exportCmd = program.commands.find((c) => c.name() === 'export') ?? program.command('export').description('Export a run in another format');
  exportCmd
    .command('pairs')
    .description('Preference pairs read from blame, verify and --repeat attempts (JSON Lines): the conversation at a model call, an answer to prefer and one to avoid, for preference fine-tuning')
    .option('--min-confidence <level>', 'high: answers blame proved decided the run; medium: also where a failing and a passing attempt first differ', parseChoice(['high', 'medium'] as const), 'high')
    .option('--format <format>', 'openai-preference (OpenAI preference fine-tuning) | trl (prompt, chosen, rejected)', parseChoice(PAIR_FORMATS), 'openai-preference')
    .option('--out <file>', 'write here instead of stdout')
    .option('--no-redact', 'skip the redaction rules in shadowlap.config.json')
    .action((flags: { minConfidence: 'high' | 'medium'; format: PairFormat; out?: string; redact: boolean }) => {
      const opts = program.opts<GlobalOpts>();
      // The pairs go to stdout without --out, so the report goes to stderr then.
      const say = (line: string) => (flags.out ? process.stdout : process.stderr).write(`${line}\n`);
      withStore(opts, (store) => {
        const { pairs, sources } = findPairs(store);
        const counts = countPairs(pairs);
        const kept = pairs.filter((x) => flags.minConfidence === 'medium' || x.confidence === 'high');
        const leftOut = pairs.length - kept.length;
        const rules = flags.redact ? loadConfig(process.cwd()).redact : [];
        say(`▸ reading blame, verify and --repeat attempts from the store: ${plural(sources.length, 'source')}`);
        const width = Math.max(0, ...sources.map((s) => safeLine(s.label).length));
        for (const s of sources) say(p.dim(`    ${safeLine(s.label).padEnd(width)}  ${s.made ? `${plural(s.made, 'pair')}, ${s.confidence}` : `none: ${safeLine(s.why)}`}`));
        if (!pairs.length) {
          say(`  No pairs yet: blame a failing run, and the answer it was lost on and one that went on to pass make a pair.`);
          say(p.dim('    shadowlap blame <run> --expect <checks>'));
        }
        say(`  ${plural(kept.length, 'pair')} at confidence ${flags.minConfidence === 'high' ? 'high' : 'high or medium'}${leftOut ? ` · ${leftOut} medium left out` : ''} · identical answers count once${counts.all ? p.dim(` (${counts.high} high, ${counts.medium} medium in all)`) : ''}`);
        say('  each: the conversation as the model saw it at that call, and two answers to it');
        say(`  ${flags.format}: ${PAIR_SHAPES[flags.format]}`);
        say(redactionLine(rules.length, !flags.redact));
        const rows = pairRows(store, kept, { format: flags.format, redact: rules });
        if (rows.length < kept.length) say(p.yellow(`  ${kept.length - rows.length} pair${kept.length - rows.length === 1 ? '' : 's'} left out: the request at that call can't be read`));
        const data = { format: flags.format, minConfidence: flags.minConfidence, leftOut, redaction: flags.redact ? rules.length : null, sources: sources.filter((s) => s.made).map((s) => ({ key: s.key, label: s.label, made: s.made })) };
        if (!rows.length) {
          // Nothing to write: a file already there keeps what an earlier export put in it, and nothing left the machine.
          say(`${p.yellow('!')} nothing exported${flags.out ? ` · ${flags.out} left as it was` : ''}`);
          emitJobEvent({ type: 'result', data: { exportId: null, pairs: 0, file: null, ...data } });
          return;
        }
        const body = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
        if (flags.out) {
          mkdirSync(dirname(resolve(flags.out)), { recursive: true });
          writeFileSync(flags.out, body);
        } else process.stdout.write(body);
        const file = flags.out ?? '-';
        say(`${p.green('✓')} ${flags.out ? `wrote ${flags.out}` : 'wrote to stdout'} · ${plural(rows.length, 'pair')}`);
        const record = store.addPairsExport({ pairs: rows.length, file, format: flags.format, minConfidence: flags.minConfidence, leftOut, actor: author(), data: { redaction: data.redaction, sources: data.sources } });
        recordEvent(store, { kind: 'pairs.exported', actor: record.actor, ref: file, data: { count: rows.length, ...data } });
        // A dashboard job offers the file; it is started from Training, so it links nowhere else.
        if (flags.out) emitJobEvent({ type: 'file', path: resolve(flags.out), label: flags.out });
        emitJobEvent({ type: 'result', data: { exportId: record.exportId, pairs: rows.length, file, ...data } });
        // Only reads, unless there are pairs to export: then the store is there to keep the export in.
      }, true);
    });

  // ---- tasks ----
  program.commandsGroup('Train:');
  const tasks = program
    .command('tasks')
    .description('Goldens as tasks a model can be scored on: a model takes over at one call, the calls before it replay free, and the checks score what it did')
    .enablePositionalOptions();

  tasks
    .command('ls', { isDefault: true })
    .description('List the tasks: where a model takes over and why, what each rewards, and whether it can be scored')
    .option('--json', 'print them as JSON')
    .action((flags: { json?: boolean }) => {
      const opts = program.opts<GlobalOpts>();
      const { tasks: list, oneSided } = withStore(opts, (store) => loadTasks(process.cwd(), store), true);
      if (flags.json) {
        process.stdout.write(JSON.stringify({ tasks: list.map(({ pack: _pack, spec: _spec, dir: _dir, ...t }) => t), oneSided }, null, 2) + '\n');
        return;
      }
      if (!list.length) {
        process.stdout.write('No tasks yet. A golden whose checks say what the agent must do is a task: a model takes over at one call, and the checks score what it did.\n');
        process.stdout.write(p.dim('  shadowlap pack <run> goldens/<name>, then add its checks under "tests" in shadowlap.config.json\n'));
        return;
      }
      const ready = list.filter((t) => t.status === 'ready').length;
      const counts = (['blocked', 'not-a-task', 'no-golden'] as const).map((s) => [s, list.filter((t) => t.status === s).length] as const).filter(([, n]) => n);
      process.stdout.write(`${p.bold(`${ready} of ${plural(list.length, 'task')} ready`)}${counts.length ? p.dim(` · ${counts.map(([s, n]) => `${n} ${STATUS[s]}`).join(' · ')}`) : ''}\n`);
      for (const t of list) process.stdout.write(describeRow(t).join('\n') + '\n');
      if (oneSided) {
        const o = oneSided.opposite;
        process.stdout.write(`\n${p.yellow('!')} One-sided: every ready task rewards "${safeLine(oneSided.rewards)}", so a model that learned only that would score full marks.${o ? ` ${safeLine(o.golden)} rewards "${safeLine(o.rewards)}" once it is ready (${STATUS[o.status]}${o.note ? `: ${safeLine(o.note)}` : ''}).` : ''}\n`);
      }
    });

  tasks
    .command('score')
    .description('Score a model on the tasks: each attempt replays a golden up to its takeover for free, the model answers from there with writes stubbed, and the checks score it. Every attempt is a run; a model scored again replaces its scores')
    .argument('[goldens...]', 'golden directories, or folders of them (default: every ready task)')
    .requiredOption('--model <model>', 'the model to score: a name for the recording\'s own provider, anthropic:<model> or openai:<model> for that API, or a name at --base-url')
    .option('--base-url <url>', 'an OpenAI-compatible endpoint to ask (Ollama, vLLM, your training server), such as http://127.0.0.1:8000/v1')
    .option('--key-env <name>', 'the environment variable holding the endpoint\'s key (default: OPENAI_API_KEY for api.openai.com, ANTHROPIC_API_KEY for anthropic:)')
    .option('--attempts <n>', 'attempts per task', parseIntArg, 5)
    .option('--reads <policy>', 'what read tools do after the takeover: live (the services must be up) or replay (served from the recording when they match)', parseChoice<ReadPolicy>(['live', 'replay']), 'live')
    .option('--concurrency <n>', 'attempts of one task running at once', parseIntArg, 1)
    .option('--budget <usd>', 'start no attempt once this much is spent on live model calls', parseUsd)
    .option('--timeout <seconds>', 'stop an attempt after this long and count it as failed', parseIntArg)
    .option('--guard <mode>', 'network guard for connections that bypass Shadowlap: warn | block | off', parseChoice<GuardMode>(['warn', 'block', 'off']), 'warn')
    .option('--json', 'print the scores as JSON (progress still goes to stderr)')
    .action(async (goldens: string[], flags: { model: string; baseUrl?: string; keyEnv?: string; attempts: number; reads: ReadPolicy; concurrency: number; budget?: number; timeout?: number; guard: GuardMode; json?: boolean }) => {
      const opts = program.opts<GlobalOpts>();
      if (flags.attempts > 100) throw new InvalidArgumentError('--attempts is at most 100');
      let target: ModelTarget;
      try {
        target = resolveTarget({ model: flags.model, baseUrl: flags.baseUrl, keyEnv: flags.keyEnv });
      } catch (err) {
        throw new InvalidArgumentError((err as Error).message);
      }
      const root = process.cwd();
      const { tasks: all } = withStore(opts, (store) => loadTasks(root, store), true);
      const skipped: Array<{ task: string; reason: string }> = [];
      let chosen: LoadedTask[];
      if (goldens.length) {
        chosen = [];
        for (const { given: g, tasks: inside } of under(root, goldens, all)) {
          const match = inside.length ? null : matchTask(all, g);
          const found = inside.length ? inside : match && 'task' in match ? [match.task] : [];
          if (match && 'ambiguous' in match) skipped.push({ task: g, reason: `${g} names more than one golden (${match.ambiguous.join(', ')}): give its path` });
          else if (!found.length) skipped.push({ task: g, reason: `${g} is not a golden of this project (see shadowlap tasks)` });
          for (const t of found) if (!chosen.includes(t)) chosen.push(t);
        }
      } else chosen = all.filter((t) => t.status === 'ready');
      const scorable: LoadedTask[] = [];
      for (const t of chosen) {
        const why = cannotScore(t, target);
        if (why) skipped.push({ task: t.golden, reason: why });
        else scorable.push(t);
      }
      const log = (line: string) => process.stderr.write(`${line}\n`);
      for (const s of skipped) log(`${p.yellow('!')} skipped ${safeLine(s.reason)}`);
      if (!scorable.length) {
        log(all.length ? 'No task to score: a task is ready when its golden passes and its checks say whether the agent was right (shadowlap tasks).' : 'No tasks yet: pack a run as a golden and give it checks on what the agent must do (shadowlap tasks).');
        if (flags.json) process.stdout.write(JSON.stringify(scoreJson(target, targetVia(target, null), '', [], skipped), null, 2) + '\n');
        // Nothing it was given can be scored: no golden is a task yet, or those named aren't ready.
        process.exitCode = EXIT.usage;
        return;
      }
      const session = `score-${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
      const via = targetVia(target, scorable[0]!.provider);
      log(`${p.yellow('⑂')} Scoring ${p.bold(safeLine(target.model))} ${p.dim(`(${safeLine(via)})`)} on ${plural(scorable.length, 'task')} · ${plural(flags.attempts, 'attempt')} each`);
      log(p.dim(`  each attempt replays the golden up to the takeover for free; from there ${safeLine(target.model)} answers · writes stubbed · reads ${flags.reads}${flags.budget ? ` · budget ${formatBudget(flags.budget)}` : ''}`));

      const scores: TaskScore[] = [];
      let spent = 0;
      const budgetSpent = flags.budget ? `the budget of ${formatBudget(flags.budget)} is spent` : null;
      for (const t of scorable) {
        const k = t.takeover!.callNo;
        const first = replayedBefore(k);
        log(`▸ ${safeLine(t.name)} · ${first ? `${first} replayed` : 'nothing replayed first'} · ${safeLine(target.model)} from #${k} · writes stubbed ${p.dim(`(${safeLine(t.takeover!.why)})`)}`);
        let score: TaskScore;
        try {
          score = await scoreTask(opts, t, target, { attempts: flags.attempts, reads: flags.reads, concurrency: flags.concurrency, budget: flags.budget ?? null, timeoutMs: flags.timeout === undefined ? null : flags.timeout * 1000, guard: flags.guard }, { id: session, spentBefore: spent }, (a) => {
            log(`  ${String(a.attempt).padStart(2)} · ${checkLine(a)} · ${a.score === 1 ? p.green(a.score.toFixed(2)) : a.score > 0 ? p.yellow(a.score.toFixed(2)) : p.red(a.score.toFixed(2))} ${p.dim(shortId(a.runId))}`);
            emitJobEvent({ type: 'run', runId: a.runId, role: 'attempt' });
          });
        } catch (err) {
          log(`  ${p.red('✗')} ${(err as Error).message}`);
          skipped.push({ task: t.golden, reason: (err as Error).message });
          continue;
        }
        // The budget counts what the judge checks cost too, though it is reported apart.
        spent += score.spent + (score.judge?.spent ?? 0);
        scores.push(score);
        if (score.dropped.length) log(p.dim(`  the conversation went to ${safeLine(target.model)} without: ${score.dropped.join(', ')}`));
        if (score.stopped) log(`  ${p.yellow('!')} ${score.stopped.split('\n').map(safeLine).join('\n    ')}`);
        if (score.mean !== null) log(p.dim(`  mean ${score.mean.toFixed(2)} over ${plural(score.attempts.length, 'attempt')}`));
        if (budgetSpent && spent >= flags.budget!) {
          // Said once: a task the budget stopped has said it already.
          if (score.stopped !== budgetSpent) log(p.yellow(`  ${budgetSpent}`));
          // The tasks after it start no attempt: each is reported as stopped by the budget, so the
          // score says it fell short of them (exit 1) rather than leaving them out.
          const rest = scorable.slice(scorable.indexOf(t) + 1);
          if (rest.length) log(p.yellow(`  not started: ${rest.map((r) => safeLine(r.name)).join(', ')}`));
          scores.push(...rest.map((r) => notStarted(r, target, budgetSpent)));
          break;
        }
      }

      const done = scores.filter((s) => s.attempts.length);
      const kept = withStore(opts, (store) => new Map(done.map((s) => [s, keepScores(store, target, s, session, flags.attempts)] as const)));
      const report = scoreJson(target, via, session, scores, skipped, kept);
      if (done.length) withStore(opts, (store) => recordEvent(store, { kind: 'model.scored', actor: author(), ref: target.model, data: { model: target.model, baseUrl: target.scoreBase, via, tasks: done.length, attempts: report.attempts, mean: report.mean, spent: report.spent, session } }));
      for (const [s, k] of kept) {
        const line = keptLine(s, k, flags.attempts);
        if (line) log(p.dim(`  ${line}`));
      }
      const unpriced = report.unknownModels.length ? p.dim(` (no price for ${report.unknownModels.map(safeLine).join(', ')}: add it under "prices" in shadowlap.config.json)`) : '';
      // A model on this machine answers for nothing; the provider's own calls after a takeover (an embedding) still cost what they cost.
      const cost = target.local ? `$0, on this machine${report.spent > 0 ? ` · ≈${formatUsd(report.spent)} on the provider's own calls` : ''}${unpriced}` : `≈${formatUsd(report.spent)} spent${unpriced}`;
      // What the judge checks' calls did and cost, apart from the model's: they go to the judge, never to the model scored.
      const judged = report.judge ? p.dim(`  ${judgeLine(report.judge)}, apart from the cost above`) : null;
      if (report.mean !== null) {
        const line = `${p.green('✓')} ${safeLine(target.model)} · mean ${report.mean.toFixed(2)} · ${plural(report.attempts, 'attempt')} on ${plural(done.length, 'task')} · ${cost} · every call before a takeover replayed`;
        if (flags.json) log(line);
        else process.stdout.write(`${line}\n`);
      } else log(`${p.red('✗')} no attempt was scored`);
      if (judged) {
        if (flags.json || report.mean === null) log(judged);
        else process.stdout.write(`${judged}\n`);
      }
      // The scores show something new only when an attempt was scored: a job that scored none ends on its reason.
      if (done.length) emitJobEvent({ type: 'link', label: 'Open the scores', href: links.training('tasks') });
      emitJobEvent({ type: 'result', data: report });
      if (flags.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      // Every task scored in full, 0; cut short by a signal, its status; by the budget, 3; a task skipped or stopped, 1.
      const stopped = scores.map((s) => s.stopped).filter((x): x is string => !!x);
      process.exitCode = stoppedBy() ? interruptedStatus() : report.mean !== null && !skipped.length && !stopped.length ? EXIT.ok : !skipped.length && stopped.length && stopped.every((x) => x.includes('budget')) ? EXIT.inconclusive : EXIT.failed;
    });

  tasks
    .command('serve')
    .description('Serve the tasks to a training loop: one attempt per HTTP request, answered with each check\'s result, the score to use as the reward, the run and its cost. Listens on 127.0.0.1 and needs the token it prints')
    .argument('[goldens...]', 'golden directories, or folders of them (default: every task)')
    .option('--port <port>', 'port to listen on (default 4779, or a free one if it is taken)', parsePort)
    .option('--concurrency <n>', 'attempts running at once; more requests wait their turn', parseIntArg, 2)
    .option('--reads <policy>', 'what read tools do after the takeover, unless a request says: live | replay', parseChoice<ReadPolicy>(['live', 'replay']), 'live')
    .option('--base-url <url>', 'the OpenAI-compatible endpoint of the model being trained: requests that name no baseUrl ask it')
    .option('--key-env <name>', 'the environment variable holding the key of --base-url, sent there and nowhere else (a request can\'t name one)')
    .option('--timeout <seconds>', 'stop an attempt after this long and count it as failed', parseIntArg)
    .option('--guard <mode>', 'network guard for connections that bypass Shadowlap: warn | block | off', parseChoice<GuardMode>(['warn', 'block', 'off']), 'warn')
    .action(async (goldens: string[], flags: { port?: number; concurrency: number; reads: ReadPolicy; baseUrl?: string; keyEnv?: string; timeout?: number; guard: GuardMode }) => {
      const opts = program.opts<GlobalOpts>();
      const root = process.cwd();
      const { tasks: all } = withStore(opts, (store) => loadTasks(root, store), true);
      const only = under(root, goldens, all).flatMap((x) => x.tasks.map((t) => t.golden));
      if (goldens.length && !only.length) throw new InvalidArgumentError(`${goldens.join(', ')}: no golden of this project there (see shadowlap tasks)`);
      if (flags.keyEnv !== undefined && !/^[A-Za-z_][A-Za-z0-9_]{0,99}$/.test(flags.keyEnv)) throw new InvalidArgumentError('--key-env takes the name of an environment variable, such as VLLM_API_KEY');
      if (flags.keyEnv !== undefined && flags.baseUrl === undefined) throw new InvalidArgumentError('--key-env needs --base-url: the key goes to that endpoint and nowhere else');
      let baseUrl: string | undefined;
      if (flags.baseUrl !== undefined) {
        try {
          baseUrl = resolveTarget({ model: 'm', baseUrl: flags.baseUrl }).baseUrl!;
        } catch (err) {
          throw new InvalidArgumentError((err as Error).message);
        }
      }
      // Anyone on this machine can try a token against a loopback port: one that short is guessed.
      const given = process.env.SHADOWLAP_TASKS_TOKEN?.trim();
      if (given !== undefined && given !== '' && given.length < 16) throw new InvalidArgumentError('SHADOWLAP_TASKS_TOKEN must be at least 16 characters; leave it unset for a random one');
      const token = given || randomBytes(24).toString('hex');
      const server = await serveTasks(opts, root, { port: flags.port ?? 4779, strictPort: flags.port !== undefined, token, concurrency: flags.concurrency, reads: flags.reads, timeoutMs: flags.timeout === undefined ? null : flags.timeout * 1000, guard: flags.guard, goldens: only, ...(baseUrl ? { baseUrl } : {}), ...(flags.keyEnv ? { keyEnv: flags.keyEnv } : {}) }, (line) => process.stderr.write(p.dim(`[tasks] ${line}\n`)));
      const served = goldens.length ? all.filter((t) => only.includes(t.golden)) : all;
      const ready = served.filter((t) => t.status === 'ready');
      process.stdout.write(`Serving ${plural(ready.length, 'ready task')} on ${server.url}\n`);
      process.stdout.write(`  token: ${token}\n`);
      process.stdout.write(p.dim(`  POST ${server.url}/v1/tasks/<task>/attempts  ${baseUrl ? `{"model":"my-finetune"} (asks ${baseUrl})` : '{"model":"my-finetune","baseUrl":"http://127.0.0.1:8000/v1"}'}\n  with Authorization: Bearer <token>; GET /v1/tasks lists them. Ctrl-C stops.\n`));
      for (const t of ready) process.stdout.write(p.dim(`  ${safeLine(t.name)}: takes over at #${t.takeover!.callNo}\n`));
      // Served until a stop signal: Ctrl-C, a supervisor's stop, or the terminal closing.
      await new Promise<void>((done) => {
        for (const s of STOP_SIGNALS) process.once(s, () => done());
      });
      await server.close();
    });

  tasks
    .command('models')
    .description('Models to score: the one the recordings used, each configured provider\'s models (Anthropic and OpenAI with the keys in the environment, Ollama on this machine) and endpoints scored before, each with what an attempt costs and the ready tasks it can answer')
    .option('--json', 'print them as JSON')
    .option('--timeout <ms>', 'how long to wait for each provider\'s list', parseIntArg, 1500)
    .action(async (flags: { json?: boolean; timeout: number }) => {
      const opts = program.opts<GlobalOpts>();
      const config = loadConfig(process.cwd());
      const { list, scores } = withStore(opts, (store) => ({ list: loadTasks(process.cwd(), store).tasks, scores: store.listTaskScores() }), true);
      const ready = list.filter((t) => t.status === 'ready');
      const listing = await listModelChoices({ ...listingInput(list, scores), ...(config.prices ? { prices: config.prices } : {}), timeoutMs: flags.timeout });
      const readyGoldens = new Set(ready.map((t) => t.golden));
      const meanOf = (model: string, base: string | null) => {
        const rows = scores.filter((s) => s.model === model && s.baseUrl === base && readyGoldens.has(s.golden));
        return rows.length ? rows.reduce((x, r) => x + r.score, 0) / rows.length : null;
      };
      // Which ready tasks each can answer: what `tasks score` would refuse, said before anything runs.
      const choices = listing.choices.map((c) => ({ ...c, lastScore: meanOf(c.id, c.baseUrl), reach: modelReach(c, list) }));
      if (flags.json) {
        process.stdout.write(JSON.stringify({ choices, notes: listing.notes, tokens: listing.tokens, tasks: ready.length }, null, 2) + '\n');
        return;
      }
      const t = listing.tokens;
      process.stdout.write(`Models to score on ${plural(ready.length, 'ready task')}${t ? p.dim(` · an attempt uses about ${formatTokens(t.inputTokens + (t.cacheReadInputTokens ?? 0) + (t.cacheCreationInputTokens ?? 0))} input and ${formatTokens(t.outputTokens)} output tokens after its takeover`) : ''}\n`);
      const groups = [...new Set(choices.map((c) => c.group))];
      for (const g of groups) {
        process.stdout.write(`${p.bold(safeLine(g))}\n`);
        const rows = choices.filter((c) => c.group === g);
        const width = Math.max(...rows.map((c) => safeLine(c.id).length));
        for (const c of rows) {
          const cost = c.local ? '$0, not a paid API' : c.perAttempt === null ? 'no price' : `≈${formatUsd(c.perAttempt)} an attempt`;
          // Why its own provider's task can't ask it says more than that the others were recorded elsewhere, as the dashboard says it.
          const first = mainRefusal(c.reach);
          const reach = !first ? '' : c.reach.tasks.length ? p.dim(` · on ${c.reach.tasks.length} of ${plural(ready.length, 'task')}`) : p.yellow(` · can't answer the tasks (${safeLine(first.name)}: ${safeLine(first.why)})`);
          process.stdout.write(`  ${safeLine(c.id).padEnd(width)}  ${p.dim(cost)}${c.lastScore !== null ? ` · scored ${c.lastScore.toFixed(2)}` : ''}${reach}\n`);
        }
      }
      for (const n of listing.notes) process.stdout.write(p.dim(`${safeLine(n.group)}: ${safeLine(n.note)}\n`));
      process.stdout.write(p.dim(`Your own endpoint: shadowlap tasks score --model <name> --base-url <url>\n`));
    });
}
