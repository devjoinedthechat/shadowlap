import { resolve } from 'node:path';
import { Command, InvalidArgumentError } from 'commander';
import { recordEvent, resolveAuthor, type CoverageGroup } from '@shadowlap/engine';
import { loadConfig, loadTests } from '../config.js';
import { coverageJson, findGroup, formatCoverage, scanCoverage, shortPath, type PackJson } from '../coverage.js';
import { packGroup } from '../coverage-pack.js';
import { emitJobEvent } from '../job-events.js';
import { type GuardMode } from '../run-agent.js';
import { parseChoice, readStore, type GlobalOpts } from '../shared.js';
import { palette as p, quoteArgv, safe, shortId } from '../ui.js';

/** `shadowlap coverage`: what imported runs did that no golden covers, and `--pack` to make goldens of them. */

export function register(program: Command): void {
  program.commandsGroup('Test:');

  program
    .command('coverage')
    .description('Group imported runs (captures and traces of production traffic) by behaviour: the tools the model called in order, the writes among them, how the run ended. Lists the behaviours no golden covers; --pack makes a golden of one run of each. Each scan is kept in the store.')
    .argument('[command...]', "with --pack: the agent's command to reproduce each capture with (after \"--\"), when no recording here says it")
    .option('--json', 'print the scan as JSON: every behaviour, the goldens read, and with --pack what each became')
    .option('--pack [behaviours...]', 'make a golden of one run of each behaviour no golden covers (or of the behaviours named by key): the capture is replayed offline with the agent\'s command, its tool results taken from its own conversation, and packed into goldens/ when it reproduces')
    .option('--guard <mode>', 'network guard for the replays --pack makes: block, warn or off', parseChoice<GuardMode>(['block', 'warn', 'off']), 'block')
    .action(async (command: string[], flags: { json?: boolean; pack?: boolean | string[]; guard: GuardMode }) => {
      const opts = program.opts<GlobalOpts>();
      const projectDir = resolve(process.cwd());
      if (command.length && !flags.pack) throw new InvalidArgumentError('a command after -- is for --pack: it reproduces each capture before it is packed');
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
            const made = await packGroup(g, result.members, { store, projectDir, config, argv: command.length ? command : null, effectOf: (tool) => result.effects.get(tool) ?? null, guard: flags.guard, log: say });
            pack.push(made);
            if (made.golden) emitJobEvent({ type: 'file', path: resolve(projectDir, made.golden), label: 'Golden' });
            if (!flags.json) {
              const from = made.command ? (made.command.from === '--' ? '' : p.dim(` (the command of ${shortId(made.command.from)}, which sent the same first request)`)) : '';
              process.stdout.write(
                made.golden
                  ? `${p.green('✓')} ${shortPath(g.behaviour.path)}: packed ${safe(made.golden)} from ${shortId(made.from!)} with ${safe(quoteArgv(made.command!.argv))}${from}\n`
                  : `${p.red('✗')} ${shortPath(g.behaviour.path)}: not packed: ${safe(made.why ?? '')}\n`,
              );
            }
          }
          const packed = new Map(pack.filter((x) => x.golden && x.runId).map((x) => [x.key, { golden: x.golden!, runId: x.runId! }]));
          // The goldens just made cover their behaviours: the scan kept for the dashboard says so.
          if (packed.size) result = scanCoverage(store, { projectDir, tests, config, actor, packed });
          if (!flags.json && targets.length) process.stdout.write('\n');
        }
        // The activity feed's line: what the last scan found, and the goldens it packed.
        recordEvent(store, { kind: 'coverage.scanned', actor, ref: result.scan.scanId, data: { runs: result.scan.runs, groups: result.scan.groups, uncovered: result.scan.uncovered, goldens: result.scan.goldens, ...(pack ? { packed: pack.filter((x) => x.golden).length } : {}) } });
        const json = coverageJson(result, pack);
        if (flags.json) process.stdout.write(JSON.stringify(json, null, 2) + '\n');
        else process.stdout.write(formatCoverage(result, p) + '\n');
        emitJobEvent({ type: 'result', data: json });
        emitJobEvent({ type: 'link', label: 'Tests', href: '#/tests' });
        process.exitCode = pack?.some((x) => !x.golden) ? 1 : 0;
      } finally {
        store.close();
      }
    });
}
