import { Command, Option } from 'commander';
import { ACTIONS, applyLeft, BLAME_DEFAULTS, describeBaselineRule, FIX_STATUSES, FixIdError, fixRecords, type FixStatus, KEPT_DEFAULTS, NAME_MAX, prNumber, type ReadPolicy, repairerProblem, resolveFix, setFixTitle, SPRT_DEFAULTS, type StoredFix, type StoreOf, verifyArgv } from '@shadowlap/engine';
import { fieldChange, fixDetail, fixHref, fixList, ghReader, goldensFolderIn, patchesInTree, patchesToCheck, prHost, pulledPatchesToCheck, readableHosts, rewritesHere, type PrRead } from '@shadowlap/dashboard';
import { acceptedRepair, ApplyError, applyFix } from '../fix-apply.js';
import { changeCheck, FixCheckError, reportFixCheck, reportFixCheckRefused } from '../fix-check.js';
import { parseNameFlag } from '../fix-apply-names.js';
import { formatFixDetail, formatFixList, repairLine, shortFixId } from '../fix-format.js';
import { emitJobEvent } from '../job-events.js';
import { EXIT } from '../exit-codes.js';
import { type GuardMode } from '../run-agent.js';
import { collect, missingStoreNote, parseChoice, parseIntArg, parseUsd, readStore, type GlobalOpts } from '../shared.js';
import { ago, clauses, folder, palette as p, quoteArgv, safe } from '../ui.js';
import { buildCommand, loadConfig } from '../config.js';
import { ALLOW_UNRECORDED, ALLOW_UNRECORDED_HELP } from '../unrecorded.js';
import { blameRun, type BlameFlags } from './fix-blame.js';
import { parseCount, parseMargin, parsePercent } from './fix-flags.js';
import { repairRuns, type RepairFlags } from './fix-repair.js';
import { verifyRuns, type VerifyCommandFlags } from './fix-verify.js';


/** Finding where a failed run went wrong (blame), checking that a change fixes it (verify), fixing it (repair), and the fixes they report to. */

export function register(program: Command): void {
  program.commandsGroup('Find and fix:');

  program
    .command('blame')
    .description('Find the model call where a failed run was lost: the last one whose answer, asked again, lets the run pass. Probes it with forks that replay everything before it for free.')
    .argument('<run>', 'the failed run: id or unique prefix')
    .argument('[command...]', 'override the recorded command (after "--")')
    .option('--expect <json|@file>', 'what a passing run must do besides exiting 0, as under "expect" in shadowlap.config.json tests: \'{"tools":{"send_email":0}}\'')
    .option('--gate <json|@file>', `how a probe decides, after each attempt: a gate that tells a re-asked call passing "good" of the time or more (a rescue) from one passing "bad" or less (lost), each verdict wrong at most "risk" of the time at those two rates, up to "max" attempts (default '{"good":${BLAME_DEFAULTS.good},"bad":${BLAME_DEFAULTS.bad},"risk":${BLAME_DEFAULTS.risk},"max":${BLAME_DEFAULTS.max}}'; give any of them)`)
    .option('--attempts <n>', 'a fixed count instead of the gate: attempts per probed model call (5 with --passes alone)', parseIntArg)
    .option('--passes <n>', 'with a fixed count: passing attempts that make a probe a rescue (default: 2, or 1 with one attempt)', parseIntArg)
    .option('--model <model>', 'rescue with this model from the probed call on, instead of asking the recorded one again')
    .option('--set <key=value>', 'set a request field from the probed call on, e.g. temperature=1 (repeatable)', collect)
    .option('--scope <name>', 'probe only model calls made in this scope, such as the agent\'s and not a simulated user\'s (see scope() in the SDKs)')
    .option('--scan <n>', 'model calls past the boundary to probe as well, in case rescue works again after it', parseCount, 2)
    .option('--writes <policy>', 'what write tools do after the fork: stub (the agent carries on as if the write succeeded) or block; a write the recording made, with the same arguments, gets what it got then', parseChoice(['stub', 'block'] as const), 'stub')
    .option('--reads <policy>', 'what read tools do after the fork: live | replay', parseChoice<ReadPolicy>(['live', 'replay']), 'live')
    .option('--concurrency <n>', 'attempts of one probe running at once', parseIntArg, 1)
    .option('--budget <usd>', 'start no attempt once this much is spent on live model calls', parseUsd)
    .option('--timeout <seconds>', 'stop an attempt after this long and count it as failed', parseIntArg)
    .option('--guard <mode>', 'network guard for connections that bypass shadowlap: warn | block | off', parseChoice<GuardMode>(['warn', 'block', 'off']), 'warn')
    .option(ALLOW_UNRECORDED, ALLOW_UNRECORDED_HELP, collect)
    .option('-y, --yes', 'run the recorded command of an imported run without asking')
    .option('--json', 'print the report as JSON (progress still goes to stderr)')
    .action(async (runArg: string, command: string[], flags: BlameFlags) => {
      await blameRun(program.opts<GlobalOpts>(), runArg, command, flags);
    });

  program
    .command('verify')
    .description('Check a change before it ships: replay failing runs, which it must now fix, and good runs, which it must not leave worse than their baseline, under the code as it is now. Exits 0 only when the change is accepted: 1 when it is rejected, 3 when it can\'t be decided.')
    .argument('[command...]', 'run this command instead of each run\'s recorded one (after "--")')
    .option('--fixes <run...>', 'failing runs the change was written to fix: run ids, or label:<name>')
    .option('--holdout <run...>', 'failing runs of the same kind that the change was not written against')
    // The rule its report states a good run is kept by, from the same defaults, as repair's --keeps says it.
    .option('--keeps <run...>', `runs that passed and must not get worse, each against its own baseline, e.g. label:good: one that forks is ${describeBaselineRule({ ...KEPT_DEFAULTS, risk: SPRT_DEFAULTS.risk, source: 'paired' })}, its baseline the same run under the code before the change, or with --baseline history ${describeBaselineRule({ ...KEPT_DEFAULTS, risk: SPRT_DEFAULTS.risk, source: 'history' })}; --margin and verify.max (or a --gate max off its default) change the points and the pairs, --gate's risk the risk, and a fixed count (--attempts, --passes) judges it on its own`)
    .option('--expect <json|@file>', 'what a passing run must do besides exiting 0, as under "expect" in shadowlap.config.json tests')
    .option('--gate <json|@file>', `how a run decides, after each attempt where the replay forks: a gate that tells a run passing "good" of the time or more from one passing "bad" or less, each verdict wrong at most "risk" of the time at those two rates, up to "max" attempts (default '{"good":${SPRT_DEFAULTS.good},"bad":${SPRT_DEFAULTS.bad},"risk":${SPRT_DEFAULTS.risk},"max":${SPRT_DEFAULTS.max}}'; give any of them)`)
    .option('--attempts <n>', 'a fixed count instead of the gate: attempts per run, where the replay forks (5 with --passes alone)', parseIntArg)
    .option('--passes <n>', 'with a fixed count: attempts that must pass for a run to pass (default: 80%, rounded up: 4 of 5)', parseIntArg)
    .option('--model <model>', 'the change is this model, from each run\'s first model call')
    .option('--set <key=value>', 'the change sets this request field from each run\'s first model call (repeatable)', collect)
    .option('--from <model>', 'with --model or --set: change only the model calls made with this model, such as the agent\'s and not a simulated user\'s (repeatable)', collect)
    .option('--live-tool <name>', 'the change is in this tool: run it live, its first call and every call of it after a fork (repeatable)', collect)
    .option('--writes <policy>', 'what write tools do after a fork: stub (the agent carries on as if the write succeeded) or block', parseChoice(['stub', 'block'] as const), 'stub')
    .option('--reads <policy>', 'what read tools do after a fork: live | replay', parseChoice<ReadPolicy>(['live', 'replay']), 'live')
    .option('--concurrency <n>', 'runs verified at once', parseIntArg, 1)
    .option('--budget <usd>', 'start no attempt once this much is spent on live model calls', parseUsd)
    .option('--timeout <seconds>', 'stop an attempt after this long and count it as failed', parseIntArg)
    .option('--fail-fast', 'start nothing new once a run has failed')
    .option('--margin <share>', `a good run that forks is kept unless its pass rate drops this much or more below its baseline's: 0.1 is 10 points (default: verify.margin in shadowlap.config.json, else ${KEPT_DEFAULTS.margin})`, parseMargin)
    .option('--kept-max <n>', `the most pairs a good run that forks takes against its baseline, or attempts against its history (default: verify.max in shadowlap.config.json, else ${KEPT_DEFAULTS.max}, or a --gate max off its default)`, parseIntArg)
    .option('--baseline <source>', 'what a good run is compared with: paired, the same run under the code before the change, attempt for attempt; or history, its golden\'s test history (default: verify.baseline, else paired)', parseChoice(['paired', 'history'] as const))
    .option('--base <rev>', 'with a paired baseline: the commit before the change (default: HEAD, when the working tree has a change)')
    .option('--build <command>', 'with a paired baseline at a commit: build its checkout before its attempts, e.g. "npm run build" (default: build in shadowlap.config.json; "" for none)')
    .option('--guard <mode>', 'network guard for connections that bypass shadowlap: warn | block | off', parseChoice<GuardMode>(['warn', 'block', 'off']), 'warn')
    .option(ALLOW_UNRECORDED, ALLOW_UNRECORDED_HELP, collect)
    .option('-y, --yes', 'run the recorded command of imported runs without asking')
    .option('--json', 'print the report as JSON (progress still goes to stderr)')
    .action(async (command: string[], flags: VerifyCommandFlags) => {
      await verifyRuns(program.opts<GlobalOpts>(), command, flags);
    });

  program
    .command('repair')
    .description('Fix failing runs: find where each was lost, ask a model you choose to rewrite the prompt or tool descriptions, and keep the smallest fix shadowlap verify accepts. Writes a patch; --apply, --branch and --pr hand it over.')
    .argument('[command...]', 'run this command instead of each run\'s recorded one (after "--")')
    .option('--fixes <run...>', 'the failing runs to repair: run ids, or label:<name>')
    .option('--holdout <run...>', 'failing runs of the same kind to keep from the repairer (default: every other --fixes run, when there are two or more)')
    // In verify's own words: the rule it keeps a good run by, the drop its verdict bounds.
    .option('--keeps <run...>', `runs that passed and must not get worse, each against its own baseline, e.g. label:good: one that forks is ${describeBaselineRule({ ...KEPT_DEFAULTS, risk: SPRT_DEFAULTS.risk, source: 'paired' })}, as verify keeps one, its baseline the same run on the code without the candidate, and its verdict bounds the drop as verify's does (drop <= 0.10 (95%)); verify.margin and verify.max in shadowlap.config.json change the points and the pairs, --gate's risk the risk`)
    .option('--expect <json|@file>', 'what a passing run must do besides exiting 0, as under "expect" in shadowlap.config.json tests')
    .option('--repairer <provider:model>', 'the model that proposes fixes: anthropic (claude-opus-5-5), anthropic:<model>, openai:<model>, or claude-code[:<model>] to run your own Claude Code (default: repair.repairer in shadowlap.config.json)')
    .option('--repairer-timeout <seconds>', 'give up on the repairer when it has not answered after this long (default: repair.timeout in shadowlap.config.json, else 600)', parseIntArg)
    .option('--candidates <n>', 'fixes to ask the repairer for, and the most of its answer it tries', parseIntArg, 3)
    .option('--stronger <model>', 'when asking the recorded model again rescues nothing, rescue with this one, and try switching to it')
    .option('--scope <name>', 'blame only model calls made in this scope, such as the agent\'s and not a simulated user\'s')
    .option('--set <key=value>', 'blame\'s probes set this request field from the probed call on, e.g. temperature=1 for an agent recorded at 0 (repeatable)', collect)
    .option('--gate <json|@file>', `how verify decides each run, as for shadowlap verify (default '{"good":${SPRT_DEFAULTS.good},"bad":${SPRT_DEFAULTS.bad},"risk":${SPRT_DEFAULTS.risk},"max":${SPRT_DEFAULTS.max}}'; give any of them)`)
    .option('--attempts <n>', 'a fixed count instead of the gate: attempts per run, where the replay forks (5 with --passes alone)', parseIntArg)
    .option('--passes <n>', 'with a fixed count: attempts that must pass (default: 80%, rounded up)', parseIntArg)
    // Read in percent, kept as a share: the help shows the default as it is typed.
    .addOption(new Option('--max-growth <percent>', 'reject a fix that grows the input tokens per run by more than this').argParser(parsePercent).default(0.25, '25'))
    .option('--build <command>', 'rebuild the agent after its source changes, e.g. "npm run build" (default: build in shadowlap.config.json; "" for none)')
    .option('--apply', 'leave the accepted fix in the working tree')
    .option('--branch <name>', 'commit the accepted fix to a new branch, without checking it out')
    .option('--pr', 'with --branch: push it and open a pull request with gh')
    .option('--goldens <dir>', 'with --apply or --branch: also put recordings of the fixed runs in this directory, for shadowlap test')
    .option('--writes <policy>', 'what write tools do after a fork: stub or block', parseChoice(['stub', 'block'] as const), 'stub')
    .option('--reads <policy>', 'what read tools do after a fork: live | replay', parseChoice<ReadPolicy>(['live', 'replay']), 'live')
    .option('--concurrency <n>', 'runs verified at once', parseIntArg, 1)
    .option('--budget <usd>', 'stop once this much is spent on live model calls and the repairer', parseUsd)
    .option('--timeout <seconds>', 'stop an attempt after this long and count it as failed', parseIntArg)
    .option('--guard <mode>', 'network guard for connections that bypass shadowlap: warn | block | off', parseChoice<GuardMode>(['warn', 'block', 'off']), 'warn')
    .option(ALLOW_UNRECORDED, ALLOW_UNRECORDED_HELP, collect)
    .option('-y, --yes', 'run the recorded command of imported runs without asking')
    .option('--json', 'print the report as JSON (progress still goes to stderr)')
    .action(async (command: string[], flags: RepairFlags) => {
      await repairRuns(program.opts<GlobalOpts>(), command, flags);
    });

  registerFixes(program);
}

/** What `fix pr` was given that it can't record, or a fix with no pull request to read. */
class FixPrError extends Error {}

/** The repairer shadowlap.config.json names, if it names one and can be read. */
function configuredRepairer(): string | null {
  try {
    return loadConfig(process.cwd()).repair?.repairer ?? null;
  } catch {
    return null;
  }
}

/** The config's `verify.max`, a good run's pairs, which Run more attempts keeps one to as the dashboard does; null where it sets none or can't be read. */
function configuredKeptMax(): number | null {
  try {
    return loadConfig(process.cwd()).verify?.max ?? null;
  } catch {
    return null;
  }
}

/** A fix by its id or a unique prefix, or a FixIdError that says where to find one. */
function requireFix(store: StoreOf<'fixes'>, idOrPrefix: string): StoredFix {
  const fix = resolveFix(store, idOrPrefix);
  if (!fix) {
    const note = missingStoreNote(store);
    throw new FixIdError(`no fix matches "${idOrPrefix.trim()}"${note ? `: ${note}` : ' (see: shadowlap fix ls)'}`, 'unknown');
  }
  return fix;
}

/** A fix id that names no fix, or several: as JSON with `--json`, else as an error. */
function fixIdFailed(err: unknown, arg: string, json: boolean | undefined): void {
  if (!(err instanceof FixIdError)) throw err;
  if (!json) throw err;
  process.stdout.write(JSON.stringify({ fixId: arg, status: 'error', error: { reason: err.reason, message: err.message } }, null, 2) + '\n');
  process.exitCode = EXIT.usage;
}

/** `shadowlap fix`: each failure, from the blame that reproduced it to a change that held. */
function registerFixes(program: Command): void {
  const fix = program
    .command('fix')
    .description('Fixes: each failure, from the blame that reproduced it to a fix verify accepted. A blame opens one; repair and verify report to it; fix apply hands it over.');

  fix
    .command('ls')
    .description('List fixes, the most recently opened first: status, title, failing runs, and how far blame, repair and verify got')
    .option('--status <status>', 'only fixes that are open, verified (applied ones too) or applied', parseChoice<FixStatus>(FIX_STATUSES))
    .option('--json', 'print the list as JSON, as the dashboard reads it')
    .action((flags: { status?: FixStatus; json?: boolean }) => {
      const store = readStore(program.opts<GlobalOpts>());
      try {
        const list = fixList(store, flags.status ? { status: flags.status } : {});
        const note = missingStoreNote(store);
        process.stdout.write((flags.json ? JSON.stringify(list, null, 2) : note ? p.dim(`No fixes: ${note}`) : formatFixList(list, p)) + '\n');
      } finally {
        store.close();
      }
    });

  fix
    .command('show')
    .description('A fix and its three steps: where the run was lost, the change proposed for it, and every verdict on it')
    .argument('<fix>', 'a fix id or a unique prefix of it, such as fx-01K5CQ2E8M')
    .option('--json', 'print the fix as JSON, as the dashboard reads it')
    .action(async (arg: string, flags: { json?: boolean }) => {
      const store = readStore(program.opts<GlobalOpts>());
      try {
        const repairer = configuredRepairer();
        // The repair it suggests next, whether its repairer can be asked from here (claude on the PATH),
        // whether a verified fix's patch is in this working tree already, which apply only marks applied,
        // why apply refuses a pulled repair's patch here, as the file it rewrites reads, and what the
        // goldens folder holds, which the goldens apply copies can't be named.
        const fix = requireFix(store, arg);
        const patchInTree = await patchesInTree(process.cwd(), patchesToCheck(store, [fix]));
        const rewriteHere = await rewritesHere(process.cwd(), pulledPatchesToCheck(store, [fix]));
        const detail = fixDetail(store, fix.fixId, { repairer, checkRepairer: repairerProblem, patchInTree, rewriteHere, goldensFolder: goldensFolderIn(process.cwd()), keptMax: configuredKeptMax() })!;
        process.stdout.write((flags.json ? JSON.stringify(detail, null, 2) : formatFixDetail(detail, p, { repairer })) + '\n');
      } catch (err) {
        fixIdFailed(err, arg, flags.json);
      } finally {
        store.close();
      }
    });

  fix
    .command('title')
    .description("Give a fix a title of your own, in place of the one derived from its check")
    .argument('<fix>', 'a fix id or a unique prefix of it')
    .argument('<title...>', 'the new title')
    .action((arg: string, words: string[]) => {
      const store = readStore(program.opts<GlobalOpts>());
      try {
        const updated = setFixTitle(store, requireFix(store, arg).fixId, words.join(' '));
        process.stdout.write(`${shortFixId(updated.fixId)} · ${safe(updated.title)}\n`);
      } finally {
        store.close();
      }
    });

  fix
    .command('check')
    .description("Change an open fix's check: judge its failing and good runs again from their recordings, nothing replayed, and keep its blames, repairs and verdicts with the check each ran under")
    .argument('<fix>', 'a fix id or a unique prefix of it')
    .requiredOption('--expect <json|@file>', 'the fix\'s new check, an expect object as under "expect" in shadowlap.config.json tests')
    .option('--json', 'print what changed as JSON: the check, how it judged each run, the runs it left out and the verdicts that stopped counting')
    .action((arg: string, flags: { expect: string; json?: boolean }) => {
      const store = readStore(program.opts<GlobalOpts>());
      try {
        const found = requireFix(store, arg);
        reportFixCheck(changeCheck(store, found, flags.expect, { cwd: process.cwd() }), flags, found.title);
      } catch (err) {
        if (err instanceof FixIdError) return fixIdFailed(err, arg, flags.json);
        if (!(err instanceof FixCheckError)) throw err;
        reportFixCheckRefused(err, flags);
      } finally {
        store.close();
      }
    });

  fix
    .command('pr')
    .description("A fix's pull request: record the one opened for it (CI's fix on failure does), or, with no url, read where it stands from GitHub with gh and record that: open, merged or closed")
    .argument('<fix>', 'a fix id or a unique prefix of it')
    .argument('[url]', 'the pull request opened for it')
    .option('--json', "print the fix's pull request as JSON")
    .action(async (arg: string, url: string | undefined, flags: { json?: boolean }) => {
      const store = readStore(program.opts<GlobalOpts>());
      try {
        const found = requireFix(store, arg);
        const { pr, note } = url !== undefined ? recordPr(store, found, url) : await readPr(store, found);
        if (flags.json) process.stdout.write(JSON.stringify({ fixId: found.fixId, pr, ...(note ? { note } : {}) }, null, 2) + '\n');
        else process.stdout.write(`${shortFixId(found.fixId)} · PR ${pr.number !== null ? `#${pr.number}` : pr.url} ${pr.state ?? 'open'}${note ? p.dim(` · ${note}`) : ''}\n`);
      } catch (err) {
        if (err instanceof FixIdError) return fixIdFailed(err, arg, flags.json);
        if (!(err instanceof FixPrError)) throw err;
        if (flags.json) process.stdout.write(JSON.stringify({ fixId: arg, status: 'error', error: { message: err.message } }, null, 2) + '\n');
        else process.stderr.write(`${p.red('✗')} ${err.message}\n`);
        process.exitCode = EXIT.usage;
      } finally {
        store.close();
      }
    });

  fix
    .command('apply')
    .description("Apply a verified fix: git apply its repair's patch, copy the recordings the fixed code made into the goldens folder, each a golden of its own, run shadowlap test on them, and mark the fix applied. On an applied fix, finish what is left")
    .argument('<fix>', 'a fix id or a unique prefix of it')
    .option('--goldens <dir>', "the project's goldens folder, where the repair's recordings go", 'goldens')
    .option('--name <run=name>', `the name of the golden copied from a fixed run, its id or the start of it: lower-case letters, digits and hyphens, at most ${NAME_MAX} of them, not a name Windows keeps such as con or nul, one golden each, not one the folder holds (repeatable; default: the fix's label, numbered for several)`, collect)
    .option('--no-test', 'copy the recordings without running shadowlap test on them')
    .option('--build <command>', 'rebuild the agent after the patch is applied, before the test (default: build in shadowlap.config.json; "" for none)')
    .option('--json', 'print what was done as JSON (progress still goes to stderr)')
    .action(async (arg: string, flags: { goldens: string; name?: string[]; test: boolean; build?: string; json?: boolean }) => {
      const opts = program.opts<GlobalOpts>();
      const store = readStore(opts);
      const log = (line: string) => process.stderr.write(`${line}\n`);
      try {
        const names = (flags.name ?? []).map((v) => parseNameFlag(v) ?? badName(v));
        const found = requireFix(store, arg);
        if (found.status === 'open') throw openFixError(store, found);
        if (found.status !== 'applied') log(`${p.yellow('⑂')} Applying ${shortFixId(found.fixId)} · ${safe(found.title)}`);
        const build = buildCommand(flags.build, () => loadConfig(process.cwd()));
        const result = await applyFix(store, found, { cwd: process.cwd(), goldens: flags.goldens, names, test: flags.test, build: build.command, buildNote: build.note, db: opts.db, log });
        reportApplied(store, found, result, flags);
      } catch (err) {
        if (err instanceof FixIdError) return fixIdFailed(err, arg, flags.json);
        if (!(err instanceof ApplyError)) throw err;
        if (flags.json) process.stdout.write(JSON.stringify({ fixId: arg, status: 'error', error: { message: err.message } }, null, 2) + '\n');
        else process.stderr.write(`${p.red('✗')} ${err.message}\n`);
        process.exitCode = err.exitCode;
      } finally {
        store.close();
      }
    });
}

/** A `--name` that isn't `<run>=<name>`: said before anything is read or changed. */
function badName(value: string): never {
  throw new ApplyError(`--name ${safe(value)} is not <run>=<name>: give the run whose recording the golden holds, then its name, such as --name 01K5CQ2E8M=refund-over-limit`, EXIT.usage);
}

/** A pull request recorded for a fix, as `fix pr` prints it. */
type FixPr = NonNullable<NonNullable<StoredFix['data']['source']>['pr']>;

/** `fix pr <fix> <url>`: the pull request opened for a fix, recorded as open. */
function recordPr(store: StoreOf<'fixes'>, found: StoredFix, url: string): { pr: FixPr; note: string | null } {
  if (!/^https?:\/\/\S+$/.test(url) || url.length > 2048) throw new FixPrError(`${url.slice(0, 80)} is not a pull request's address: give its https:// link`);
  const pr = { url, number: prNumber(url), state: 'open' as const, at: Date.now() };
  store.mergeFixData(found.fixId, { source: { pr } });
  return { pr, note: null };
}

/**
 * `fix pr <fix>`: where the fix's pull request stands, read from GitHub with gh and recorded when it
 * changed, or as recorded with a note saying why gh wasn't, or couldn't be, asked.
 */
async function readPr(store: StoreOf<'fixes'>, found: StoredFix): Promise<{ pr: FixPr; note: string | null }> {
  const pr = found.data.source?.pr ?? null;
  if (!pr) throw new FixPrError(`${shortFixId(found.fixId)} has no pull request: record one with shadowlap fix pr ${shortFixId(found.fixId)} <url>`);
  // Only a host this project uses is asked: a fix pulled from the team store can name any, and gh would send it a token.
  const hosts = await readableHosts(process.cwd());
  const read = hosts.has(prHost(pr.url)) ? await new Promise<PrRead>((done) => ghReader({ readable: (u) => hosts.has(prHost(u)) })(pr.url, done)) : null;
  if (read?.state) {
    if (read.state !== (pr.state ?? 'open')) store.mergeFixData(found.fixId, { source: { pr: { state: read.state } } });
    return { pr: { ...pr, state: read.state }, note: null };
  }
  if (!read) return { pr, note: `${prHost(pr.url) || 'its host'} is neither github.com, GH_HOST nor this project's origin, so gh isn't asked and its state is as recorded` };
  return { pr, note: read.unusable ? 'gh is not installed or not signed in, so its state is as recorded' : 'gh could not read it, so its state is as recorded' };
}

/**
 * Why an open fix can't be applied, and what to run first: its repair, or, when a change was accepted
 * under another check, its verify under its own check, as its Verify step shows it (`verifyArgv`).
 */
function openFixError(store: StoreOf<'recording' | 'readModels' | 'activity' | 'fixes' | 'team'>, found: StoredFix): ApplyError {
  const detail = fixDetail(store, found.fixId);
  const next = detail?.actions.repair?.argv;
  const other = detail?.verify.find((v) => v.verdict === 'accepted' && !v.counts);
  const why = other ? `a change was accepted, but under another check than this fix's (${detail!.check}), so it doesn't count.` : 'no change has been verified for it yet, so there is nothing to apply.';
  const verify = other ? verifyArgv(store, fixRecords(store, found)) : [];
  const fixFirst = verify.length ? `Verify it under this fix's check:\n  ${quoteArgv(['shadowlap', ...verify])}` : next ? `Repair it first:\n  ${repairLine(next, configuredRepairer())}` : '';
  return new ApplyError(`${shortFixId(found.fixId)} is open: ${why}${fixFirst ? ` ${fixFirst}` : ''}`, EXIT.usage);
}

/** What `fix apply` did, as text or JSON, its job's links, and its status: 1 when its goldens' test failed. */
function reportApplied(store: StoreOf<'fixes' | 'team'>, found: StoredFix, result: Awaited<ReturnType<typeof applyFix>>, flags: { goldens: string; json?: boolean }): void {
  if (flags.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  else if (result.status === 'already-applied') {
    // Only --no-test leaves a test undone here: say so rather than that nothing is left. A
    // teammate's repair, from the team store, left its recordings on their machine: none to test here.
    const repair = acceptedRepair(store, found);
    const untested = applyLeft(found, repair, { pulled: !!repair && store.repairPulled(repair.repairId) !== null })?.test;
    const left = untested ? `, but its goldens ${result.tests === 'failed' ? 'failed their last test' : 'are not tested yet'}: run it without --no-test to test them` : '; nothing is left to do';
    process.stdout.write(`${untested ? p.yellow('!') : p.green('✓')} ${shortFixId(found.fixId)} is already applied${found.appliedAt ? ` (${ago(found.appliedAt)})` : ''}${left}\n`);
  } else {
    // With no patch, a change of request fields (--set, --model) is named: the agent makes it, not a file.
    const change = result.patch === 'none' ? fieldChange(fixRecords(store, found)) : null;
    const what = [
      result.patch === 'applied' ? 'the patch is in the working tree' : result.patch === 'already' ? 'the patch was already in the working tree' : change ? `verified with ${safe(change)}; no patch, set it in your agent` : 'verified on the working tree, no patch to apply',
      ...(result.goldens.length ? [`${result.goldens.filter((g) => g.copied).length} of ${result.goldens.length} golden${result.goldens.length === 1 ? '' : 's'} copied to ${folder(flags.goldens)}`] : []),
      ...(result.tests !== 'skipped' ? [`shadowlap test ${result.tests}`] : []),
    ];
    process.stdout.write(`${clauses(`${result.tests === 'failed' ? p.red('✗') : p.green('✓')} ${shortFixId(found.fixId)} ${result.again ? 'finished applying' : 'applied'}: `, what)}\n`);
    if (result.tests === 'failed') process.stdout.write(p.dim(`  the fix stays applied; once the test passes, run shadowlap fix apply ${shortFixId(found.fixId)} again\n`));
    if (result.update) {
      const n = result.outdated.length;
      process.stdout.write(`${p.yellow('!')} ${n === 1 ? '1 other golden diverges' : `${n} other goldens diverge`} on what the patch changed: re-record ${n === 1 ? 'it' : 'them'} once the change is what you meant\n  ${safe(result.update)}\n`);
    }
  }
  // Goldens to re-record are the next thing to do: the drawer offers Update goldens, and the fix beside it.
  emitJobEvent({ type: 'link', label: ACTIONS.openFix.label, href: fixHref(found.fixId), ...(result.update ? { secondary: true } : {}) });
  emitJobEvent({ type: 'result', data: result });
  process.exitCode = result.tests === 'failed' ? EXIT.failed : EXIT.ok;
}
