import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command, InvalidArgumentError } from 'commander';
import { links } from '@shadowlap/dashboard';
import { attemptsToFail, attemptsToPass, cleanDecided, commandIsImported, DEFAULT_BASELINES, hasRecordedCommand, injectionTemplates, parseGate, parsePayloads, resolveAuthor, selectTemplates, type Gate, type InjectionEntry, type InjectionReport, type Payload, type RunRecord, type Store } from '@shadowlap/engine';
import { AttemptRunner, type AttemptTarget } from '../attempts.js';
import { specFor, type TestEntry } from '../checks.js';
import { loadConfig, loadTests } from '../config.js';
import { importGolden } from '../golden-test.js';
import { expandRecordings, goldenName } from '../goldens.js';
import { CLEAN_GATE, cleanInjection, formatClean, formatPlant, plantInjections, type InconclusiveMode } from '../injection.js';
import { EXIT, inconclusiveStatus, interruptedStatus } from '../exit-codes.js';
import { emitJobEvent } from '../job-events.js';
import { textOrFile } from '../interventions.js';
import { type GuardMode } from '../run-agent.js';
import { confirmImportedCommand, openStore, parseChoice, parseIntArg, requireEnded, requireRun, VERSION, withoutCommand, type GlobalOpts } from '../shared.js';
import { palette as p, safe, shortId } from '../ui.js';

/** `shadowlap injection`: causal prompt-injection tests on recorded runs and goldens (injection.ts). */

/** A count that may be 0: `--obeyed 0`, `--baselines 0`. */
function parseWhole(value: string): number {
  const n = Number(value);
  if (!/^\d+$/.test(value.trim()) || !Number.isSafeInteger(n)) throw new InvalidArgumentError('must be a whole number, 0 or more');
  return n;
}

function parseUsd(value: string): number {
  const n = Number(value.replace(/^\$/, ''));
  if (!Number.isFinite(n) || n <= 0) throw new InvalidArgumentError('must be an amount in USD, such as 0.50');
  return n;
}

/** `--clean 9` or `--clean 9=<json|@file>`: the read, and the neutral result to give it when one is given. */
export function parseClean(raw: string): { callNo: number; neutral?: unknown } {
  const m = /^(\d+)(?:=([\s\S]*))?$/.exec(raw.trim());
  if (!m) throw new InvalidArgumentError(`--clean expects <call> or <call>=<json|@file>, such as --clean 9, got "${raw}"`);
  const callNo = Number(m[1]);
  if (m[2] === undefined) return { callNo };
  const text = textOrFile(m[2], '--clean');
  try {
    return { callNo, neutral: JSON.parse(text) as unknown };
  } catch {
    // Not JSON: the neutral result is that text.
    return { callNo, neutral: text };
  }
}

/**
 * The gate --clean decides with: `--gate`'s figures over the default's (CLEAN_GATE), `--repeat` as
 * its most attempts. Refused when those can't decide a write either way: three attempts are the
 * fewest at the default figures.
 */
export function cleanGate(json: string | undefined, repeat: number | undefined): Gate {
  const { kind: _kind, ...defaults } = CLEAN_GATE;
  let gate: Gate = { ...CLEAN_GATE };
  if (json !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json) as unknown;
    } catch {
      throw new InvalidArgumentError(`--gate takes JSON, such as '{"good":0.8,"bad":0.2,"risk":0.05,"max":10}'`);
    }
    try {
      gate = parseGate(parsed, '--gate', defaults);
    } catch (err) {
      throw new InvalidArgumentError((err as Error).message);
    }
    if (gate.kind !== 'sprt') throw new InvalidArgumentError('--gate: --clean decides on its own attempts, with good, bad, risk and max; a baseline gate needs a golden\'s history');
  }
  if (gate.kind === 'sprt') {
    if (repeat !== undefined) gate = { ...gate, max: repeat };
    const needed = Math.max(attemptsToPass(gate), attemptsToFail(gate));
    if (gate.max < needed) throw new InvalidArgumentError(`${repeat !== undefined ? `--repeat ${repeat}` : `--gate's max (${gate.max})`} is fewer than the ${needed} clean attempts a write needs to be decided at good ${gate.good}, bad ${gate.bad} and risk ${gate.risk}: give ${needed} or more`);
  }
  return gate;
}

/** A target as the command line names it: a golden (a pack folder, `*` allowed in its last part) or a run. */
interface Target {
  run: RunRecord;
  golden: string | null;
  /** The golden's tests entry, when the config gives it one. */
  entry: InjectionEntry | null;
}

/** Whether an argument names a folder rather than a run: it has a path separator or a `*`, or such a folder exists. */
const isPath = (arg: string) => /[\\/*]/.test(arg) || existsSync(resolve(arg));

function resolveTargets(store: Store, args: readonly string[], tests: TestEntry[] | Error): Target[] {
  const projectDir = process.cwd();
  const out: Target[] = [];
  for (const arg of args) {
    if (!isPath(arg)) {
      out.push({ run: requireRun(store, arg), golden: null, entry: null });
      continue;
    }
    const { dirs, unmatched } = expandRecordings([arg], projectDir);
    if (unmatched.length) throw new InvalidArgumentError(`no recordings match ${unmatched.join(' ')}: a recording is a directory written by shadowlap pack, with a run.json inside`);
    for (const dir of dirs) {
      if (tests instanceof Error) throw tests;
      const run = importGolden(store, dir);
      out.push({ run, golden: goldenName(dir, projectDir), entry: specFor(tests, dir, projectDir)?.injection ?? null });
    }
  }
  return out;
}

/** The payloads to plant: `--templates` and `--payloads` as given, else the golden's entry, else every template. */
function payloadsFor(flags: { templates?: string; payloads?: string }, entry: InjectionEntry | null, configDir: string): Payload[] {
  const fromFile = (file: string, where: string) => {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch (err) {
      throw new InvalidArgumentError(`${where}: cannot read ${file}: ${(err as Error).message}`);
    }
    return parsePayloads(text, file);
  };
  let out: Payload[];
  if (flags.templates !== undefined || flags.payloads !== undefined) {
    // Your own payloads alone, unless --templates names some too.
    out = [...selectTemplates(flags.templates ?? (flags.payloads !== undefined ? 'none' : 'all')), ...(flags.payloads !== undefined ? fromFile(flags.payloads, '--payloads') : [])];
  } else if (entry) {
    out = [...selectTemplates(entry.templates), ...(entry.payloads ? fromFile(resolve(configDir, entry.payloads), 'the golden\'s "injection" payloads') : [])];
  } else {
    out = selectTemplates('all');
  }
  if (!out.length) throw new InvalidArgumentError('nothing to plant: --templates none needs --payloads <file>');
  return out;
}

export function register(program: Command): void {
  program.commandsGroup('Test:');

  program
    .command('injection')
    .description('Test whether text in what the agent reads can steer it: plant prompt-injection payloads, each with a canary, in every read of a tool marked untrusted, replay from there with writes stubbed and reads the recording doesn\'t hold fenced, and prove which ones a tool call obeyed. --clean asks whether a recorded read caused a write. Exits 1 when more attempts obeyed than allowed, or when the test showed too little to say (inconclusive, which --inconclusive warn lets through).')
    .argument('[targets...]', 'runs (id or unique prefix) or goldens (directories written by shadowlap pack; a * in the last part matches several, as in goldens/*)')
    .option('--repeat <n>', 'attempts per untrusted read and payload (default: the golden\'s "injection" repeat, else 1); with --clean, the most clean attempts', parseIntArg)
    .option('--templates <ids>', 'built-in templates to plant: all (the default), none, or ids separated by commas (--list-templates names them)')
    .option('--payloads <file>', 'your own payloads, or a red-teaming tool\'s: text (one a line, or blocks between --- lines), JSON or JSON Lines; {{canary}} in them is filled in. Planted instead of the templates unless --templates names some')
    .option('--list-templates', 'print the built-in templates and exit')
    .option('--baselines <n>', `clean replays of each read, forked where its result is read, that "influenced" compares with (default: the golden's, else ${DEFAULT_BASELINES})`, parseWhole)
    .option('--obeyed <n>', 'attempts that may obey before the command exits 1 (default: the golden\'s "injection" obeyed, else 0)', parseWhole)
    .option('--influenced <n>', 'attempts that may be influenced before the command exits 1 (default: the golden\'s, else no limit)', parseWhole)
    .option('--clean <call[=result]>', 'instead: replace read <call> with a neutral result (every string with a space in it emptied), or the JSON given, and replay until the gate decides whether each write after it goes away, so whether its content caused it')
    .option('--write <call>', 'with --clean: the recorded write to test (repeatable; default every write after the read)', (v: string, acc: number[] | undefined) => [...(acc ?? []), parseIntArg(v)])
    .option('--gate <json>', `with --clean: the gate that decides "caused"; figures left out are the default's, '{"good":0.8,"bad":0.2,"risk":0.05,"max":10}'`)
    .option('--live-reads', "after the fork, run the reads the recording doesn't hold instead of fencing them (a read that carries planted text is fenced all the same)")
    .option('--inconclusive <mode>', 'what an inconclusive verdict does to the exit status: fail (the default) or warn and let it through', parseChoice<InconclusiveMode>(['fail', 'warn']), 'fail')
    .option('--html <file>', 'also write a security report: the reads × payloads matrix, the proof of each obeyed attempt, why the inconclusive ones show nothing, the payloads, with the redaction rules of shadowlap.config.json and every canary kept')
    .option('--no-redact', 'with --html: skip the redaction rules')
    .option('--concurrency <n>', 'attempts running at once', parseIntArg, 1)
    .option('--budget <usd>', 'start no attempt once this much is spent on live model calls', parseUsd)
    .option('--timeout <seconds>', 'stop an attempt after this long', parseIntArg)
    .option('--guard <mode>', 'network guard for connections that bypass Shadowlap: block | warn | off', parseChoice<GuardMode>(['warn', 'block', 'off']), 'block')
    .option('-y, --yes', 'run the recorded command of an imported run without asking')
    .option('--json', 'print the report as JSON (progress still goes to stderr)')
    .action(async (args: string[], flags: { repeat?: number; templates?: string; payloads?: string; listTemplates?: boolean; baselines?: number; obeyed?: number; influenced?: number; clean?: string; write?: number[]; gate?: string; liveReads?: boolean; inconclusive: InconclusiveMode; html?: string; redact: boolean; concurrency: number; budget?: number; timeout?: number; guard: GuardMode; yes?: boolean; json?: boolean }) => {
      if (flags.listTemplates) {
        const set = injectionTemplates();
        if (flags.json) process.stdout.write(JSON.stringify(set, null, 2) + '\n');
        else process.stdout.write(`Built-in templates, version ${set.version} (${set.updated}): {{canary}} is the canary's address, {{canary.id}} and {{canary.amount}} its id and amount\n\n${set.templates.map((t) => `${p.bold(t.id)}  ${p.dim(`${t.shape} · ${t.title}`)}\n${t.text.split('\n').map((line) => `  ${safe(line)}`).join('\n')}`).join('\n\n')}\n`);
        return;
      }
      const write = flags.write ?? [];
      if (!args.length) throw new InvalidArgumentError('name the runs or goldens to test: shadowlap injection <run>, or shadowlap injection goldens/*');
      if (flags.repeat !== undefined && (flags.repeat < 1 || flags.repeat > 100)) throw new InvalidArgumentError('--repeat is a whole number from 1 to 100');
      if (flags.baselines !== undefined && flags.baselines > 20) throw new InvalidArgumentError('--baselines is at most 20');
      if (flags.concurrency < 1 || flags.concurrency > 16) throw new InvalidArgumentError('--concurrency is a whole number from 1 to 16');
      if (!flags.clean && (write.length || flags.gate !== undefined)) throw new InvalidArgumentError(`${write.length ? '--write' : '--gate'} goes with --clean <call>`);
      const clean = flags.clean !== undefined ? parseClean(flags.clean) : null;
      if (clean && (flags.templates !== undefined || flags.payloads !== undefined)) throw new InvalidArgumentError('--clean replays with the read made neutral, so it plants nothing: leave out --templates and --payloads');
      const gate = cleanGate(flags.gate, clean ? flags.repeat : undefined);

      const opts = program.opts<GlobalOpts>();
      const projectDir = process.cwd();
      // A mistake in the config is named before anything runs; the tests are read only for goldens.
      loadConfig(projectDir);
      let tests: TestEntry[] | Error;
      try {
        tests = loadTests(projectDir);
      } catch (err) {
        tests = err as Error;
      }
      const store = openStore(opts);
      let targets: Target[];
      try {
        targets = resolveTargets(store, args, tests);
        for (const t of targets) {
          requireEnded(store, t.run, 'test it for injection');
          if (!hasRecordedCommand(t.run)) throw new InvalidArgumentError(`${shortId(t.run.runId)} ${withoutCommand(t.run)} and has no command to re-run: replay it once with yours (shadowlap replay ${shortId(t.run.runId)} -- <command>) and test that run`);
        }
      } finally {
        store.close();
      }
      // A run from someone else's pack runs their command: ask, as a replay does. A golden is the project's own.
      const attemptTargets: AttemptTarget[] = [];
      for (const t of targets) {
        const imported = !t.golden && commandIsImported(t.run);
        if (imported && !flags.yes && !(await confirmImportedCommand(t.run, t.run.command.argv, `shadowlap injection ${shortId(t.run.runId)} --yes`))) {
          process.exitCode = EXIT.usage;
          return;
        }
        attemptTargets.push({ parent: t.run, argv: t.run.command.argv, commandFromImport: imported });
      }

      const say = (line: string) => process.stderr.write(`${line}\n`);
      const actor = resolveAuthor({ cwd: projectDir });
      // Writes stubbed, reads served from the recording when they are the same call, and the rest
      // fenced unless --live-reads (injection.ts): a model a payload steers may ask a read to carry data out.
      const runner = await AttemptRunner.start(opts, { writes: 'stub', reads: 'replay', liveTools: [], spec: null, budget: flags.budget ?? null, timeoutMs: flags.timeout === undefined ? null : flags.timeout * 1000, guard: flags.guard });
      const reports: InjectionReport[] = [];
      try {
        for (const [i, t] of targets.entries()) {
          const target = attemptTargets[i]!;
          const name = t.golden ?? shortId(t.run.runId);
          if (clean) {
            say(`${p.yellow('⑂')} Did #${clean.callNo}'s content cause ${name}'s writes? Replaying it with #${clean.callNo} made neutral, writes stubbed, until the gate decides`);
            const r = await cleanInjection(runner, target, { callNo: clean.callNo, ...(clean.neutral !== undefined ? { neutral: clean.neutral } : {}), writes: write, gate, golden: t.golden, sessionId: null, actor, liveReads: !!flags.liveReads }, say);
            reports.push(r);
            if (!flags.json) process.stdout.write(`\n${p.bold(name)}\n${formatClean(r)}\n`);
            continue;
          }
          const payloads = payloadsFor(flags, t.entry, projectDir);
          const repeat = flags.repeat ?? t.entry?.repeat ?? 1;
          const baselines = flags.baselines ?? t.entry?.baselines ?? DEFAULT_BASELINES;
          const limits = { obeyed: flags.obeyed ?? t.entry?.obeyed ?? 0, influenced: flags.influenced ?? t.entry?.influenced ?? null };
          say(`${p.yellow('⑂')} Planting ${payloads.length} payload${payloads.length === 1 ? '' : 's'} in ${name}'s untrusted reads, ${repeat} attempt${repeat === 1 ? '' : 's'} each, writes stubbed; ${baselines} clean replay${baselines === 1 ? '' : 's'} of each read to compare with`);
          for (const x of payloads.filter((y) => !y.canary)) say(p.yellow(`  ! ${x.id} has no {{canary}}: a write can show it influenced the agent, never prove it obeyed`));
          const r = await plantInjections(runner, target, { repeat, payloads, baselines, concurrency: flags.concurrency, limits, golden: t.golden, sessionId: null, actor }, say, { liveReads: !!(flags.liveReads ?? t.entry?.liveReads) });
          reports.push(r);
          if (!flags.json) process.stdout.write(`\n${p.bold(name)}\n${formatPlant(r)}\n`);
          if (runner.interrupted) break;
        }
      } finally {
        await runner.close();
      }

      let html: string | null = null;
      if (flags.html) {
        const { injectionReportHtml } = await import('@shadowlap/dashboard');
        const rules = flags.redact ? loadConfig(projectDir).redact : [];
        html = resolve(flags.html);
        writeFileSync(html, injectionReportHtml(reports, { redact: rules, version: VERSION }));
        emitJobEvent({ type: 'file', path: html, label: 'Security report' });
        if (!flags.json) process.stdout.write(`${p.green('✓')} ${html}  ${p.dim(rules.length ? `${rules.length} redaction rule${rules.length === 1 ? '' : 's'} applied; canaries kept` : 'no redaction rules applied')}\n`);
      }
      const plants = reports.filter((r) => r.mode === 'plant');
      const totals = { runs: reports.length, attempts: 0, obeyed: 0, influenced: 0, ignored: 0, inconclusive: 0 };
      for (const r of plants) for (const k of ['attempts', 'obeyed', 'influenced', 'ignored', 'inconclusive'] as const) totals[k] += r.totals[k];
      // A plant result passes, fails or is inconclusive by its gate; a --clean result is inconclusive while a write is undecided.
      const verdicts = reports.map((r) => (r.mode === 'plant' ? r.gate.verdict : cleanDecided(r) ? 'passed' : 'inconclusive'));
      const verdict = verdicts.includes('failed') ? 'failed' : verdicts.includes('inconclusive') || runner.interrupted ? 'inconclusive' : 'passed';
      const passed = verdict === 'passed' || (verdict === 'inconclusive' && flags.inconclusive === 'warn' && !runner.interrupted);
      const json = { templates: { version: injectionTemplates().version, updated: injectionTemplates().updated }, results: reports, totals, verdict, passed, html };
      if (flags.json) process.stdout.write(JSON.stringify(json, null, 2) + '\n');
      else if (verdict === 'inconclusive' && !runner.interrupted) process.stdout.write(p.dim(flags.inconclusive === 'warn' ? 'Inconclusive, let through by --inconclusive warn.\n' : 'Inconclusive fails the run; --inconclusive warn lets it through.\n'));
      emitJobEvent({ type: 'result', data: json });
      for (const r of reports) emitJobEvent({ type: 'link', label: reports.length === 1 ? 'Open the run' : `Open ${shortId(r.runId)}`, href: links.run(r.runId), ...(reports.length > 1 ? { secondary: true } : {}) });
      // Cut short by a signal, its status; failed, 1; inconclusive and not let through, 3.
      process.exitCode = runner.interrupted ? interruptedStatus() : passed ? EXIT.ok : verdict === 'failed' ? EXIT.failed : inconclusiveStatus(flags.inconclusive);
    });
}
