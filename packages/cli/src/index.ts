import { Command, Option } from 'commander';
import { register as registerCheck } from './commands/check.js';
import { register as registerData } from './commands/data.js';
import { register as registerFix } from './commands/fix.js';
import { register as registerImport } from './commands/import.js';
import { register as registerInspect } from './commands/inspect.js';
import { register as registerRecord } from './commands/record.js';
import { register as registerSetup } from './commands/setup.js';
import { register as registerTeam } from './commands/team.js';
import { register as registerTesting } from './commands/testing.js';
import { register as registerTraining } from './commands/training.js';
import { VERSION } from './shared.js';

export { captureConfig, guardEnv, placeholderAwsCredentials, type GuardMode } from './run-agent.js';
export { quoteArgv } from './ui.js';

export async function main(argv: string[]): Promise<void> {
  const program = new Command()
    .name('shadowlap')
    .description('Record, replay and fork AI agent runs.')
    .version(VERSION)
    .option('--db <path>', 'store path (default: ./.shadowlap/shadowlap.db)')
    .option('-v, --verbose', 'log sidecar activity to stderr')
    .enablePositionalOptions()
    // Each command's help lists the global options too, which it also takes after its own name.
    .configureHelp({ showGlobalOptions: true })
    .showHelpAfterError()
    .addHelpText('after', '\nNew to Shadowlap? Run shadowlap init in your project, then shadowlap run -- <your agent command>.');

  // Help lists commands in the order of a first session: record, look, find and fix, test, set up, export.
  registerRecord(program);
  registerInspect(program);
  registerFix(program);
  registerTesting(program);
  // Under Test: recordings judged by checks, nothing replayed.
  registerCheck(program);
  registerSetup(program);
  program.helpCommand(true); // listed under "Set up:" rather than a group of its own
  registerImport(program);
  registerData(program);
  // After data: `export pairs` joins the export command it registers.
  registerTraining(program);
  registerTeam(program);
  acceptGlobalOptionsAfterCommands(program);

  await program.parseAsync(argv);
}

/**
 * The global options work after the command too (`shadowlap ls --db other.db`, `shadowlap replay
 * <run> -v`), as the reference lists them for every command: each command takes them, hidden from
 * its own help, and what it was given becomes the program's, the nearest to the command winning.
 */
function acceptGlobalOptionsAfterCommands(program: Command): void {
  const walk = (command: Command) => {
    for (const sub of command.commands) {
      if (!sub.options.some((o) => o.long === '--db')) sub.addOption(new Option('--db <path>', 'store path').hideHelp());
      if (!sub.options.some((o) => o.long === '--verbose' || o.short === '-v')) sub.addOption(new Option('-v, --verbose', 'log sidecar activity to stderr').hideHelp());
      walk(sub);
    }
  };
  walk(program);
  program.hook('preAction', (_program, action) => {
    let db: string | undefined;
    let verbose = false;
    for (let c: Command | null = action; c && c !== program; c = c.parent) {
      const given = c.opts<{ db?: string; verbose?: boolean }>();
      db ??= given.db;
      verbose ||= given.verbose === true;
    }
    if (db !== undefined) program.setOptionValue('db', db);
    if (verbose) program.setOptionValue('verbose', true);
  });
}
