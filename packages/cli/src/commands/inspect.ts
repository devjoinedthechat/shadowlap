import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Command, InvalidArgumentError } from 'commander';
import { kindFacts, lostWhere, readConfigFile, type Normalizer } from '@shadowlap/engine';
import { checksOf, cleanLabel, compareRuns, isChaosPreset, PRESET_LABELS, formatComparison, formatDivergence, formatDuration, formatTokens, formatUsd, hasRecordedCommand, kindLabel, loadApiRequest, MATCH_END, MATCH_START, pulledRun, runKind, runsDiffer, searchCalls, showJson, storedModelResolver, summarizeRun, unrecordedTools, unrescuedWords, untrustedReads, wholeInput, withLabels, withNote, type RunRecord, type TrustSource } from '@shadowlap/engine';
import { ProjectHost, ProjectRegistry } from '@shadowlap/engine';
import { defaultDbPath, loadConfig, type ShadowlapConfig } from '../config.js';
import { embeddedDashboard, onStopSignals } from '../dashboard-stop.js';
import { projectGoldens } from '../goldens.js';
import { describeCall, leftRunning, missingStoreNote, openStore, parseIntArg, readStore, requireRun, statusWord, telemetry, VERSION, type GlobalOpts } from '../shared.js';
import { dashboardTasks } from '../tasks.js';
import { ago, palette as p, safe, shortId, table } from '../ui.js';

/** Reading runs: the dashboard, the terminal UI, and the commands that list, show, search, compare and annotate them. */

/** Where a read's untrusted mark came from, as `show` names it. */
const TRUST_FROM: Record<TrustSource, string> = { config: 'config', sdk: 'SDK', mcp: 'MCP openWorldHint' };

/** A TCP port: 0 (any free one, which the link printed names) to 65535. */
function parsePort(value: string): number {
  const n = Number(value);
  if (!/^\d+$/.test(value.trim()) || !Number.isSafeInteger(n) || n > 65535) throw new InvalidArgumentError('must be a port from 0 (any free one) to 65535');
  return n;
}

/** How many untrusted reads `show` names above the timeline: a crawler reads hundreds, and each row is tagged anyway. */
const UNTRUSTED_NAMED = 5;

export function register(program: Command): void {
  program.commandsGroup('Look at runs:');

  program
    .command('dashboard')
    .description('Open the dashboard: a local web UI over your recordings (runs, timelines, conversations, diffs, replay and fork actions)')
    .argument('[run]', 'open this run directly')
    .option('--call <n>', 'with a run: open at this call', parseIntArg)
    .option('--port <port>', 'port to listen on: 0 for any free one; a taken one falls back to a free one, and the link printed has the port it got', parsePort, 4777)
    .option('--no-open', 'print the link instead of opening a browser')
    .option('--read-only', 'show every page but change nothing: no actions, labels, notes, uploads or deletes')
    .action(async (runArg: string | undefined, flags: { call?: number; port: number; open: boolean; readOnly?: boolean }) => {
      const opts = program.opts<GlobalOpts>();
      const cwd = process.cwd();
      const dbPath = resolve(opts.db ?? defaultDbPath(cwd));
      // A read-only dashboard shows a store; it never makes one.
      if (flags.readOnly && !existsSync(dbPath)) throw new Error(`no store at ${dbPath}: --read-only shows an existing store and never creates one (record a run first, or point --db at a store)`);
      if (flags.call !== undefined && !runArg) throw new Error('--call needs a run: shadowlap dashboard <run> --call <n>');
      const config = loadConfig(cwd);
      // One dashboard for the projects on this machine (~/.shadowlap/projects.json): it opens on this
      // folder, added to the list if it isn't on it, and switching swaps the store, the config and the
      // folder its jobs run in. A read-only dashboard shows this store alone.
      const projects = flags.readOnly ? null : ProjectHost.open<ShadowlapConfig>(cwd, { registry: new ProjectRegistry(), loadConfig: (dir: string) => loadConfig(dir), dbPath });
      const store = projects ? projects.current().store() : openStore(opts);
      const runId = runArg ? requireRun(store, runArg).runId : undefined;
      const { cliSpawner, startDashboard, openInBrowser } = await import('@shadowlap/dashboard');
      // Actions run this same CLI against the project's store, like the terminal UI's, with a pipe to report what they made.
      const spawnCli = flags.readOnly ? undefined : cliSpawner({ command: [process.execPath, process.argv[1]!], dbPath, cwd });
      const dash = await startDashboard({
        ...(projects ? { projects } : { store }),
        dbPath,
        port: flags.port,
        ...(spawnCli ? { spawnCli } : {}),
        readOnly: !!flags.readOnly,
        project: { path: cwd },
        loadConfig: () => loadConfig(cwd),
        // What belongs to each project's folder, read for the project a page shows: its goldens.
        projectOptions: (project) => ({ goldens: () => projectGoldens(project.path) }),
        // Training reads the goldens as tasks the way `shadowlap tasks` does.
        training: { loadTasks: (s, root) => dashboardTasks(root ?? cwd, s) },
        version: VERSION,
        ...(config.prices ? { prices: config.prices } : {}),
        ...(opts.verbose ? { log: (line: string) => void process.stderr.write(p.dim(`[dashboard] ${line}\n`)) } : {}),
      });
      telemetry().record({ type: 'ui' });
      void telemetry().flush();
      const link = runId ? dash.runUrl(runId, flags.call) : dash.openUrl;
      process.stderr.write(`${p.bold('Shadowlap dashboard')}${flags.readOnly ? p.dim(' (read-only)') : ''}  ${link}\n${p.dim(`  ${dbPath} · the link carries a session token; keep it to yourself · Ctrl-C stops`)}\n`);
      if (flags.open && !process.env.CI) {
        if (!(await openInBrowser(link))) process.stderr.write(p.dim('  could not open a browser; open the link above\n'));
      }
      // Jobs lead process groups of their own, so neither Ctrl-C nor a closing terminal reaches them:
      // stopping the dashboard stops them, with their agents, and waits. Stopping it again kills them.
      let release: () => void = () => undefined;
      await new Promise<void>((done) => {
        release = onStopSignals(
          () => done(),
          () => void dash.close({ now: true }),
        );
      });
      await dash.close();
      release();
      // The host opened the stores it served, the start folder's among them.
      if (projects) projects.close();
      else store.close();
    });

  program
    .command('ui')
    .description('Open the terminal UI: runs, timeline, inspector, play mode, diffs')
    .argument('[run]', 'open this run directly')
    .option('--call <n>', 'with a run: select this call', parseIntArg)
    .action(async (runArg: string | undefined, flags: { call?: number }) => {
      const opts = program.opts<GlobalOpts>();
      const store = openStore(opts);
      if (flags.call !== undefined && !runArg) throw new Error('--call needs a run: shadowlap ui <run> --call <n>');
      const { launchTui } = await import('@shadowlap/tui');
      const runId = runArg ? requireRun(store, runArg).runId : undefined;
      telemetry().record({ type: 'ui' });
      void telemetry().flush();
      // The actions palette runs this same CLI against the same store.
      const dbPath = resolve(opts.db ?? defaultDbPath(process.cwd()));
      const spawnCli = (args: string[]) => spawn(process.execPath, [process.argv[1]!, '--db', dbPath, ...args], { cwd: process.cwd(), env: { ...process.env, NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
      const cwd = process.cwd();
      const uiConfig = loadConfig(cwd);
      // `o` starts the dashboard in this process on first use, over the same store, and reuses it after.
      // Its jobs lead process groups of their own: from then on a closed terminal or a kill stops them
      // too, before this process ends.
      const dashboard = embeddedDashboard(async () => {
        const { cliSpawner, startDashboard } = await import('@shadowlap/dashboard');
        // The dashboard's jobs get the events pipe; the terminal UI reads its actions' output as it always did.
        return startDashboard({ store, dbPath, port: 4777, spawnCli: cliSpawner({ command: [process.execPath, process.argv[1]!], dbPath, cwd }), project: { path: cwd }, loadConfig: () => loadConfig(cwd), goldens: () => projectGoldens(cwd), training: { loadTasks: (s, root) => dashboardTasks(root ?? cwd, s) }, version: VERSION, ...(uiConfig.prices ? { prices: uiConfig.prices } : {}) });
      });
      const openDashboard = async (id: string, callNo?: number) => {
        const { openInBrowser } = await import('@shadowlap/dashboard');
        const url = (await dashboard.open()).runUrl(id, callNo);
        return { url, opened: !process.env.CI && (await openInBrowser(url)) };
      };
      try {
        // The project's normalizers, so a fork's differences leave out what they mask, and its declared unrecorded tools.
        let normalizers: Normalizer[] = [];
        try {
          normalizers = uiConfig.normalize;
        } catch {
          // A broken normalizer stops the commands that apply it, not a look at the runs.
        }
        // The config's tests, for the check blame judges a golden's runs by, as the dashboard reads them.
        const configFile = readConfigFile(cwd);
        await launchTui(store, { spawnCli, openDashboard, normalizers, tests: configFile.data.tests, configDir: dirname(configFile.path), ...(runId ? { runId } : {}), ...(flags.call !== undefined ? { callNo: flags.call } : {}), ...(uiConfig.prices ? { prices: uiConfig.prices } : {}), ...(uiConfig.unrecorded ? { unrecorded: uiConfig.unrecorded } : {}) });
      } finally {
        await dashboard.close();
        store.close();
      }
    });

  program
    .command('show')
    .description('Show a run: its timeline, and its divergence if it forked')
    .argument('<run>', 'run id or unique prefix')
    .option('--json', 'machine-readable output')
    .option('--request <call>', 'print the stored request of call <call>', parseIntArg)
    .option('--response <call>', 'print the stored response of call <call>', parseIntArg)
    .action((runArg: string, flags: { json?: boolean; request?: number; response?: number }) => {
      const store = readStore(program.opts<GlobalOpts>());
      const run = requireRun(store, runArg);
      const calls = store.getCalls(run.runId);
      if (flags.request !== undefined || flags.response !== undefined) {
        const c = calls.find((x) => x.callNo === (flags.request ?? flags.response));
        if (!c) throw new Error(`no call #${flags.request ?? flags.response!} in run ${run.runId}`);
        if (flags.request !== undefined) {
          const req = c.requestRef ? (c.kind === 'api' ? loadApiRequest(store, c.requestRef) : store.getJson(c.requestRef)) : null;
          process.stdout.write(JSON.stringify(req, null, 2) + '\n');
        } else {
          const bytes = c.end?.responseRef ? store.getBlob(c.end.responseRef) : null;
          process.stdout.write((bytes ? bytes.toString('utf8') : '') + '\n');
        }
        store.close();
        return;
      }
      if (flags.json) {
        const config = loadConfig(process.cwd());
        // The same function the dashboard serves it from: one shape for scripts and coding agents.
        process.stdout.write(JSON.stringify(showJson(store, run, { calls, ...(config.prices ? { prices: config.prices } : {}), ...(config.tools ? { tools: config.tools } : {}), ...(config.unrecorded ? { unrecorded: config.unrecorded } : {}) }), null, 2) + '\n');
        store.close();
        return;
      }
      const config = loadConfig(process.cwd());
      const s = summarizeRun(run, calls, [], [], { ...(config.prices ? { prices: config.prices } : {}), modelOf: storedModelResolver(store) });
      // A run pulled from the team store spent what it spent where it was recorded, by its author.
      const author = pulledRun(run) && typeof run.meta?.author === 'string' && run.meta.author ? run.meta.author : null;
      const by = author ? ` by ${safe(author.includes('@') ? author.split('@')[0]! : author)}` : '';
      const notRespent = wholeInput(s.tokensNotRespent);
      const facts = [
        s.durationMs !== null ? formatDuration(s.durationMs) : '',
        s.upstreamRequests ? `${s.upstreamRequests} upstream ${s.upstreamRequests === 1 ? 'request' : 'requests'}` : '',
        s.injected ? `${s.injected} injected` : '',
        s.cost.spent ? `≈${formatUsd(s.cost.spent)} spent${by}` : '',
        // An imported run's calls were paid for wherever the traffic happened, not here.
        s.cost.captured ? `≈${formatUsd(s.cost.captured)} of traffic captured` : '',
        // What replaying it didn't spend again, as the dashboard's receipt says it, with its input tokens
        // (a model with no price still says its tokens, as a replay's summary does).
        s.cost.saved ? `${formatUsd(s.cost.saved)} not re-spent${notRespent ? ` (${formatTokens(notRespent)} input tokens)` : ''}` : notRespent ? `${formatTokens(notRespent)} input tokens not re-spent` : '',
        s.cost.unknownModels.length ? `no price for ${s.cost.unknownModels.join(', ')}` : '',
      ].filter(Boolean);
      // Stopped before it ended, or left by a recorder that went away: interrupted, as every page says it.
      const status = statusWord(run.status, leftRunning(store, [run]).has(run.runId));
      const head = [
        `${p.bold(run.runId)}  ${run.mode === 'record' ? 'recording' : `replay of ${run.parentRunId ?? '?'}`}  ${status}  ${p.dim(ago(run.startedAt))}`,
        p.dim(`  ${safe(run.command.argv.join(' '))}${run.codeVersion ? `  @ ${safe(run.codeVersion)}` : ''}`),
        ...(facts.length ? [p.dim(`  ${facts.join(' · ')}`)] : []),
      ];
      // A partial recording explains itself: otherwise "11 of 30 replayed" looks like a fault.
      if (run.meta?.covers?.length) {
        // A trace covers some tools by name (`tool:<name>`): the other tools are what runs live.
        const someTools = run.meta.covers.some((k) => k.startsWith('tool:'));
        const missing = (['api', 'tool', 'clock', 'random'] as const).filter((k) => !run.meta!.covers!.includes(k)).map((k) => (k === 'tool' && someTools ? 'other tool' : k));
        head.push(p.dim(`  partial recording: ${safe(run.meta.covers.join(', '))} only\u2009—\u2009${missing.join(', ')} calls run live on replay`));
      }
      if (run.meta?.labels?.length) head.push(`  ${p.cyan(safe(run.meta.labels.join(', ')))}`);
      for (const n of run.meta?.notes ?? []) head.push(`  ${p.yellow('✎')} ${n.callNo !== null ? p.dim(`#${n.callNo} `) : ''}${safe(n.text)}`);
      // What `shadowlap blame` found. A run can come from a pack, so nothing here is trusted to be well formed.
      const blame = run.meta?.blame;
      if (blame) {
        const found =
          blame.outcome === 'blamed' && Number.isInteger(blame.callNo)
            ? `lost ${lostWhere(blame.callNo!, blame.range)} (${safe(String(blame.confidence))} confidence)${typeof blame.rescuedRunId === 'string' ? `, rescued by ${safe(shortId(blame.rescuedRunId))}` : ''}`
            : blame.outcome === 'unrescuable'
              ? unrescuedWords(blame.unsettled === true)
              : 'stopped before it finished';
        head.push(`  ${p.yellow('⑂')} blame: ${found}${Number.isFinite(blame.at) ? p.dim(` · ${ago(blame.at)}`) : ''}`);
      }
      const probe = run.meta?.probe;
      if (probe && Number.isInteger(probe.callNo) && typeof probe.of === 'string') head.push(p.dim(`  an attempt of shadowlap blame ${safe(shortId(probe.of))}, forked at model call #${probe.callNo}: ${probe.passed ? 'passed' : probe.verdict === 'inconclusive' ? 'inconclusive, a check could not be decided' : probe.verdict === 'unavailable' ? 'not counted, the provider was unavailable' : 'failed'}`));
      const verify = run.meta?.verify;
      if (verify) head.push(p.dim(`  an attempt of shadowlap verify, replaying a ${verify.role === 'good' ? 'good run' : verify.role === 'holdout' ? 'held-out failing run' : 'failing run'}: ${verify.passed ? 'passed' : verify.verdict === 'inconclusive' ? 'inconclusive, a check could not be decided' : verify.verdict === 'unavailable' ? 'not counted, the provider was unavailable' : 'failed'}`));
      // An error-path preset's attempt: what was played in where; the preset's verdict is the session's (test --chaos).
      const chaos = run.meta?.chaos;
      if (chaos && isChaosPreset(chaos.preset) && Number.isInteger(chaos.callNo)) {
        const hit = calls.find((c) => c.callNo === chaos.callNo);
        const at = hit ? (hit.kind === 'api' ? `model call #${chaos.callNo}` : `${safe(hit.name)} (#${chaos.callNo})`) : `#${chaos.callNo}`;
        head.push(p.dim(`  an attempt of the error-path presets: ${PRESET_LABELS[chaos.preset]} at ${at}${typeof chaos.golden === 'string' ? ` of ${safe(chaos.golden)}` : ''}${Number.isInteger(chaos.attempt) && chaos.attempt > 1 ? `, attempt ${chaos.attempt}` : ''}`));
      }
      // Its untrusted reads, as the dashboard's Calls view tags them: where shadowlap injection plants,
      // each marked by the config's tools, the SDK's trust or its MCP server's openWorldHint. The
      // first few are named here; each row says it, and --json lists them all.
      const untrusted = new Map(untrustedReads(calls, config.tools).reads.map((r) => [r.callNo, r]));
      if (untrusted.size) {
        const named = [...untrusted.values()].map((r) => `#${r.callNo} ${safe(r.name)} (${TRUST_FROM[r.from]})`);
        const list = named.length > UNTRUSTED_NAMED ? `${named.slice(0, UNTRUSTED_NAMED).join(', ')} and ${named.length - UNTRUSTED_NAMED} more` : named.join(', ');
        head.push(p.dim(`  untrusted reads: ${list} · shadowlap injection plants in them`));
      }
      // The tools its model called that it left unrecorded: they ran in the agent unseen, and a replay runs them for real.
      const unrecorded = unrecordedTools(store, run.runId, { declared: config.unrecorded ?? {} });
      if (unrecorded.length) {
        const writes = unrecorded.filter((t) => t.effect === 'write').length;
        const unknown = unrecorded.filter((t) => t.effect === 'unknown').length;
        head.push(`  ${p.yellow('!')} not recorded: ${unrecorded.map((t) => `${safe(t.name)} (${t.count} call${t.count === 1 ? '' : 's'} from #${t.firstCallNo}${t.effect === 'write' ? ', writes' : t.effect === 'unknown' ? ', may write' : ''})`).join(', ')}${p.dim(` · a replay runs ${unrecorded.length === 1 ? 'it' : 'them'} for real${writes || unknown ? `, and refuses to while one ${writes && unknown ? 'writes, or may' : writes ? 'writes' : 'may write'}` : ''}`)}`);
      }
      process.stdout.write(head.join('\n') + '\n\n');
      // A column of its own, only when there is a read to tag, so the rest line up as they always have.
      const rows = calls.map((c) => {
        const row = describeCall(store, c);
        if (untrusted.size) row.splice(3, 0, untrusted.has(c.callNo) ? 'untrusted' : '');
        return row;
      });
      process.stdout.write(table(rows, '  ') + '\n');
      // The calls an override answered before the fork are named apart from those replayed, as the run's page says it.
      if (run.divergence) process.stdout.write('\n' + formatDivergence(run.divergence, p, 12, calls) + '\n');
      store.close();
    });

  program
    .command('ls')
    .description('List runs')
    .option('--tree', 'show fork lineage')
    .option('-n, --limit <n>', 'maximum runs', parseIntArg, 50)
    .option('--label <label>', 'only runs with this label (repeatable: all of them)', (v: string, acc: string[]) => [...acc, v], [] as string[])
    .option('--json', 'machine-readable output')
    .action((flags: { tree?: boolean; limit: number; label: string[]; json?: boolean }) => {
      const store = readStore(program.opts<GlobalOpts>());
      const runs = flags.label.length ? store.allRuns().filter((r) => flags.label.every((l) => r.meta?.labels?.includes(l))).slice(0, flags.limit) : store.listRuns(flags.limit);
      if (flags.json) {
        const out = runs.map((r) => ({
          runId: r.runId,
          parentRunId: r.parentRunId,
          mode: r.mode,
          status: r.status,
          forkedAt: r.divergence ? { callNo: r.divergence.callNo, type: r.divergence.type, kind: r.divergence.kind, name: r.divergence.name, reason: r.divergence.reason ?? null } : null,
          calls: store.countCalls(r.runId),
          command: r.command.argv,
          // Named fields rather than the raw metadata, which holds internals: this is a contract
          // coding agents read, so a partial or imported run must be recognisable without `show`.
          hasCommand: hasRecordedCommand(r),
          imported: r.meta?.imported ?? null,
          partial: r.meta?.covers?.length ? r.meta.covers : null,
          repeat: r.meta?.repeat ?? null,
          checks: checksOf(r),
          codeVersion: r.codeVersion,
          startedAt: r.startedAt,
          endedAt: r.endedAt,
          labels: r.meta?.labels ?? [],
        }));
        store.close();
        process.stdout.write(JSON.stringify(out, null, 2) + '\n');
        return;
      }
      if (runs.length === 0) {
        // Runs to show, but none with the labels asked for: say that, not that nothing was recorded.
        const labelled = flags.label.length > 0 && store.listRuns(1).length > 0;
        // No store here at all, but the project's is in a folder above: say where, not that nothing was recorded.
        const note = missingStoreNote(store);
        store.close();
        process.stdout.write(p.dim(labelled ? `no runs labelled ${flags.label.map((l) => safe(l)).join(' and ')}\n` : note ? `no runs: ${note}\n` : 'no runs yet: shadowlap run -- <command>\n'));
        return;
      }
      // A run stopped before it ended reads interrupted, in a neutral tone, as the dashboard lists it.
      const left = leftRunning(store, runs);
      const row = (r: RunRecord, indent: string): string[] => {
        const word = statusWord(r.status, left.has(r.runId));
        const state = word === 'interrupted' ? p.dim(word) : r.status === 'running' ? p.yellow(word) : r.status === 'completed' ? p.green(word) : p.red(word);
        const calls = store.countCalls(r.runId);
        const k = runKind(r, kindFacts(store, r, calls));
        // A replay that stopped before its recording did is no clean one: `ended early @11`, in red.
        const kind = k === 'fork' ? (r.divergence?.type === 'ended_early' ? p.red : p.yellow)(kindLabel(k, r.divergence)) : k === 'clean' ? p.cyan(kindLabel(k, r.divergence)) : kindLabel(k, r.divergence);
        return [indent + shortId(r.runId), kind, state, `${calls} calls`, safe(r.codeVersion ?? ''), p.dim(ago(r.startedAt)), r.meta?.labels?.length ? p.cyan(safe(r.meta.labels.join(', '))) : ''];
      };
      let rows: string[][];
      if (flags.tree) {
        const ids = new Set(runs.map((r) => r.runId));
        const roots = runs.filter((r) => !r.parentRunId || !ids.has(r.parentRunId)).sort((a, b) => a.startedAt - b.startedAt);
        rows = [];
        const walk = (r: RunRecord, depth: number) => {
          rows.push(row(r, depth === 0 ? '' : '  '.repeat(depth - 1) + '└ '));
          for (const c of store.childRuns(r.runId)) if (ids.has(c.runId)) walk(c, depth + 1);
        };
        roots.forEach((r) => walk(r, 0));
      } else {
        rows = runs.map((r) => row(r, ''));
      }
      process.stdout.write(table(rows) + '\n');
      store.close();
    });

  program
    .command('search')
    .description('Search recorded prompts, responses, tool arguments and results across runs; "quoted words" match together')
    .argument('<query...>', 'words that must all appear')
    .option('--run <run>', 'only this run')
    .option('-n, --limit <n>', 'maximum matches', parseIntArg, 20)
    .option('--json', 'machine-readable output')
    .action((query: string[], flags: { run?: string; limit: number; json?: boolean }) => {
      const store = readStore(program.opts<GlobalOpts>());
      try {
        const runId = flags.run ? requireRun(store, flags.run).runId : undefined;
        const hits = searchCalls(store, query.join(' '), { limit: flags.limit, ...(runId ? { runId } : {}) });
        // Nothing found is exit status 1, as for grep, whatever the output.
        if (!hits.length) process.exitCode = 1;
        if (flags.json) {
          process.stdout.write(JSON.stringify(hits.map((h) => ({ ...h, snippet: h.snippet.split(MATCH_START).join('').split(MATCH_END).join('') })), null, 2) + '\n');
          return;
        }
        if (!hits.length) {
          const note = missingStoreNote(store);
          process.stdout.write(p.dim(note ? `no matches: ${note}\n` : 'no matches\n'));
          process.exitCode = 1;
          return;
        }
        for (const h of hits) {
          // Recorded text is escaped piece by piece, so the match markers survive to be colored.
          const marked = h.snippet
            .replace(/\s+/g, ' ')
            .split(MATCH_START)
            .map((part, i) => {
              const end = part.indexOf(MATCH_END);
              return i === 0 || end < 0 ? safe(part) : p.yellow(safe(part.slice(0, end))) + safe(part.slice(end + 1));
            })
            .join('');
          process.stdout.write(`${p.bold(shortId(h.runId))} #${h.callNo} ${h.kind} ${safe(h.name)} ${p.dim(`· ${h.field} · ${ago(h.runStartedAt)} · shadowlap ui ${h.runId} --call ${h.callNo}`)}\n    ${marked}\n`);
        }
      } finally {
        store.close();
      }
    });

  program
    .command('diff')
    .description('Compare two runs call by call: the first request that differs, and identical requests that got different responses')
    .argument('<a>', 'run id or unique prefix')
    .argument('<b>', 'run id or unique prefix')
    .option('--json', 'machine-readable output')
    .action((aArg: string, bArg: string, flags: { json?: boolean }) => {
      const store = readStore(program.opts<GlobalOpts>());
      const a = requireRun(store, aArg);
      const b = requireRun(store, bArg);
      const c = compareRuns(store, a, store.getCalls(a.runId), b, store.getCalls(b.runId));
      store.close();
      process.stdout.write((flags.json ? JSON.stringify(c, null, 2) : formatComparison(c, p)) + '\n');
      process.exitCode = runsDiffer(c) ? 1 : 0;
    });

  program
    .command('label')
    .description('Label a run (bug, good, refund-flow…) to find it, list it with ls --label and export it by label; with no labels, print them')
    .argument('<run>', 'run id or unique prefix')
    .argument('[labels...]', 'labels to add')
    .option('--remove', 'remove these labels instead')
    .option('--json', 'machine-readable output')
    .action((runArg: string, labels: string[], flags: { remove?: boolean; json?: boolean }) => {
      const store = readStore(program.opts<GlobalOpts>());
      try {
        const run = requireRun(store, runArg);
        const cleaned = labels.map((l) => {
          const c = cleanLabel(l);
          if ('error' in c) throw new InvalidArgumentError(c.error);
          return c.label;
        });
        const next = flags.remove ? withLabels(run.meta?.labels, [], cleaned) : withLabels(run.meta?.labels, cleaned);
        if (labels.length) store.updateRunMeta(run.runId, { labels: next });
        if (flags.json) return void process.stdout.write(JSON.stringify({ runId: run.runId, labels: next }) + '\n');
        process.stdout.write(next.length ? `${shortId(run.runId)}: ${safe(next.join(', '))}\n` : p.dim(`${shortId(run.runId)} has no labels\n`));
      } finally {
        store.close();
      }
    });

  program
    .command('note')
    .description('Add a note to a run, or to one of its calls; shown by show and the dashboard')
    .argument('<run>', 'run id or unique prefix')
    .argument('<text...>', 'the note')
    .option('--call <n>', 'the call the note is about', parseIntArg)
    .action((runArg: string, text: string[], flags: { call?: number }) => {
      const store = readStore(program.opts<GlobalOpts>());
      try {
        const run = requireRun(store, runArg);
        if (flags.call !== undefined && !store.getCalls(run.runId).some((c) => c.callNo === flags.call)) throw new Error(`no call #${flags.call} in run ${run.runId}`);
        store.updateRunMeta(run.runId, { notes: withNote(run.meta?.notes, { callNo: flags.call ?? null, text: text.join(' '), at: Date.now() }) });
        process.stdout.write(`${p.green('✓')} noted on ${shortId(run.runId)}${flags.call !== undefined ? ` #${flags.call}` : ''}\n`);
      } finally {
        store.close();
      }
    });

}
