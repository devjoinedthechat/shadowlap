import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command, InvalidArgumentError } from 'commander';
import { DATASET_FORMATS, datasetRows, type DatasetFormat, type RunRecord, type Store } from '@shadowlap/engine';
import { defaultDbPath, loadConfig } from '../config.js';
import { runToHar } from '../export-har.js';
import { emitJobEvent } from '../job-events.js';
import { otlpHeaders, runToOtlp, sendOtlp } from '../otel.js';
import { fileSize, formatBytes, openStore, parseChoice, parseIntArg, recordActivity, requireRun, VERSION, type GlobalOpts } from '../shared.js';
import { ago, palette as p, quoteArgv, safe, shortId } from '../ui.js';

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
    .description("A run's model API calls as a HAR, for any tool that reads one; the reverse of shadowlap import har. Tool, clock and randomness calls are left out: a HAR describes HTTP")
    .argument('<run>', 'run id or unique prefix')
    .argument('[file]', 'output file (default: stdout)')
    .action((runArg: string, file: string | undefined) => {
      const store = openStore(program.opts<GlobalOpts>());
      try {
        const run = requireRun(store, runArg);
        const result = runToHar(store, run, store.getCalls(run.runId));
        const body = JSON.stringify(result.har, null, 1) + '\n';
        if (!file) {
          process.stdout.write(body);
          return;
        }
        const out = resolve(file);
        writeFileSync(out, body);
        console.log(`${p.green('\u2713')} ${out}  ${result.entries} ${result.entries === 1 ? 'call' : 'calls'}, ${formatBytes(fileSize(out))}`);
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
    .description('Clean up the store: delete old runs (--older-than, --keep), remove blobs nothing references, and vacuum. Runs still recording are never touched')
    .option('--older-than <days>', 'delete runs that started more than <days> days ago', parseIntArg)
    .option('--keep <n>', 'keep only the newest <n> runs', parseIntArg)
    .option('--dry-run', 'show what it would delete and free, and change nothing')
    .option('--json', 'machine-readable output')
    .action((flags: { olderThan?: number; keep?: number; dryRun?: boolean; json?: boolean }) => {
      const opts = program.opts<GlobalOpts>();
      const dbPath = opts.db ?? defaultDbPath(process.cwd());
      const store = openStore(opts);
      let report: GcReport;
      try {
        report = cleanUp(store, dbPath, flags);
      } finally {
        store.close();
      }
      if (!report.dryRun) {
        report.store.after = storeBytes(dbPath);
        if (report.runs.length || report.blobs) {
          recordActivity(opts, [{ kind: 'runs.cleaned', data: { runs: report.runs.length, blobs: report.blobs, bytes: report.bytes, olderThanDays: report.olderThanDays, keep: report.keep } }]);
        }
      }
      emitJobEvent({ type: 'result', data: report });
      process.stdout.write(flags.json ? JSON.stringify(report, null, 2) + '\n' : formatGc(report));
    });
}

/** What `gc` deleted, or with --dry-run would delete: the same object `--json` prints. */
export interface GcReport {
  dryRun: boolean;
  olderThanDays: number | null;
  keep: number | null;
  /** Runs in the store before. */
  total: number;
  /** Runs deleted (or that would be), newest first. */
  runs: Array<{ runId: string; mode: RunRecord['mode']; status: RunRecord['status']; startedAt: number; command: string }>;
  /** Blobs nothing would reference any more, and the bytes they take in the store. */
  blobs: number;
  bytes: number;
  /** The store's size on disk before, and after a run that wasn't a dry run. */
  store: { path: string; before: number; after: number | null };
}

/** The store file and its write-ahead log, which holds what was written since the last checkpoint. */
function storeBytes(dbPath: string): number {
  return fileSize(dbPath) + fileSize(`${dbPath}-wal`);
}

/** Picks the runs `gc` deletes, says what that frees, and deletes unless it is a dry run. */
export function cleanUp(store: Store, dbPath: string, flags: { olderThan?: number; keep?: number; dryRun?: boolean }, now = Date.now()): GcReport {
  const runs = store.allRuns(); // newest first
  const cutoff = flags.olderThan !== undefined ? now - flags.olderThan * 86_400_000 : null;
  const doomed = runs.filter((r, i) => r.status !== 'running' && ((cutoff !== null && r.startedAt < cutoff) || (flags.keep !== undefined && i >= flags.keep)));
  const freed = store.unreferencedBlobs(doomed.map((r) => r.runId));
  const report: GcReport = {
    dryRun: flags.dryRun === true,
    olderThanDays: flags.olderThan ?? null,
    keep: flags.keep ?? null,
    total: runs.length,
    runs: doomed.map((r) => ({ runId: r.runId, mode: r.mode, status: r.status, startedAt: r.startedAt, command: quoteArgv(r.command.argv) })),
    blobs: freed.hashes.length,
    bytes: freed.bytes,
    store: { path: dbPath, before: storeBytes(dbPath), after: null },
  };
  if (report.dryRun) return report;
  store.transaction(() => {
    for (const r of doomed) store.deleteRun(r.runId);
  });
  store.gcBlobs();
  store.vacuum();
  return report;
}

const SHOWN = 20;

function formatGc(r: GcReport): string {
  const criteria = [r.olderThanDays !== null ? `older than ${r.olderThanDays} day${r.olderThanDays === 1 ? '' : 's'}` : null, r.keep !== null ? `beyond the newest ${r.keep}` : null].filter(Boolean).join(' or ');
  const lines: string[] = [];
  if (criteria) {
    const count = r.runs.length ? `${r.runs.length} of ${r.total}` : 'none';
    lines.push(`${p.dim('▸')} runs ${criteria}: ${count} ${p.dim('· runs still recording are never touched')}`);
    for (const run of r.runs.slice(0, SHOWN)) lines.push(`    ${shortId(run.runId)}  ${run.mode}  ${run.status}  ${p.dim(ago(run.startedAt))}  ${p.dim(safe(run.command))}`);
    if (r.runs.length > SHOWN) lines.push(p.dim(`    … and ${r.runs.length - SHOWN} more`));
  } else {
    lines.push(`${p.dim('▸')} no runs to delete ${p.dim('(--older-than <days> or --keep <n> picks them)')}`);
  }
  lines.push(`  blobs nothing ${r.dryRun ? 'would reference' : 'referenced'}: ${r.blobs} · ${formatBytes(r.bytes)}`);
  if (r.dryRun) {
    const what = [r.runs.length ? `delete ${r.runs.length} run${r.runs.length === 1 ? '' : 's'}` : null, `free ${formatBytes(r.bytes)}`].filter(Boolean).join(' and ');
    lines.push(`${p.green('✓')} dry run: would ${what}. Run it without --dry-run to delete.`);
  } else {
    lines.push(`${p.green('✓')} deleted ${r.runs.length} run${r.runs.length === 1 ? '' : 's'} and ${r.blobs} blob${r.blobs === 1 ? '' : 's'} · store ${formatBytes(r.store.before)} → ${formatBytes(r.store.after ?? r.store.before)}`);
  }
  return lines.join('\n') + '\n';
}
