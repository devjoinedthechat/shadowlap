import { resolve } from 'node:path';
import { Command, InvalidArgumentError } from 'commander';
import { checkCommandTemplate, recordEvent, resolveAuthor, type CoverageGroup } from '@shadowlap/engine';
import { loadConfig, loadTests } from '../config.js';
import { coverageJson, findGroup, formatCoverage, scanCoverage, shortPath } from '../coverage.js';
import { packGroup, type PackJson } from '../coverage-pack.js';
import { emitJobEvent } from '../job-events.js';
import { type GuardMode } from '../run-agent.js';
import { parseChoice, readStore, type GlobalOpts } from '../shared.js';
import { palette as p, quoteArgv, safe, shortId } from '../ui.js';
import { readExpectJson } from './fix.js';

/** `shadowlap coverage`: what imported runs did that no golden covers, and `--pack` to make goldens of them. */

interface CoverageFlags {
  json?: boolean;
  pack?: boolean | string[];
  fork?: boolean;
  expect?: string;
  notPacked: 'fail' | 'warn';
  guard: GuardMode;
}

export function register(program: Command): void {
  program.commandsGroup('Test:');

  program
    .command('coverage')
    .description('Group imported runs (captures and traces of production traffic) by behaviour: the tools the model called in order, the writes among them, how the run ended. Lists the behaviours no golden covers; --pack makes a golden of one run of each. Each scan is kept in the store.')
    .argument('[command...]', "with --pack: the agent's command to reproduce each capture with (after \"--\"), when no run here says it; {message} in it stands for the capture's first message, {message:/regex/} for the part of it the regex picks")
    .option('--json', 'print the scan as JSON: every behaviour, the goldens read, and with --pack what each became')
    .option('--pack [behaviours...]', "make a golden of one run of each behaviour no golden covers (or of the behaviours named by key): the capture is replayed offline with the agent's command, its tool results taken from its own conversation, and packed into goldens/ when it reproduces")
    .option('--fork', "with --pack and the behaviours named: pack each as a golden that forks, judged by --expect, even when the agent no longer does what production did (the test that the change holds, on production's input)")
    .option('--expect <checks>', 'with --fork: what the agent must do on that input now, as JSON or @file.json, written to the new golden\'s tests entry, such as \'{"tools":{"issue_refund":0}}\'')
    .option('--not-packed <policy>', 'with --pack: what a behaviour that could not be packed does to the exit status: fail or warn', parseChoice<'fail' | 'warn'>(['fail', 'warn']), 'fail')
    .option('--guard <mode>', 'network guard for the replays --pack makes: block, warn or off', parseChoice<GuardMode>(['block', 'warn', 'off']), 'block')
    .action(async function (this: Command, command: string[], flags: CoverageFlags) {
      const opts = program.opts<GlobalOpts>();
      const projectDir = resolve(process.cwd());
      if (command.length && !flags.pack) throw new InvalidArgumentError('a command after -- is for --pack: it reproduces each capture before it is packed');
      if (!flags.pack && (flags.fork || flags.expect !== undefined)) throw new InvalidArgumentError('--fork and --expect go with --pack');
      if (this.getOptionValueSource('notPacked') === 'cli' && !flags.pack) throw new InvalidArgumentError('--not-packed goes with --pack');
      if (flags.fork && flags.pack === true) throw new InvalidArgumentError('--fork packs the behaviours you name: give their keys after --pack (shadowlap coverage lists them), so each golden that forks is one you chose');
      if (flags.fork && flags.expect === undefined) throw new InvalidArgumentError('--fork needs --expect: the checks that say what the agent must do on that input now, such as \'{"tools":{"issue_refund":0}}\'');
      if (flags.expect !== undefined && !flags.fork) throw new InvalidArgumentError('--expect goes with --fork: a golden that replays its capture is judged by the replay itself');
      const template = checkCommandTemplate(command);
      if (template) throw new InvalidArgumentError(template);
      let fork: { expect: Record<string, unknown> } | null = null;
      if (flags.fork) {
        const { json } = readExpectJson(flags.expect!);
        if (typeof json !== 'object' || json === null || Array.isArray(json) || !Object.keys(json).length) throw new InvalidArgumentError('--expect: give at least one check, such as \'{"tools":{"issue_refund":0}}\'');
        fork = { expect: json as Record<string, unknown> };
      }
      const config = loadConfig(projectDir);
      const tests = loadTests(projectDir);
      const store = readStore(opts);
      const actor = resolveAuthor({ cwd: projectDir });
      let pack: PackJson[] | null = null;
      try {
        let result = scanCoverage(store, { projectDir, tests, config, actor });
        if (flags.pack) {
          let targets: CoverageGroup[];
          if (flags.pack === true) targets = result.groups.filter((g) => !g.coveredBy.length);
          else {
            targets = [];
            for (const key of flags.pack) {
              const g = findGroup(result.groups, key);
              if ('error' in g) throw new InvalidArgumentError(g.error);
              if (g.coveredBy.length) throw new InvalidArgumentError(`behaviour ${g.key} is covered already, by ${g.coveredBy.join(', ')}`);
              if (!targets.includes(g)) targets.push(g);
            }
          }
          pack = [];
          const say = (line: string) => process.stderr.write(p.dim(`${line}\n`));
          if (!targets.length) say(`[shadowlap] ${result.scan.runs ? 'every behaviour has a golden: nothing to pack' : 'no imported runs: nothing to pack'}`);
          for (const g of targets) {
            const made = await packGroup(g, result.members, { store, projectDir, config, argv: command.length ? command : null, effectOf: (tool) => result.effects.get(tool) ?? null, guard: flags.guard, fork, finder: result.finder, log: say });
            pack.push(made);
            if (made.golden) emitJobEvent({ type: 'file', path: resolve(projectDir, made.golden), label: made.mode === 'fork' ? 'Golden that forks' : 'Golden' });
            if (!flags.json) process.stdout.write(`${packLine(g, made)}\n`);
          }
          // The scan kept for the dashboard counts the goldens just made, and keeps why the rest weren't.
          if (targets.length) result = scanCoverage(store, { projectDir, tests: loadTests(projectDir), config, actor, pack, finder: result.finder });
          if (!flags.json && targets.length) process.stdout.write('\n');
        }
        // The activity feed's line: what the last scan found, and the goldens it packed.
        recordEvent(store, { kind: 'coverage.scanned', actor, ref: result.scan.scanId, data: { runs: result.scan.runs, groups: result.scan.groups, uncovered: result.scan.uncovered, goldens: result.scan.goldens, ...(pack ? { packed: pack.filter((x) => x.golden).length, notPacked: pack.filter((x) => !x.golden).length } : {}) } });
        const json = coverageJson(result, pack);
        if (flags.json) process.stdout.write(JSON.stringify(json, null, 2) + '\n');
        else process.stdout.write(formatCoverage(result, p, { packed: !!pack?.length }) + '\n');
        emitJobEvent({ type: 'result', data: json });
        emitJobEvent({ type: 'link', label: 'Tests', href: '#/tests' });
        const unpacked = pack?.filter((x) => !x.golden).length ?? 0;
        if (unpacked && flags.notPacked === 'warn' && !flags.json) process.stdout.write(p.dim(`${unpacked} not packed: reported, not failed (--not-packed warn)\n`));
        process.exitCode = unpacked && flags.notPacked === 'fail' ? 1 : 0;
      } finally {
        store.close();
      }
    });
}

/** What `--pack` made of one behaviour, in a line: the golden, or why not and what would pack it. */
function packLine(g: CoverageGroup, made: PackJson): string {
  const path = shortPath(g.behaviour.path);
  if (made.golden) {
    const from = made.command?.from === '--' ? '' : p.dim(` (the command of ${shortId(made.command!.from)}, which sent the same first request)`);
    const forks = made.mode === 'fork' ? p.dim(' · a golden that forks, judged by --expect') : '';
    return `${p.green('✓')} ${path}: packed ${safe(made.golden)} from ${shortId(made.from!)} with ${safe(quoteArgv(made.command!.argv))}${from}${forks}`;
  }
  const lines = [`${p.red('✗')} ${path}: not packed: ${safe(made.why ?? '')}`];
  // The agent no longer does this: keeping it takes the checks that say what it must do instead.
  if (made.reason === 'not-reproduced') lines.push(p.dim(`    to keep it as the test that the change holds: shadowlap coverage --pack ${g.key.slice(0, 8)} --fork --expect '<what it must do now>'${made.command?.from === '--' ? ' -- <the same command>' : ''}`));
  return lines.join('\n');
}
