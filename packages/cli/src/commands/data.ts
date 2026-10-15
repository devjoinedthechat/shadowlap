import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command, InvalidArgumentError } from 'commander';
import { DATASET_FORMATS, datasetRows, type DatasetFormat, type RunRecord } from '@shadowlap/engine';
import { defaultDbPath, loadConfig } from '../config.js';
import { runToHar } from '../export-har.js';
import { otlpHeaders, runToOtlp, sendOtlp } from '../otel.js';
import { fileSize, formatBytes, openStore, parseChoice, parseIntArg, requireRun, VERSION, type GlobalOpts } from '../shared.js';
import { ago, palette as p, shortId } from '../ui.js';

/** Runs as data for other tools, and removing what is no longer needed. */

export function register(program: Command): void {
  program.commandsGroup('Export and clean up:');

  const exportCmd = program.command('export').description('Export a run in another format');
  exportCmd
    .command('dataset')
    .description('Recordings as an eval or fine-tuning dataset (JSON Lines): each run\'s final model call, or every one, with its conversation, the model\'s answer, labels, notes and check results')
    .argument('[runs...]', 'run ids or unique prefixes')
    .option('--label <label>', 'runs with this label (repeatable: all of them)', (v: string, acc: string[]) => [...acc, v], [] as string[])
    .option('--all', 'every run in the store')
    .option('--calls <which>', 'final: each run\'s last model call; model: every model call', parseChoice(['final', 'model'] as const), 'final')
    .option('--format <format>', 'jsonl | openai-chat | braintrust | langfuse', parseChoice(DATASET_FORMATS), 'jsonl')
    .option('--out <file>', 'write here instead of stdout')
    .option('--no-redact', 'skip the redaction rules in shadowlap.config.json')
    .action((runArgs: string[], flags: { label: string[]; all?: boolean; calls: 'final' | 'model'; format: DatasetFormat; out?: string; redact: boolean }) => {
      if (!runArgs.length && !flags.label.length && !flags.all) throw new InvalidArgumentError('name runs, or select them with --label or --all');
      const store = openStore(program.opts<GlobalOpts>());
      try {
        const picked = new Map<string, RunRecord>();
        for (const arg of runArgs) {
          const r = requireRun(store, arg);
          picked.set(r.runId, r);
        }
        if (flags.label.length || flags.all) for (const r of store.allRuns()) if (flags.label.every((l) => r.meta?.labels?.includes(l))) picked.set(r.runId, r);
        const runs = [...picked.values()].sort((a, b) => a.startedAt - b.startedAt);
        const rows = datasetRows(store, runs, { calls: flags.calls, format: flags.format, redact: flags.redact ? loadConfig(process.cwd()).redact : [] });
        const body = rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
        if (flags.out) {
          writeFileSync(flags.out, body);
          process.stderr.write(`${p.green('✓')} ${rows.length} example${rows.length === 1 ? '' : 's'} from ${runs.length} run${runs.length === 1 ? '' : 's'} → ${flags.out}\n`);
        } else process.stdout.write(body);
      } finally {
        store.close();
      }
    });

  exportCmd
    .command('har')
    .description("A run's model API calls as a HAR, for any tool that reads one; the reverse of shadowlap import har. Redaction rules apply. Tool, clock and randomness calls are left out: a HAR describes HTTP")
    .argument('<run>', 'run id or unique prefix')
    .argument('[file]', 'output file (default: stdout)')
    .option('--no-redact', 'skip the redaction rules in shadowlap.config.json')
    .action((runArg: string, file: string | undefined, flags: { redact: boolean }) => {
      const store = openStore(program.opts<GlobalOpts>());
      try {
        const run = requireRun(store, runArg);
        // A HAR leaves the machine with full bodies: every redaction rule applies, as to a pack.
        const rules = flags.redact ? loadConfig(process.cwd()).redact : [];
        const result = runToHar(store, run, store.getCalls(run.runId), { redact: rules });
        const body = JSON.stringify(result.har, null, 1) + '\n';
        if (!file) {
          process.stdout.write(body);
          if (!rules.length) process.stderr.write(p.dim('no redaction rules in shadowlap.config.json: the HAR holds the prompts and responses as recorded\n'));
          return;
        }
        const out = resolve(file);
        writeFileSync(out, body);
        console.log(`${p.green('\u2713')} ${out}  ${result.entries} ${result.entries === 1 ? 'call' : 'calls'}, ${formatBytes(fileSize(out))}${rules.length ? `, ${rules.length} redaction rule${rules.length === 1 ? '' : 's'} applied` : ''}`);
        if (!rules.length) console.log(p.dim('  no redaction rules in shadowlap.config.json: the HAR holds the prompts and responses as recorded'));
        for (const s of result.skipped) console.log(p.dim(`  call ${s.callNo} left out: ${s.reason}`));
        if (result.entries === 0) console.log(p.dim('  this run made no model API calls'));
      } finally {
        store.close();
      }
    });

  exportCmd
    .command('html')
    .description('A run as one HTML file: the dashboard\'s views with the data built in, to open anywhere, attach to a pull request or keep as an artifact. Redaction rules apply')
    .argument('<run>', 'run id or unique prefix')
    .argument('[file]', 'output file (default: shadowlap-<run>.html)')
    .option('--lineage', "include the run's ancestors, so its recording and forks compare inside the file")
    .option('--no-redact', 'skip the redaction rules in shadowlap.config.json')
    .action(async (runArg: string, file: string | undefined, flags: { lineage?: boolean; redact: boolean }) => {
      const store = openStore(program.opts<GlobalOpts>());
      try {
        const run = requireRun(store, runArg);
        const config = loadConfig(process.cwd());
        const { exportHtml, withAncestors } = await import('@shadowlap/dashboard');
        const runIds = flags.lineage ? withAncestors(store, run.runId) : [run.runId];
        const out = resolve(file ?? `shadowlap-${run.runId.slice(0, 10).toLowerCase()}.html`);
        const result = exportHtml({
          store,
          runIds: flags.lineage ? [run.runId, ...runIds.filter((id: string) => id !== run.runId)] : runIds,
          version: VERSION,
          ...(config.prices ? { prices: config.prices } : {}),
          ...(flags.redact && config.redact.length ? { redact: config.redact } : {}),
        });
        writeFileSync(out, result.html);
        const size = formatBytes(Buffer.byteLength(result.html));
        process.stdout.write(`${p.green('✓')} ${out}  ${p.dim(`${result.runIds.length} run${result.runIds.length === 1 ? '' : 's'}, ${result.calls} calls, ${size}${result.redacted ? ', redacted' : ''}`)}\n`);
        if (!result.redacted) process.stdout.write(p.dim('  no redaction rules in shadowlap.config.json: the file holds the prompts and tool data as recorded\n'));
      } finally {
        store.close();
      }
    });

  exportCmd
    .command('otel')
    .description('A run as an OpenTelemetry trace (OTLP/HTTP JSON, GenAI semantic conventions): printed, written to a file, or sent to a collector')
    .argument('<run>', 'run id or unique prefix')
    .option('--endpoint <url>', 'OTLP/HTTP endpoint, e.g. http://localhost:4318 (default: $OTEL_EXPORTER_OTLP_ENDPOINT; headers from $OTEL_EXPORTER_OTLP_HEADERS)')
    .option('--out <file>', 'write the JSON here instead of stdout')
    .option('--service <name>', 'service.name resource attribute', 'shadowlap-agent')
    .action(async (runArg: string, flags: { endpoint?: string; out?: string; service: string }) => {
      const store = openStore(program.opts<GlobalOpts>());
      const run = requireRun(store, runArg);
      const calls = store.getCalls(run.runId);
      store.close();
      const config = loadConfig(process.cwd());
      const payload = runToOtlp(run, calls, { serviceName: flags.service, version: VERSION, ...(config.prices ? { prices: config.prices } : {}) });
      const endpoint = flags.endpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
      const spans = calls.length + 1;
      if (flags.out) {
        writeFileSync(flags.out, JSON.stringify(payload) + '\n');
        process.stderr.write(`${p.green('✓')} wrote ${spans} spans for ${shortId(run.runId)} to ${flags.out}\n`);
      }
      if (endpoint) {
        await sendOtlp(endpoint, payload, otlpHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS));
        process.stderr.write(`${p.green('✓')} sent ${spans} spans for ${shortId(run.runId)} to ${endpoint}\n`);
      } else if (!flags.out) {
        process.stdout.write(JSON.stringify(payload) + '\n');
      }
    });

  program
    .command('rm')
    .description('Delete runs (their forks keep their data but lose the link); blobs nothing references any more are removed')
    .argument('<run...>', 'run ids or unique prefixes')
    .option('--forks', 'also delete the forks of each run, recursively')
    .action((runArgs: string[], flags: { forks?: boolean }) => {
      const store = openStore(program.opts<GlobalOpts>());
      const targets = new Map<string, RunRecord>();
      const collect = (run: RunRecord) => {
        targets.set(run.runId, run);
        if (flags.forks) for (const child of store.childRuns(run.runId)) collect(child);
      };
      for (const arg of runArgs) collect(requireRun(store, arg));
      for (const run of targets.values()) store.deleteRun(run.runId);
      const gc = store.gcBlobs();
      store.close();
      process.stdout.write(`${p.green('✓')} deleted ${targets.size} run${targets.size === 1 ? '' : 's'} (${[...targets.keys()].map((id) => shortId(id)).join(', ')}); ${gc.removed} blob${gc.removed === 1 ? '' : 's'}, ${formatBytes(gc.bytes)} freed\n`);
    });

  program
    .command('gc')
    .description('Compact the store: delete old runs (with --older-than or --keep), remove unreferenced blobs, vacuum')
    .option('--older-than <days>', 'delete runs that started more than <days> days ago', parseIntArg)
    .option('--keep <n>', 'keep only the newest <n> runs', parseIntArg)
    .option('--dry-run', 'show what would be deleted and stop')
    .action((flags: { olderThan?: number; keep?: number; dryRun?: boolean }) => {
      const opts = program.opts<GlobalOpts>();
      const dbPath = opts.db ?? defaultDbPath(process.cwd());
      const store = openStore(opts);
      const before = fileSize(dbPath);
      const runs = store.allRuns(); // newest first
      const cutoff = flags.olderThan !== undefined ? Date.now() - flags.olderThan * 86_400_000 : null;
      const doomed = runs.filter((r, i) => r.status !== 'running' && ((cutoff !== null && r.startedAt < cutoff) || (flags.keep !== undefined && i >= flags.keep)));
      if (flags.dryRun) {
        process.stdout.write(doomed.length ? `would delete ${doomed.length} of ${runs.length} runs:\n${doomed.map((r) => `  ${shortId(r.runId)}  ${r.mode}  ${p.dim(ago(r.startedAt))}\n`).join('')}` : `nothing to delete (${runs.length} runs)\n`);
        store.close();
        return;
      }
      for (const r of doomed) store.deleteRun(r.runId);
      const gc = store.gcBlobs();
      store.vacuum();
      store.close();
      const after = fileSize(dbPath);
      process.stdout.write(`${p.green('✓')} deleted ${doomed.length} run${doomed.length === 1 ? '' : 's'}, ${gc.removed} blob${gc.removed === 1 ? '' : 's'}; store ${formatBytes(before)} → ${formatBytes(after)}\n`);
    });

}
