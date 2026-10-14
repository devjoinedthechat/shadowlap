import { Command } from 'commander';
import { register as registerData } from './commands/data.js';
import { register as registerFix } from './commands/fix.js';
import { register as registerImport } from './commands/import.js';
import { register as registerInspect } from './commands/inspect.js';
import { register as registerRecord } from './commands/record.js';
import { register as registerSetup } from './commands/setup.js';
import { register as registerTesting } from './commands/testing.js';
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
    .showHelpAfterError()
    .addHelpText('after', '\nNew to Shadowlap? Run shadowlap init in your project, then shadowlap run -- <your agent command>.');

  // Help lists commands in the order of a first session: record, look, find and fix, test, set up, export.
  registerRecord(program);
  registerInspect(program);
  registerFix(program);
  registerTesting(program);
  registerSetup(program);
  program.helpCommand(true); // listed under "Set up:" rather than a group of its own
  registerImport(program);
  registerData(program);

  await program.parseAsync(argv);
}
