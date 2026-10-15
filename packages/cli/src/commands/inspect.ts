import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command, InvalidArgumentError } from 'commander';
import { cleanLabel, compareRuns, formatComparison, formatDivergence, formatDuration, formatUsd, hasRecordedCommand, loadApiRequest, MATCH_END, MATCH_START, runsDiffer, searchCalls, storedModelResolver, summarizeRun, withLabels, withNote, type RunRecord } from '@shadowlap/engine';
import { defaultDbPath, loadConfig } from '../config.js';
import { describeCall, openStore, parseIntArg, requireRun, telemetry, VERSION, type GlobalOpts } from '../shared.js';
import { ago, palette as p, safe, shortId, table } from '../ui.js';

/** Reading runs: the dashboard, the terminal UI, and the commands that list, show, search, compare and annotate them. */

export function register(program: Command): void {
  program.commandsGroup('Look at runs:');

  program
    .command('dashboard')
    .description('Open the dashboard: a local web UI over your recordings (runs, timelines, conversations, diffs, replay and fork actions)')
    .argument('[run]', 'open this run directly')
    .option('--call <n>', 'with a run: open at this call', parseIntArg)
    .option('--port <port>', 'port to listen on (a free one is used when it is taken)', parseIntArg, 4777)
    .option('--no-open', 'print the link instead of opening a browser')
    .option('--read-only', 'show every page but change nothing: no actions, labels, notes, uploads or deletes')
    .action(async (runArg: string | undefined, flags: { call?: number; port: number; open: boolean; readOnly?: boolean }) => {
      const opts = program.opts<GlobalOpts>();
      const cwd = process.cwd();
      const dbPath = resolve(opts.db ?? defaultDbPath(cwd));
      // A read-only dashboard shows a store; it never makes one.
      if (flags.readOnly && !existsSync(dbPath)) throw new Error(`no store at ${dbPath}: --read-only shows an existing store and never creates one (record a run first, or point --db at a store)`);
      const store = openStore(opts);
      if (flags.call !== undefined && !runArg) throw new Error('--call needs a run: shadowlap dashboard <run> --call <n>');
      const runId = runArg ? requireRun(store, runArg).runId : undefined;
      const config = loadConfig(cwd);
      const { cliSpawner, startDashboard, openInBrowser } = await import('@shadowlap/dashboard');
      // Actions run this same CLI against the same store, like the terminal UI's, with a pipe to report what they made.
      const spawnCli = flags.readOnly ? undefined : cliSpawner({ command: [process.execPath, process.argv[1]!], dbPath, cwd });
      const dash = await startDashboard({
        store,
        dbPath,
        port: flags.port,
        ...(spawnCli ? { spawnCli } : {}),
        readOnly: !!flags.readOnly,
        project: { path: cwd },
        loadConfig: () => loadConfig(cwd),
        version: VERSION,
        ...(config.prices ? { prices: config.prices } : {}),
        ...(config.redact.length ? { redact: config.redact } : {}),
        ...(opts.verbose ? { log: (line: string) => void process.stderr.write(p.dim(`[dashboard] ${line}\n`)) } : {}),
      });
      telemetry().record({ type: 'ui' });
      void telemetry().flush();
      const link = runId ? dash.runUrl(runId, flags.call) : dash.openUrl;
      process.stderr.write(`${p.bold('Shadowlap dashboard')}${flags.readOnly ? p.dim(' (read-only)') : ''}  ${link}\n${p.dim(`  ${dbPath} · the link carries a session token; keep it to yourself · Ctrl-C stops`)}\n`);
      if (flags.open && !process.env.CI) {
        if (!(await openInBrowser(link))) process.stderr.write(p.dim('  could not open a browser; open the link above\n'));
      }
      await new Promise<void>((done) => {
        process.once('SIGINT', done);
        process.once('SIGTERM', done);
      });
      await dash.close();
      store.close();
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
      let dashboard: Promise<import('@shadowlap/dashboard').Dashboard> | undefined;
      const openDashboard = async (id: string, callNo?: number) => {
        const { cliSpawner, startDashboard, openInBrowser } = await import('@shadowlap/dashboard');
        // The dashboard's jobs get the events pipe; the terminal UI reads its actions' output as it always did.
        dashboard ??= startDashboard({ store, dbPath, port: 4777, spawnCli: cliSpawner({ command: [process.execPath, process.argv[1]!], dbPath, cwd }), project: { path: cwd }, loadConfig: () => loadConfig(cwd), version: VERSION, ...(uiConfig.prices ? { prices: uiConfig.prices } : {}), ...(uiConfig.redact.length ? { redact: uiConfig.redact } : {}) }).catch((err: unknown) => {
          dashboard = undefined;
          throw err;
        });
        const url = (await dashboard).runUrl(id, callNo);
        return { url, opened: !process.env.CI && (await openInBrowser(url)) };
      };
      try {
        await launchTui(store, { spawnCli, openDashboard, ...(runId ? { runId } : {}), ...(flags.call !== undefined ? { callNo: flags.call } : {}), ...(uiConfig.prices ? { prices: uiConfig.prices } : {}) });
      } finally {
        if (dashboard) await dashboard.then((d) => d.close()).catch(() => undefined);
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
      const store = openStore(program.opts<GlobalOpts>());
      const run = requireRun(store, runArg);
      const calls = store.getCalls(run.runId);
      if (flags.request !== undefined || flags.response !== undefined) {
        const c = calls.find((x) => x.callNo === (flags.request ?? flags.response));
        if (!c) throw new Error(`no call #${flags.request ?? flags.response} in run ${run.runId}`);
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
        const summary = summarizeRun(run, calls, [], [], { ...(config.prices ? { prices: config.prices } : {}), modelOf: storedModelResolver(store) });
        process.stdout.write(JSON.stringify({ run, summary, calls }, null, 2) + '\n');
        store.close();
        return;
      }
      const config = loadConfig(process.cwd());
      const s = summarizeRun(run, calls, [], [], { ...(config.prices ? { prices: config.prices } : {}), modelOf: storedModelResolver(store) });
      const facts = [
        s.durationMs !== null ? formatDuration(s.durationMs) : '',
        s.upstreamRequests ? `${s.upstreamRequests} upstream requests` : '',
        s.injected ? `${s.injected} injected` : '',
        s.cost.spent ? `≈${formatUsd(s.cost.spent)} spent` : '',
        // An imported run's calls were paid for wherever the traffic happened, not here.
        s.cost.captured ? `≈${formatUsd(s.cost.captured)} of traffic captured` : '',
        s.cost.saved ? `${formatUsd(s.cost.saved)} saved by replay` : '',
        s.cost.unknownModels.length ? `no price for ${s.cost.unknownModels.join(', ')}` : '',
      ].filter(Boolean);
      const head = [
        `${p.bold(run.runId)}  ${run.mode === 'record' ? 'recording' : `replay of ${run.parentRunId ?? '?'}`}  ${run.status}  ${p.dim(ago(run.startedAt))}`,
        p.dim(`  ${safe(run.command.argv.join(' '))}${run.codeVersion ? `  @ ${safe(run.codeVersion)}` : ''}`),
        ...(facts.length ? [p.dim(`  ${facts.join(' · ')}`)] : []),
      ];
      // A partial recording explains itself: otherwise "11 of 30 replayed" looks like a fault.
      if (run.meta?.covers?.length) {
        const missing = (['api', 'tool', 'clock', 'random'] as const).filter((k) => !run.meta!.covers!.includes(k));
        head.push(p.dim(`  partial recording: ${run.meta.covers.join(', ')} only — ${missing.join(', ')} calls run live on replay`));
      }
      if (run.meta?.labels?.length) head.push(`  ${p.cyan(safe(run.meta.labels.join(', ')))}`);
      for (const n of run.meta?.notes ?? []) head.push(`  ${p.yellow('✎')} ${n.callNo !== null ? p.dim(`#${n.callNo} `) : ''}${safe(n.text)}`);
      // What `shadowlap blame` found. A run can come from a pack, so nothing here is trusted to be well formed.
      const blame = run.meta?.blame;
      if (blame) {
        const found =
          blame.outcome === 'blamed' && Number.isInteger(blame.callNo)
            ? `lost at model call #${blame.callNo} (${safe(String(blame.confidence))} confidence)${typeof blame.rescuedRunId === 'string' ? `, rescued by ${safe(shortId(blame.rescuedRunId))}` : ''}`
            : blame.outcome === 'unrescuable'
              ? 'not rescued from any model call'
              : 'stopped before it finished';
        head.push(`  ${p.yellow('⑂')} blame: ${found}${Number.isFinite(blame.at) ? p.dim(` · ${ago(blame.at)}`) : ''}`);
      }
      const probe = run.meta?.probe;
      if (probe && Number.isInteger(probe.callNo) && typeof probe.of === 'string') head.push(p.dim(`  an attempt of shadowlap blame ${safe(shortId(probe.of))}, forked at model call #${probe.callNo}: ${probe.passed ? 'passed' : 'failed'}`));
      const verify = run.meta?.verify;
      if (verify) head.push(p.dim(`  an attempt of shadowlap verify, replaying a ${verify.role === 'good' ? 'good run' : verify.role === 'holdout' ? 'held-out failing run' : 'failing run'}: ${verify.passed ? 'passed' : 'failed'}`));
      process.stdout.write(head.join('\n') + '\n\n');
      process.stdout.write(table(calls.map((c) => describeCall(store, c)), '  ') + '\n');
      if (run.divergence) process.stdout.write('\n' + formatDivergence(run.divergence, p) + '\n');
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
      const store = openStore(program.opts<GlobalOpts>());
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
          checks: r.meta?.checks ? { passed: r.meta.checks.filter((c) => c.ok).length, total: r.meta.checks.length } : null,
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
        process.stdout.write(p.dim('no runs yet: shadowlap run -- <command>\n'));
        return;
      }
      const row = (r: RunRecord, indent: string): string[] => {
        const state = r.status === 'running' ? p.yellow(r.status) : r.status === 'completed' ? p.green(r.status) : p.red(r.status);
        const calls = store.countCalls(r.runId);
        const kind = r.mode !== 'replay' ? 'recording' : r.divergence ? p.yellow(`fork @${r.divergence.callNo}`) : r.status === 'completed' && calls > 0 ? p.cyan('clean replay') : 'replay';
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
      const store = openStore(program.opts<GlobalOpts>());
      try {
        const runId = flags.run ? requireRun(store, flags.run).runId : undefined;
        const hits = searchCalls(store, query.join(' '), { limit: flags.limit, ...(runId ? { runId } : {}) });
        if (flags.json) {
          process.stdout.write(JSON.stringify(hits.map((h) => ({ ...h, snippet: h.snippet.split(MATCH_START).join('').split(MATCH_END).join('') })), null, 2) + '\n');
          return;
        }
        if (!hits.length) {
          process.stdout.write(p.dim('no matches\n'));
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
      const store = openStore(program.opts<GlobalOpts>());
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
      const store = openStore(program.opts<GlobalOpts>());
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
      const store = openStore(program.opts<GlobalOpts>());
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
