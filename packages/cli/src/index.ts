import { Command, CommanderError, Option } from 'commander';
import { guardAccept } from './config.js';
import { CliError, EXIT } from './exit-codes.js';
import { register as registerCheck } from './commands/check.js';
import { register as registerChanges } from './commands/changes.js';
import { register as registerCoverage } from './commands/coverage.js';
import { register as registerData } from './commands/data.js';
import { register as registerDemo } from './commands/demo.js';
import { register as registerFix } from './commands/fix.js';
import { register as registerImport } from './commands/import.js';
import { register as registerInjection } from './commands/injection.js';
import { register as registerInspect } from './commands/inspect.js';
import { register as registerRecord } from './commands/record.js';
import { register as registerSetup } from './commands/setup.js';
import { register as registerSkill } from './commands/skill.js';
import { register as registerTeam } from './commands/team.js';
import { register as registerTesting } from './commands/testing.js';
import { register as registerTraining } from './commands/training.js';
import { VERSION } from './shared.js';

export { captureConfig, guardEnv, type GuardMode } from './run-agent.js';
export { hasCredentials, keyEnvOf, placeholderKeys } from './placeholder-keys.js';
export { quoteArgv } from './ui.js';
// What `shadowlap test --json` writes, for tools that read it (the GitHub Action among them).
export type { PackResult, TestReport } from './test-report.js';
// The exit status contract, for the entry point (bin/shadowlap.js) and for tools that run the CLI.
export { afterPendingSignals, CliError, EXIT, exitCodeOf, reportError, runToEnd, signalExit, stoppedBy, watchStopSignals } from './exit-codes.js';

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

  // Help lists commands in the order of a first session: the demo, then record, look, find and fix, test, set up, export.
  registerDemo(program);
  registerRecord(program);
  registerInspect(program);
  registerFix(program);
  // Preview a change (decisions, migrate): after finding and fixing, before testing.
  registerChanges(program);
  registerTesting(program);
  // Under Test: recordings judged by checks, nothing replayed.
  registerCheck(program);
  // Injection tests sit with the tests: `shadowlap injection`, and the gate `test` runs for a golden.
  registerInjection(program);
  // Production coverage joins the Test group: what imported runs did that no golden covers.
  registerCoverage(program);
  registerSetup(program);
  // The coding agents' plugin and rule, under "Set up:" too.
  registerSkill(program);
  program.helpCommand(true); // listed under "Set up:" rather than a group of its own
  registerImport(program);
  registerData(program);
  // After data: `export pairs` joins the export command it registers.
  registerTraining(program);
  registerTeam(program);
  acceptGlobalOptionsAfterCommands(program);
  usageErrorsExit2(program);

  await program.parseAsync(argv);
}

/**
 * Commander's own errors (an unknown flag or command, a missing argument, a value its parser
 * refused, a command group named with no command) end with status 2, after commander has printed
 * them with the command's usage; --help and --version end with 0. Without this, commander ends the
 * process itself, with 1.
 */
function usageErrorsExit2(program: Command): void {
  const walk = (command: Command) => {
    command.exitOverride((err: CommanderError) => {
      throw new CliError(err.exitCode === 0 ? EXIT.ok : EXIT.usage, err.message, { cause: err, reported: true });
    });
    for (const sub of command.commands) walk(sub);
  };
  walk(program);
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
    // A command that runs an agent under the guard checks what the guard accepts unwatched as it
    // starts (guard.accept, SHADOWLAP_GUARD_ACCEPT): a value it can't take ends it with 2, before
    // anything runs.
    if (action.options.some((o) => o.long === '--guard')) guardAccept();
  });
}
