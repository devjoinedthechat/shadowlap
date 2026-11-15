import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fitLine, Store, whole } from '@shadowlap/engine';
import { STOP_SIGNALS } from '../agent-signals.js';
import { CliError, EXIT, signalExit, usageError } from '../exit-codes.js';
import { shortFixId } from '../fix-format.js';
import { columnsOf, palette as p, quoteArgv, shortId } from '../ui.js';
import { startScriptedModel } from './model.js';
import { BUG_ORDERS, demoFiles, GOOD_ORDER } from './project.js';

/**
 * `shadowlap demo`: the refund story of the README, run for real in a folder of its own. It writes
 * the refund agent there, makes it a git repository (repair rewrites the agent's source), starts the
 * scripted model, and runs this CLI's own commands one after another, each printing as it would in
 * a terminal: record the agent refunding $240 against its policy, replay it with nothing sent,
 * blame the model call that lost it, repair it with the scripted model as the repairer, and apply
 * the fix it proved. Every line under a command is that command's own output.
 */

export interface DemoOptions {
  /** Keep the folder here instead of a temporary one that is removed at the end. */
  keep?: string;
  /** How to start this CLI: Node and the entry point it was started with. */
  cli: readonly string[];
  /** Where the demo's own lines go: the commands it runs write to the terminal themselves. */
  write?: (text: string) => void;
}

/** A step whose command ended otherwise than the story needs: the demo stops there, with its status. */
class StepFailed extends CliError {}

/** The folder `--keep` names: a new one, or an empty one, never one holding something else. */
function keepFolder(raw: string): string {
  const dir = resolve(raw);
  if (existsSync(dir)) {
    if (readdirSync(dir).length) throw usageError(`--keep: ${dir} is not empty; name a new folder, or an empty one`);
  } else mkdirSync(dir, { recursive: true });
  return realpathSync(dir);
}

/** How the narration counts the orders. */
const NUMBERS = ['no', 'one', 'two', 'three', 'four', 'five'];

/** Variables of this machine's own setup that would reach the demo's commands and their agent: model keys and endpoints, shadowlap's own. */
const LEAKS = /^(ANTHROPIC_|OPENAI_|AZURE_OPENAI_|GEMINI_|GOOGLE_API_KEY$|GOOGLE_GEMINI_BASE_URL$|SHADOWLAP_UPSTREAM_|SHADOWLAP_URL$|SHADOWLAP_RUN_ID$|SHADOWLAP_SCOPE$|SHADOWLAP_EVENTS_FD$)/;

/**
 * What blame's probes on `runId` say, in one line, from the blame it keeps on the run: the call it
 * blamed, rescued, and the next one probed, lost, each with its tally, and how to read their rates.
 * Null when the run holds no such blame.
 */
export function probeReading(db: string, runId: string): string | null {
  const store = Store.open(db);
  try {
    const blame = store.getRun(runId)?.meta?.blame;
    const at = blame?.probes.find((x) => x.callNo === blame.callNo && x.rescued);
    const next = blame?.probes.filter((x) => at && x.callNo > at.callNo && !x.rescued).sort((a, b) => a.callNo - b.callNo)[0];
    if (!at || !next) return null;
    return `Read a probe as: model call #${at.callNo}, asked again from forks, passed ${at.passes} of ${at.attempts} attempts, and passes at least the rate shown, at the confidence in brackets: often enough that a better answer there saves the run, rescued. #${next.callNo} passed ${next.passes} of ${next.attempts}, and passes at most its rate: too rarely to save it there, lost.`;
  } finally {
    store.close();
  }
}

/** Where the scripted model's requests went, in one line: the recordings', and each step's after them. */
export function requestsLine(asked: { recorded: number; replayed: number; blame: number; repair: number; applied: number }, runs: number): string {
  const none = [...(asked.replayed ? [] : ['the replay']), ...(asked.applied ? [] : ["the goldens' test"])];
  const parts = [
    `${asked.recorded} recorded the ${NUMBERS[runs] ?? runs} runs`,
    ...(asked.replayed ? [`${asked.replayed} came from the replay`] : []),
    `${asked.blame} were blame's attempts, each asking again from its fork on`,
    `${asked.repair} were repair's: blaming the other failing run, asking the repairer, and verify's attempts`,
    ...(asked.applied ? [`${asked.applied} came from the goldens' test`] : []),
  ];
  return `${parts.join(', ')}${none.length ? `; ${none.join(' and ')} sent none` : ''}. A real model is paid for these, and not for what the forks replayed.`;
}

/**
 * The demo's own lines as the terminal shows them: each wrapped at whole words to its width, its
 * indent kept and a command in one piece (`whole`); as written in a pipe or a file (no `columns`).
 */
export function narration(text: string, columns: number | null): string {
  return text.split('\n').flatMap((line) => fitLine(line, columns)).join('\n');
}

export async function runDemo(o: DemoOptions): Promise<number> {
  const write = o.write ?? ((text: string) => void process.stdout.write(text));
  // What the demo says, wrapped to the terminal; the commands it runs are shown as they are typed.
  const say = (text: string) => write(narration(text, columnsOf(process.stdout)));
  const started = Date.now();
  if (spawnSync('git', ['--version'], { stdio: 'ignore' }).status !== 0) throw usageError('shadowlap demo needs git: repair rewrites the agent in a git repository. Install git, then run it again');
  const dir = o.keep ? keepFolder(o.keep) : realpathSync(mkdtempSync(join(tmpdir(), 'shadowlap-demo-')));
  const model = await startScriptedModel();
  // Ctrl-C stops the command running then (it has the terminal too), and so does a closed terminal;
  // the demo waits for it, then removes its folder and ends as the signal would have ended it.
  let stopped: NodeJS.Signals | null = null;
  const onSignal = (signal: NodeJS.Signals) => void (stopped ??= signal);
  for (const s of STOP_SIGNALS) process.on(s, onSignal);
  try {
    for (const [name, text] of Object.entries(demoFiles(model.url))) writeFileSync(join(dir, name), text);
    const git = (...args: string[]) => {
      const r = spawnSync('git', ['-c', 'init.defaultBranch=main', '-c', 'user.name=shadowlap demo', '-c', 'user.email=demo@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' });
      if (r.status !== 0) throw new CliError(EXIT.failed, `git ${args[0]!} failed in ${dir}: ${(r.stderr || r.error?.message || '').trim()}`);
    };
    git('init', '-q');
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', 'The support agent');

    const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !LEAKS.test(k)));
    // `node` in a command is the Node this CLI runs on; the model is the scripted one; nothing is
    // counted, and the dashboard's project list on this machine is left as it is.
    env.PATH = `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`;
    env.SHADOWLAP_UPSTREAM_ANTHROPIC = model.url;
    env.SHADOWLAP_TELEMETRY = '0';
    env.SHADOWLAP_HOME = join(dir, '.shadowlap', 'home');

    const shadowlap = (args: string[]): Promise<number> =>
      new Promise((resolveCode) => {
        const child = spawn(o.cli[0]!, [...o.cli.slice(1), ...args], { cwd: dir, env, stdio: ['ignore', 'inherit', 'inherit'] });
        child.on('error', () => resolveCode(EXIT.internal));
        child.on('exit', (code, signal) => resolveCode(code ?? (signal ? signalExit(signal) : 1)));
      });
    const step = async (args: string[]): Promise<void> => {
      write(`\n${p.dim('$')} ${p.bold(quoteArgv(['shadowlap', ...args]))}\n`);
      const code = await shadowlap(args);
      if (stopped) throw new StepFailed(signalExit(stopped), `stopped by ${stopped}`);
      if (code !== 0) throw new StepFailed(code, `the demo stopped: shadowlap ${args[0]!} exited ${code}, which the story doesn't expect. Run it again with --keep <dir> to look at the folder it ran in`);
    };
    const newest = (): string => {
      const store = Store.open(join(dir, '.shadowlap', 'shadowlap.db'));
      try {
        return store.listRuns(1)[0]!.runId;
      } finally {
        store.close();
      }
    };

    say(`${p.bold('shadowlap demo')}: a support agent refunds $240 orders its policy sends to a manager. shadowlap records it, replays it for free, finds the model call that lost the run, and has a fix proposed and proven.\n`);
    say(p.dim(`The model is scripted, not a real one: a small server on ${new URL(model.url).host} answers in Anthropic's Messages API (and the repairer in OpenAI's), so no key is needed and nothing leaves this machine.\n`));
    say(p.dim(`Working in ${whole(dir)}, a git repository ${o.keep ? 'it keeps' : `removed at the end (${whole('--keep <dir>')} keeps it)`}.\n`));

    say(`\n${p.bold('1. Record')} the agent on ${NUMBERS[BUG_ORDERS.length] ?? BUG_ORDERS.length} $240 orders and one $60 order, and label them.\n`);
    const bugs: string[] = [];
    for (const order of BUG_ORDERS) {
      await step(['run', '--', 'node', 'agent.mjs', order]);
      bugs.push(newest());
    }
    await step(['run', '--', 'node', 'agent.mjs', GOOD_ORDER]);
    const good = newest();
    for (const id of bugs) await step(['label', shortId(id), 'refund-bug']);
    await step(['label', shortId(good), 'good']);

    // What each step asked of the scripted model, to say where the requests went.
    const asked = { recorded: model.requests, replayed: 0, blame: 0, repair: 0, applied: 0 };
    const since = (() => {
      let last = model.requests;
      return () => {
        const n = model.requests - last;
        last = model.requests;
        return n;
      };
    })();

    say(`\n${p.bold('2. Replay')} the first: every call is answered from the recording, the refund included, and nothing is sent.\n`);
    await step(['replay', shortId(bugs[0]!)]);
    asked.replayed = since();

    say(`\n${p.bold('3. Blame')} it: ask model calls again, each from a fork that replays everything before it, to find the one that lost the run.\n`);
    await step(['blame', shortId(bugs[0]!), '--expect', '@refund-check.json', '--concurrency', '4']);
    asked.blame = since();
    const reading = probeReading(join(dir, '.shadowlap', 'shadowlap.db'), bugs[0]!);
    if (reading) say(p.dim(`  ${reading}\n`));

    say(`\n${p.bold('4. Repair')} it: the scripted model proposes rewrites of the prompt and the tools, and repair keeps the one verify proves.\n`);
    await step(['repair', '--fixes', 'label:refund-bug', '--keeps', 'label:good', '--expect', '@refund-check.json', '--concurrency', '4']);
    asked.repair = since();

    const store = Store.open(join(dir, '.shadowlap', 'shadowlap.db'));
    const fix = store.listFixes().find((f) => f.status === 'verified');
    store.close();
    if (!fix) throw new StepFailed(EXIT.failed, 'the demo stopped: repair left no verified fix to apply');
    say(`\n${p.bold('5. Apply')} the verified fix: the patch goes into agent.mjs, the runs it fixed become goldens, and their test runs offline.\n`);
    await step(['fix', 'apply', shortFixId(fix.fixId)]);
    asked.applied = since();

    const seconds = Math.round((Date.now() - started) / 1000);
    say(`\n${p.green('✓')} Done in ${seconds} s, ${model.requests} requests to the scripted model, none to a real one.\n`);
    say(p.dim(`  ${requestsLine(asked, BUG_ORDERS.length + 1)}\n`));
    say(o.keep ? `  Kept in ${whole(dir)}: run ${whole('shadowlap dashboard')} there to look around.\n` : p.dim(`  The folder is removed. Run ${whole('shadowlap demo --keep <dir>')} to keep it, and open it with ${whole('shadowlap dashboard')}.\n`));
    say(p.dim(`  Your own agent: ${whole('npm install -g shadowlap')}, then ${whole('shadowlap init')} in its folder.\n`));
    return EXIT.ok;
  } finally {
    for (const s of STOP_SIGNALS) process.off(s, onSignal);
    await model.close();
    if (!o.keep) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
