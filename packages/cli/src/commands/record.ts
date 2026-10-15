import { writeFileSync } from 'node:fs';
import { Command, InvalidArgumentError } from 'commander';
import { commandIsImported, formatDivergence, hasRecordedCommand, formatRepeats, normalizeResponse, proposeNormalizers, summarizeRepeats, type Normalizer, type Proposal, type ReadPolicy, type ReplayOptions, type WritePolicy } from '@shadowlap/engine';
import { logActivity } from '../activity.js';
import { overrideSources } from '@shadowlap/engine';
import { codeVersion, configPath, loadConfig, saveConfig } from '../config.js';
import { emitJobEvent } from '../job-events.js';
import { discoverSidecar, parseEffectFlags, startMcpProxy } from '../mcp.js';
import { watchAndRerun } from '../watch.js';
import { parseFailures, parseInterventions, parseOverrides, providerIds, repeatUnderSidecar, runUnderSidecar, testAttempt, type GuardMode } from '../run-agent.js';
import { confirmImportedCommand, openStore, parseChoice, parseIntArg, printOutcome, requireRun, type GlobalOpts } from '../shared.js';
import { palette as p, quoteArgv, safe, shortId } from '../ui.js';

/** Recording a run, replaying it after a change, and making replays match. */

export function register(program: Command): void {
  program.commandsGroup('Record and replay:');

  program
    .command('run')
    .description('Record a run: shadowlap run -- <command> [args...]')
    .argument('<command...>', 'the agent command to run')
    .option('--guard <mode>', 'network guard: warn about outbound connections that bypass Shadowlap, or off', parseChoice<GuardMode>(['warn', 'off']), 'warn')
    .option('--summary-json <file>', 'also write the run\'s summary as JSON to <file> (for scripts and coding agents)')
    .passThroughOptions()
    .action(async (argv: string[], flags: { guard: GuardMode; summaryJson?: string }) => {
      const opts = program.opts<GlobalOpts>();
      const { code, summary } = await runUnderSidecar(
        opts,
        argv,
        (sidecar) => sidecar.startRun({ mode: 'record', command: { argv, cwd: process.cwd() }, codeVersion: codeVersion(process.cwd()) }),
        flags.guard,
      );
      printOutcome(summary);
      if (flags.summaryJson) writeFileSync(flags.summaryJson, JSON.stringify({ exitCode: code, summary }, null, 2) + '\n');
      process.exitCode = code;
    });

  program
    .command('replay')
    .description('Replay a recorded run; forks at the first changed call. Re-runs the recorded command unless one follows "--".')
    .argument('<run>', 'run id or unique prefix')
    .argument('[command...]', 'override the recorded command (after "--")')
    .option('--strict', 'exit 1 if the replay diverges (for CI)')
    .option('--writes <policy>', 'what write tools do after divergence: block | stub | allow', parseChoice<WritePolicy>(['block', 'stub', 'allow']), 'block')
    .option('--reads <policy>', 'what read tools do after divergence: live | replay', parseChoice<ReadPolicy>(['live', 'replay']), 'live')
    .option('--live-tool <name>', 'force this tool\'s first call live (repeatable)', (v: string, acc: string[]) => [...acc, v], [] as string[])
    .option('--diverge-at <call>', 'force call number <call> live', parseIntArg)
    .option('--prompt-from <call>', 'apply your changed system prompt and tool definitions only from model call <call>: earlier model calls replay from the recording', parseIntArg)
    .option('--override <call=result>', 'substitute a recorded tool result: 9=\'{"ok":true}\' or 9=@file.json (repeatable)', (v: string, acc: string[]) => [...acc, v], [] as string[])
    .option('--fail-at <call=status>', 'answer model call <call> with an HTTP failure instead of the recording: 12=429 (repeatable)', (v: string, acc: string[]) => [...acc, v], [] as string[])
    .option('--watch', 'replay again whenever a file in the project changes')
    .option('--inject <call=text>', 'append an instruction at model call <call> and keep it in place afterwards: 15="Prefer sources from 2026"')
    .option('--inject-as <role>', 'how to inject: system (a role:"system" message; Opus 5, Opus 4.8, Fable 5.x) or user (a text block on the last user message)', parseChoice(['system', 'user'] as const), 'system')
    .option('--set <call:key=value>', 'set a top-level request field from model call <call> on: 15:max_tokens=2048 (repeatable; value is JSON or a string)', (v: string, acc: string[]) => [...acc, v], [] as string[])
    .option('--model <call:model>', 'switch the model from model call <call> on: 15:claude-opus-5')
    .option('--guard <mode>', 'network guard for connections that bypass Shadowlap: warn | block | off', parseChoice<GuardMode>(['warn', 'block', 'off']), 'warn')
    .option('-y, --yes', 'run the recorded command of an imported run without asking')
    .option('--repeat <n>', 'run the replay n times and report how the attempts differ after the fork', parseIntArg)
    .option('--concurrency <n>', 'with --repeat: attempts running at once', parseIntArg, 1)
    .option('--summary-json <file>', 'also write the replay\'s summary (or, with --repeat, every attempt and the report) as JSON to <file>')
    .action(async (runArg: string, command: string[], flags: { strict?: boolean; writes: WritePolicy; reads: ReadPolicy; liveTool: string[]; divergeAt?: number; promptFrom?: number; override: string[]; failAt: string[]; watch?: boolean; inject?: string; injectAs: 'system' | 'user'; set: string[]; model?: string; guard: GuardMode; yes?: boolean; repeat?: number; concurrency: number; summaryJson?: string }) => {
      const opts = program.opts<GlobalOpts>();
      const store = openStore(opts);
      const parent = requireRun(store, runArg);
      const parentCalls = store.getCalls(parent.runId);
      const overrides = parseOverrides(flags.override, parentCalls);
      // The run keeps the file an override came from (`16=@policy.json`), never the result itself.
      const sources = overrideSources(flags.override);
      const failures = parseFailures(flags.failAt, parentCalls);
      const interventions = parseInterventions(flags, parentCalls);
      if (flags.promptFrom !== undefined) {
        const target = parentCalls.find((c) => c.callNo === flags.promptFrom);
        if (!target || target.kind !== 'api') {
          store.close();
          throw new InvalidArgumentError(`--prompt-from: call #${flags.promptFrom} is not a model call of ${shortId(parent.runId)} (see shadowlap show ${shortId(parent.runId)})`);
        }
        // Reasoning a model produced under the old prompt goes back to it with the new one.
        const reasoned = parentCalls.some((c) => {
          if (c.kind !== 'api' || c.callNo >= flags.promptFrom! || !c.end?.responseRef) return false;
          const provider = c.end.meta.provider ?? c.meta.provider;
          return normalizeResponse(store.getBlob(c.end.responseRef), c.end.meta.headers?.['content-type'], c.end.meta.chunks ?? [], typeof provider === 'string' ? provider : undefined).blocks.some((b) => b.type === 'thinking');
        });
        if (reasoned) process.stderr.write(p.yellow(`! Model calls before #${flags.promptFrom} include reasoning produced under the old prompt. A provider that binds reasoning to the prompt it came from may refuse call #${flags.promptFrom}; if it does, fork from a call before the first reasoning.\n`));
      }
      store.close();
      // A run built from a capture never knew what started the agent. Spawning its placeholder would
      // fail and still record a failed run with no calls, which is worse than refusing.
      if (!command.length && !hasRecordedCommand(parent)) {
        throw new InvalidArgumentError(
          `${shortId(parent.runId)} was imported from a capture, which records what was sent but not what sent it, so it has no command to re-run. Give yours after --:\n  shadowlap replay ${shortId(parent.runId)} -- python agent.py\nThat replay records everything, tool calls included, so it has a command of its own and every fork works on it.`,
        );
      }
      const argv = command.length ? command : parent.command.argv;
      // A run imported from a pack carries a command someone else chose; running it needs consent.
      const commandFromImport = !command.length && commandIsImported(parent);
      if (commandFromImport && !flags.yes && !(await confirmImportedCommand(parent.runId, argv))) {
        process.exitCode = 1;
        return;
      }
      const replay: Partial<ReplayOptions> = { writes: flags.writes, reads: flags.reads, liveTools: new Set(flags.liveTool) };
      // A partial recording (an import that only saw the network) declares what it covers; everything else runs live.
      if (parent.meta?.covers?.length) replay.kinds = new Set(parent.meta.covers);
      if (flags.divergeAt !== undefined) replay.divergeAt = flags.divergeAt;
      if (flags.promptFrom !== undefined) replay.promptFrom = flags.promptFrom;
      if (overrides.size) replay.overrides = overrides;
      if (failures.size) replay.failAt = failures;
      if (flags.repeat !== undefined && flags.repeat > 1) {
        if (flags.repeat > 100) throw new InvalidArgumentError('--repeat is at most 100');
        if (flags.watch) throw new InvalidArgumentError('--watch and --repeat both re-run the replay; use one of them');
        const attempts = await repeatUnderSidecar(
          opts,
          argv,
          flags.repeat,
          flags.concurrency,
          (sidecar) => sidecar.startRun({ mode: 'replay', parentRunId: parent.runId, command: { argv, cwd: process.cwd() }, codeVersion: codeVersion(process.cwd()), replay, ...(interventions ? { interventions } : {}), ...(commandFromImport ? { commandFromImport: true } : {}), overrideSources: sources }),
          flags.guard,
        );
        const reader = openStore(opts);
        const report = summarizeRepeats(
          parent.runId,
          attempts.map((a) => ({ runId: a.run.runId, exitCode: a.code, summary: a.summary, calls: reader.getCalls(a.run.runId) })),
          {
            // Compare what the model said, not the response bytes: those carry per-response ids.
            responseContent: (call) => {
              const end = call.end;
              if (!end?.responseRef) return null;
              const provider = end.meta.provider ?? call.meta.provider;
              const r = normalizeResponse(reader.getBlob(end.responseRef), end.meta.headers?.['content-type'], end.meta.chunks ?? [], typeof provider === 'string' ? provider : undefined);
              return r.blocks.length ? JSON.stringify(r.blocks) : end.responseRef;
            },
          },
        );
        reader.close();
        const first = attempts.find((a) => a.summary.divergence)?.summary.divergence;
        process.stderr.write('\n' + (first ? formatDivergence(first, p) + '\n\n' : '') + formatRepeats(report, p) + '\n');
        if (flags.summaryJson) writeFileSync(flags.summaryJson, JSON.stringify({ attempts: attempts.map((a) => ({ exitCode: a.code, summary: a.summary })), report }, null, 2) + '\n');
        emitJobEvent({ type: 'result', data: { attempts: attempts.map((a) => ({ runId: a.run.runId, exitCode: a.code, summary: a.summary })), report } });
        emitJobEvent({ type: 'link', label: 'Open the attempts', href: `#/run/${parent.runId}/${first?.callNo ?? 1}/forks` });
        const anyDiverged = attempts.some((a) => a.summary.divergence);
        process.exitCode = flags.strict && anyDiverged ? 1 : attempts.length < flags.repeat || attempts.some((a) => a.code !== 0) ? 1 : 0;
        return;
      }
      const once = async (): Promise<void> => {
        const { code, summary } = await runUnderSidecar(
          opts,
          argv,
          (sidecar) => sidecar.startRun({ mode: 'replay', parentRunId: parent.runId, command: { argv, cwd: process.cwd() }, codeVersion: codeVersion(process.cwd()), replay, ...(interventions ? { interventions } : {}), ...(commandFromImport ? { commandFromImport: true } : {}), overrideSources: sources }),
          flags.guard,
        );
        printOutcome(summary);
        if (flags.summaryJson) writeFileSync(flags.summaryJson, JSON.stringify({ exitCode: code, summary }, null, 2) + '\n');
        process.exitCode = flags.strict && summary.divergence ? 1 : code;
      };

      await once();
      if (!flags.watch) return;
      // The prefix before a fork replays for free, so re-running after every edit costs nothing.
      await watchAndRerun({
        cwd: process.cwd(),
        log: (m) => process.stderr.write(`\n${p.dim(m)}\n`),
        onChange: async () => {
          process.stderr.write(`\n${p.dim('\u2500'.repeat(40))}\n`);
          await once();
        },
      });
    });

  program
    .command('calibrate')
    .description('Replay a recording offline until it is clean, proposing a normalizer for each value the agent generates anew on every run (request ids, temp paths, seeds). Makes no model calls.')
    .argument('[run]', 'run id or unique prefix (default: the latest recording)')
    .option('--write', 'add the proposed normalizers to shadowlap.config.json')
    .option('--max-rounds <n>', 'replays to try before giving up', parseIntArg, 8)
    .option('-y, --yes', 'run the recorded command of an imported run without asking')
    .option('--guard <mode>', 'network guard: warn (default), block or off', parseChoice<GuardMode>(['warn', 'block', 'off']), 'warn')
    .option('--json', 'machine-readable output, printed when calibration ends')
    .action(async (runArg: string | undefined, flags: { write?: boolean; maxRounds: number; yes?: boolean; guard: GuardMode; json?: boolean }) => {
      const say = (text: string) => {
        if (!flags.json) process.stdout.write(text);
      };
      const rounds: Array<{ round: number; divergence: { callNo: number; kind: string; name: string; type: string } | null; proposals: Normalizer[] }> = [];
      const opts = program.opts<GlobalOpts>();
      const cwd = process.cwd();
      const config = loadConfig(cwd);
      const store = openStore(opts);
      try {
        const parent = runArg ? requireRun(store, runArg) : store.allRuns().find((r) => r.mode === 'record');
        if (!parent) throw new Error('no recording to calibrate: record one with shadowlap run -- <command>');
        if (commandIsImported(parent) && !flags.yes && !(await confirmImportedCommand(parent.runId, parent.command.argv))) {
          process.exitCode = 1;
          return;
        }
        say(`${p.yellow('⑂')} Calibrating ${shortId(parent.runId)} (${safe(quoteArgv(parent.command.argv))}): replaying it offline until it is clean\n\n`);
        const offline = Object.fromEntries([...Object.keys(providerIds()), 'http'].map((id) => [id, 'offline']));
        const proposals: Proposal[] = [];
        let outcome: { clean: true; total: number } | { clean: false; why: string; details: string } | null = null;
        for (let round = 1; round <= flags.maxRounds && !outcome; round++) {
          const normalizers = [...config.normalize, ...proposals.map((x) => x.normalizer)];
          const attempt = await testAttempt(store, parent, { cwd, upstreams: offline, extraEnv: {}, writes: 'block', guard: flags.guard, normalizers, prices: config.prices, clock: config.clock, http: config.http, spec: null });
          const s = attempt.ended.summary;
          store.deleteRun(attempt.ended.run.runId);
          const label = `  ${p.dim(`round ${round}`)}  `;
          const d = s.divergence;
          rounds.push({ round, divergence: d ? { callNo: d.callNo, kind: d.kind, name: d.name, type: d.type } : null, proposals: [] });
          if (!d) {
            if (s.total === 0 && store.getCalls(parent.runId).length > 0) outcome = { clean: false, why: 'the replay made no calls through Shadowlap, so the agent reached its model some other way (a local model server needs SHADOWLAP_UPSTREAM_OPENAI or the like, as when it was recorded)', details: attempt.output.trim().split('\n').slice(-15).join('\n') };
            else if (attempt.code !== 0) outcome = { clean: false, why: `the agent exited with code ${attempt.code} without diverging`, details: attempt.output.trim().split('\n').slice(-15).join('\n') };
            else {
              say(`${label}${p.green(`clean: ${s.byOrigin.replayed}/${s.total} calls replayed`)}\n`);
              outcome = { clean: true, total: s.total };
            }
            break;
          }
          say(`${label}diverged at call ${d.callNo} (${d.kind} ${safe(d.name)})\n`);
          const step = proposeNormalizers(d, normalizers);
          rounds.at(-1)!.proposals = step.proposals.map((x) => x.normalizer);
          for (const x of step.proposals) say(`           ${p.green('+')} ${safe(x.normalizer.path ?? '(every string)')}: ${x.why}${x.normalizer.pattern ? p.dim(`  ${safe(x.normalizer.pattern)}`) : ''}\n`);
          if (step.proposals.length === 0) {
            const why =
              d.type === 'request_changed'
                ? 'a change Shadowlap cannot tell apart from a real one'
                : d.type === 'new_call' || d.type === 'beyond_recording'
                  ? 'the agent made a different call than it recorded, so its control flow varies between runs (a random choice, a set iterated in a different order, a clock read outside the Shadowlap SDK)'
                  : `a ${d.type} divergence`;
            outcome = { clean: false, why, details: formatDivergence(d) };
          } else {
            proposals.push(...step.proposals);
          }
        }
        store.gcBlobs();
        if (!outcome) outcome = { clean: false, why: `still diverging after ${flags.maxRounds} rounds`, details: '' };
        const result = outcome;
        const emitJson = () => {
          const data = { runId: parent.runId, clean: result.clean, rounds, normalizers: proposals.map((x) => x.normalizer), written: !!flags.write && proposals.length > 0, stopped: result.clean ? null : { why: result.why, details: result.details } };
          emitJobEvent({ type: 'result', data });
          if (flags.json) process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        };
        say('\n');
        if (outcome.clean && proposals.length === 0) {
          say(`${p.green('✓')} Replays clean as it is: nothing to calibrate.\n`);
          emitJson();
          return;
        }
        if (proposals.length) {
          const quote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
          const commands = proposals.map(({ normalizer: n }) => `shadowlap normalize add${n.kind ? ` --kind ${n.kind}` : ''}${n.name ? ` --name ${quote(n.name)}` : ''} --path ${quote(n.path ?? '$')}${n.pattern ? ` --pattern ${quote(n.pattern)}` : ''} --replace ${quote(n.replace)}`);
          const lead = outcome.clean ? `${p.green('✓')} ${proposals.length} normalizer${proposals.length === 1 ? '' : 's'} make${proposals.length === 1 ? 's' : ''} this recording replay clean.` : `${p.yellow('!')} ${proposals.length} normalizer${proposals.length === 1 ? '' : 's'} found before calibration stopped.`;
          if (flags.write) {
            config.normalize.push(...proposals.map((x) => x.normalizer));
            saveConfig(cwd, config);
            for (const { normalizer: n } of proposals) logActivity(store, { kind: 'normalizer.added', runId: parent.runId, ref: n.path ?? null, data: { ...n, via: 'calibrate' } });
            say(`${lead} Added to ${configPath(cwd)}.\n`);
          } else {
            say(`${lead} Add them with --write, or one by one:\n${commands.map((c) => `    ${safe(c)}`).join('\n')}\n`);
          }
        }
        if (!outcome.clean) {
          say(`\n${p.red('✗')} Stopped: ${outcome.why}.\n${outcome.details ? outcome.details.split('\n').map((l) => `    ${l}`).join('\n') + '\n' : ''}`);
          process.exitCode = 1;
        }
        emitJson();
      } finally {
        store.close();
      }
    });

  program
    .command('mcp')
    .description('Run an MCP server behind Shadowlap: shadowlap mcp -- <server command>. tools/call is recorded and replayed; everything else passes through')
    .argument('<command...>', 'the MCP server command, as the client would start it')
    .option('--effect <tool=effect>', 'pure | read | write for a tool, overriding the server\'s annotations (repeatable)', (v: string, acc: string[]) => [...acc, v], [] as string[])
    .passThroughOptions()
    .action(async (argv: string[], flags: { effect: string[] }) => {
      const config = loadConfig(process.cwd());
      const effects = { ...config.mcp?.effects, ...parseEffectFlags(flags.effect) };
      const log = (line: string) => process.stderr.write(`[shadowlap mcp] ${line}\n`);
      const target = discoverSidecar(process.env, process.cwd(), log);
      if (!target) log('no active run (SHADOWLAP_URL unset and no .shadowlap/active.json): passing everything through');
      const { child, done } = startMcpProxy({ clientIn: process.stdin, clientOut: process.stdout, server: { command: argv[0]!, args: argv.slice(1) }, sidecar: target, effects, log });
      const onSignal = (sig: NodeJS.Signals) => child.kill(sig);
      process.on('SIGINT', onSignal);
      process.on('SIGTERM', onSignal);
      process.exitCode = await done;
    });

}
