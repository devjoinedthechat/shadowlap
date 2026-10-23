import type { Command } from 'commander';
import { runDemo } from '../demo/run.js';

/** `shadowlap demo`: the whole loop on a refund agent, in a folder of its own, with a scripted model. */
export function register(program: Command): void {
  program.commandsGroup('Try it:');

  program
    .command('demo')
    .description('See the whole loop in about half a minute, with no key: a refund agent recorded, replayed for free, blamed and repaired, against a scripted model on 127.0.0.1')
    .option('--keep <dir>', "keep the demo's folder here (a new or empty one) instead of removing it at the end")
    .action(async (flags: { keep?: string }) => {
      process.exitCode = await runDemo({ ...(flags.keep !== undefined ? { keep: flags.keep } : {}), cli: [process.execPath, process.argv[1]!] });
    });
}
