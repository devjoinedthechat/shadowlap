import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { Store } from '@shadowlap/engine';
import { CliError, EXIT, signalExit, usageError } from '../exit-codes.js';
import { shortFixId } from '../fix-format.js';
import { palette as p, quoteArgv, shortId } from '../ui.js';
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

/** Variables of this machine's own setup that would reach the demo's commands and their agent: model keys and endpoints, Shadowlap's own. */
const LEAKS = /^(ANTHROPIC_|OPENAI_|AZURE_OPENAI_|GEMINI_|GOOGLE_API_KEY$|GOOGLE_GEMINI_BASE_URL$|SHADOWLAP_UPSTREAM_|SHADOWLAP_URL$|SHADOWLAP_RUN_ID$|SHADOWLAP_SCOPE$|SHADOWLAP_EVENTS_FD$)/;

export async function runDemo(o: DemoOptions): Promise<number> {
  const write = o.write ?? ((text: string) => void process.stdout.write(text));
  const started = Date.now();
  if (spawnSync('git', ['--version'], { stdio: 'ignore' }).status !== 0) throw usageError('shadowlap demo needs git: repair rewrites the agent in a git repository. Install git, then run it again');
  const dir = o.keep ? keepFolder(o.keep) : realpathSync(mkdtempSync(join(tmpdir(), 'shadowlap-demo-')));
  const model = await startScriptedModel();
  // Ctrl-C stops the command running then (it has the terminal too); the demo waits for it, then
  // removes its folder and ends as the signal would have ended it.
  let stopped: NodeJS.Signals | null = null;
  const onSignal = (signal: NodeJS.Signals) => void (stopped ??= signal);
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    for (const [name, text] of Object.entries(demoFiles(model.url))) writeFileSync(join(dir, name), text);
    const git = (...args: string[]) => {
      const r = spawnSync('git', ['-c', 'init.defaultBranch=main', '-c', 'user.name=Shadowlap demo', '-c', 'user.email=demo@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' });
      if (r.status !== 0) throw new CliError(EXIT.failed, `git ${args[0]} failed in ${dir}: ${(r.stderr || r.error?.message || '').trim()}`);
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
      if (code !== 0) throw new StepFailed(code, `the demo stopped: shadowlap ${args[0]} exited ${code}, which the story doesn't expect. Run it again with --keep <dir> to look at the folder it ran in`);
    };
    const newest = (): string => {
      const store = Store.open(join(dir, '.shadowlap', 'shadowlap.db'));
      try {
        return store.listRuns(1)[0]!.runId;
      } finally {
        store.close();
      }
    };

    write(`${p.bold('Shadowlap demo')}: a support agent refunds $240 orders its policy sends to a manager. Shadowlap records it, replays it for free, finds the model call that lost the run, and has a fix proposed and proven.\n`);
    write(p.dim(`The model is scripted, not a real one: a small server on ${new URL(model.url).host} answers in Anthropic's Messages API (and the repairer in OpenAI's), so no key is needed and nothing leaves this machine.\n`));
    write(p.dim(`Working in ${dir}, a git repository ${o.keep ? 'it keeps' : 'removed at the end (--keep <dir> keeps it)'}.\n`));

    write(`\n${p.bold('1. Record')} the agent on ${NUMBERS[BUG_ORDERS.length] ?? BUG_ORDERS.length} $240 orders and one $60 order, and label them.\n`);
    const bugs: string[] = [];
    for (const order of BUG_ORDERS) {
      await step(['run', '--', 'node', 'agent.mjs', order]);
      bugs.push(newest());
    }
    await step(['run', '--', 'node', 'agent.mjs', GOOD_ORDER]);
    const good = newest();
    for (const id of bugs) await step(['label', shortId(id), 'refund-bug']);
    await step(['label', shortId(good), 'good']);

    write(`\n${p.bold('2. Replay')} the first: every call is answered from the recording, the refund included, and nothing is sent.\n`);
    await step(['replay', shortId(bugs[0]!)]);

    write(`\n${p.bold('3. Blame')} it: ask model calls again, each from a fork that replays everything before it, to find the one that lost the run.\n`);
    await step(['blame', shortId(bugs[0]!), '--expect', '@refund-check.json', '--concurrency', '4']);

    write(`\n${p.bold('4. Repair')} it: the scripted model proposes rewrites of the prompt and the tools, and repair keeps the one verify proves.\n`);
    await step(['repair', '--fixes', 'label:refund-bug', '--keeps', 'label:good', '--expect', '@refund-check.json', '--concurrency', '4']);

    const store = Store.open(join(dir, '.shadowlap', 'shadowlap.db'));
    const fix = store.listFixes().find((f) => f.status === 'verified');
    store.close();
    if (!fix) throw new StepFailed(EXIT.failed, 'the demo stopped: repair left no verified fix to apply');
    write(`\n${p.bold('5. Apply')} the verified fix: the patch goes into agent.mjs, the runs it fixed become goldens, and their test runs offline.\n`);
    await step(['fix', 'apply', shortFixId(fix.fixId)]);

    const seconds = Math.round((Date.now() - started) / 1000);
    write(`\n${p.green('✓')} Done in ${seconds} s, ${model.requests} requests to the scripted model, none to a real one.\n`);
    write(o.keep ? `  Kept in ${dir}: run shadowlap dashboard there to look around.\n` : p.dim('  The folder is removed. Run shadowlap demo --keep <dir> to keep it, and open it with shadowlap dashboard.\n'));
    write(p.dim('  Your own agent: npm install -g shadowlap, then shadowlap init in its folder.\n'));
    return EXIT.ok;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    await model.close();
    if (!o.keep) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
