import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command, InvalidArgumentError } from 'commander';
import { resolveAuthor, type Store } from '@shadowlap/engine';
import { importCaptured, type Captured, type ImportResult } from '../import-capture.js';
import { readHar } from '../import-har.js';
import { readNock } from '../import-nock.js';
import { readVcr } from '../import-vcr.js';
import { readLitellmGroups, type LitellmGroup } from '../import-litellm.js';
import { traceStoreHost } from '../import-fetch.js';
import { fetchLangfuseTrace, LANGFUSE_HOST, readLangfuse } from '../import-langfuse.js';
import { fetchLangsmithRuns, LANGSMITH_HOST, readLangsmith } from '../import-langsmith.js';
import { parseOtlpFile, readOtel } from '../import-otel.js';
import { settleImport, sourceName, type ImportFormat, type ImportJson, type TraceKept } from '../import-report.js';
import { importTrace, type Trace, type TraceImport } from '../import-trace.js';
import { openStore, type GlobalOpts } from '../shared.js';
import { palette as p, shortId } from '../ui.js';

/** Recordings from what already sat in front of the traffic. */

const HOSTS = 'Shadowlap reads Anthropic, OpenAI, Gemini, Azure, Vertex and Bedrock hosts.';

function printJson(json: ImportJson): void {
  console.log(JSON.stringify(json, null, 2));
  if (!json.runs.length) process.exitCode = 1;
}

function report(result: ImportResult, note: string): void {
  if (!result.imported.length) {
    console.error('No model API calls found.');
    const reasons = new Map<string, number>();
    for (const s of result.skipped) reasons.set(s.reason, (reasons.get(s.reason) ?? 0) + 1);
    for (const [reason, n] of [...reasons].sort((a, b) => b[1] - a[1])) console.error(`  ${n} ${n === 1 ? 'entry' : 'entries'}: ${reason}`);
    console.error(`\n${HOSTS} The capture must include response bodies.`);
    process.exitCode = 1;
    return;
  }

  const byProvider = new Map<string, number>();
  for (const c of result.imported) if (c.provider) byProvider.set(c.provider, (byProvider.get(c.provider) ?? 0) + 1);
  const providers = [...byProvider].map(([id, n]) => `${n} ${id}`).join(', ');
  console.log(`Imported ${p.bold(shortId(result.run.runId))}: ${result.imported.length} model ${result.imported.length === 1 ? 'call' : 'calls'} (${providers}).`);
  if (result.skipped.length) console.log(p.dim(`${result.skipped.length} ${result.skipped.length === 1 ? 'entry' : 'entries'} skipped (--json lists them).`));
  console.log(p.dim(note));
  console.log(`\nA capture says what was sent, not what sent it. Give your own command:\n  ${p.bold(`shadowlap replay ${shortId(result.run.runId)} -- <your agent command>`)}`);
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(resolve(file), 'utf8'));
  } catch (err) {
    throw new InvalidArgumentError(`${file} is not readable JSON: ${(err as Error).message}`);
  }
}

/** Who is importing, resolved once per command: each run's author and the activity event's actor. */
function author(): string | null {
  return resolveAuthor({ env: process.env, cwd: process.cwd() });
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Writes each trace as a run and settles the import. */
function importTraces(store: Store, format: 'otel' | 'langfuse' | 'langsmith', traces: Trace[], o: { source: string; spans: number; author: string | null }): { json: ImportJson; results: Array<{ trace: Trace; imported: TraceImport }> } {
  const results = traces.map((trace) => ({ trace, imported: importTrace(store, trace, { source: o.source, labels: [format], author: o.author }) }));
  const kept: TraceKept = { traces: traces.length, spans: o.spans, modelCalls: 0, modelCallsImported: 0, withSettings: 0, withToolDefinitions: 0, toolCalls: 0, toolCallsKept: 0 };
  for (const { imported } of results) for (const k of Object.keys(imported.counts) as Array<keyof TraceImport['counts']>) kept[k] += imported.counts[k];
  const json = settleImport(store, { format, entries: o.spans, runs: results.map((r) => ({ key: r.trace.id || null, result: r.imported.result })), kept, author: o.author });
  return { json, results };
}

/** What a trace import prints without --json: the runs, what the source kept, and how to replay. */
function reportTraces(json: ImportJson, results: Array<{ trace: Trace; imported: TraceImport }>, o: { source: string; unit: string; host?: string }): void {
  const kept = json.kept!;
  if (!json.runs.length) {
    console.error(`No model calls to import from ${o.source}: ${plural(kept.spans, o.unit)} read, ${plural(kept.modelCalls, 'model call')} found.`);
    const reasons = new Map<string, number>();
    for (const s of json.skipped) reasons.set(s.reason, (reasons.get(s.reason) ?? 0) + 1);
    for (const [reason, n] of [...reasons].sort((a, b) => b[1] - a[1])) console.error(`  ${n}: ${reason}`);
    if (!kept.modelCalls) console.error('\nA model call is a span with the OpenTelemetry GenAI conventions (gen_ai.*), a Langfuse generation or a LangSmith llm run, and it needs its messages logged.');
    process.exitCode = 1;
    return;
  }
  const done = results.filter((r) => r.imported.result.imported.length);
  const callsOf = (r: (typeof done)[number]) => {
    const { model, tool } = json.runs.find((x) => x.runId === r.imported.result.run.runId)!.calls;
    return `${plural(model, 'model call')}${tool ? ` and ${plural(tool, 'tool result')}` : ''}`;
  };
  if (done.length === 1) {
    const r = done[0]!;
    const dialects = Object.entries(r.imported.dialects).map(([d, n]) => `${n} ${d}`).join(', ');
    console.log(`Imported ${p.bold(shortId(r.imported.result.run.runId))} from ${o.source}: ${callsOf(r)} (${dialects}).`);
  } else {
    console.log(`Imported ${plural(done.length, 'run')} from ${o.source}, one per trace:`);
    for (const r of done) console.log(`  ${p.bold(shortId(r.imported.result.run.runId))}  ${callsOf(r)}  ${p.dim(`trace ${r.trace.id.slice(0, 16)}`)}`);
  }
  const tools = kept.toolCalls ? `, and the output of ${kept.toolCallsKept} of ${plural(kept.toolCalls, 'tool call')}${kept.toolCallsKept < kept.toolCalls ? ' (the others run live on replay, with writes fenced)' : ''}` : '';
  console.log(p.dim(`Read ${plural(kept.spans, o.unit)}. It kept the messages of ${kept.modelCallsImported} of ${plural(kept.modelCalls, 'model call')}, settings for ${kept.withSettings}, tool definitions for ${kept.withToolDefinitions}${tools}.`));
  if (json.skipped.length) console.log(p.dim(`${plural(json.skipped.length, 'call')} skipped (--json lists why).`));
  if (kept.withToolDefinitions < kept.modelCallsImported) {
    console.log(p.dim('Replay matches each model call on its whole request. Where the trace kept no tool definitions, a replay of an agent that sends tools forks at its first model call and runs live from there.'));
  }
  if (o.host) console.log(p.dim(`The keys were read from the environment and sent to ${o.host} only; nothing of them is stored.`));
  console.log(`\nA trace says what was sent, not what sent it. Give your own command:\n  ${p.bold(`shadowlap replay ${shortId(done[0]!.imported.result.run.runId)} -- <your agent command>`)}`);
}

/** A trace id as Langfuse and LangSmith write them (a UUID, or 32 hex characters), checked before it goes into a URL. */
function traceIdArg(raw: string): string {
  const id = raw.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(id)) throw new InvalidArgumentError(`not a trace id: "${raw}"`);
  return id;
}

/** The trace store's address: --host, else the variable its own SDK reads, else its public API. */
function hostFor(flag: string | undefined, envNames: string[], fallback: string, what: string): string {
  const fromEnv = envNames.map((n) => process.env[n]?.trim()).find(Boolean);
  try {
    return traceStoreHost(flag ?? fromEnv ?? fallback, what);
  } catch (err) {
    throw new InvalidArgumentError((err as Error).message);
  }
}

export function register(program: Command): void {
  program.commandsGroup('Import:');

  const importCmd = program.command('import').description('Turn a capture from another tool, or a trace you already keep, into a recording');

  const formats = [
    {
      name: 'har' as const,
      argument: 'the .har file',
      description:
        'Model API calls out of a HAR file (mitmproxy, Charles, Proxyman, browser devtools, Polly.js) as a recording you can replay your own code against',
      read: readHar,
      note: 'Streamed responses replay unpaced: a HAR has no event boundaries.',
    },
    {
      name: 'nock' as const,
      argument: 'the recording written by nock.recorder.rec({ output_objects: true })',
      description: 'Model API calls out of a nock recording, as a recording you can replay your own code against',
      read: readNock,
      note: 'Streamed responses replay unpaced: nock keeps the chunks but not their boundaries.',
    },
    {
      name: 'vcr' as const,
      argument: 'the cassette, in its JSON serialization',
      description: "Model API calls out of a VCR cassette (VCR.py's json serializer), as a recording you can replay your own code against",
      read: readVcr,
      note: 'Streamed responses replay unpaced: a cassette has no event boundaries.',
    },
  ];

  importCmd
    .command('litellm')
    .description("Model API calls captured by shadowlap.litellm_callback on a LiteLLM proxy: production traffic as recordings, one run per correlation id")
    .argument('<file...>', 'capture files (a proxy writes one per worker process)')
    .option('--json', 'machine-readable output: every run made, with its full id, source and call counts')
    .action((files: string[], flags: { json?: boolean }) => {
      const store = openStore(program.opts<GlobalOpts>());
      try {
        const who = author();
        const runs: Array<{ key: string | null; result: ImportResult }> = [];
        let entries = 0;
        for (const file of files) {
          const path = resolve(file);
          let contents: string;
          try {
            contents = readFileSync(path, 'utf8');
          } catch (err) {
            throw new InvalidArgumentError(`${file} is not readable: ${(err as Error).message}`);
          }
          let groups: LitellmGroup[];
          try {
            groups = readLitellmGroups(contents);
          } catch (err) {
            throw new InvalidArgumentError((err as Error).message);
          }
          for (const group of groups) {
            entries += group.calls.length + group.skipped.length;
            runs.push({ key: group.key, result: importCaptured(store, group, { source: path, author: who }) });
          }
        }

        const json = settleImport(store, { format: 'litellm', entries, runs, author: who });
        if (flags.json === true) return printJson(json);
        const kept = runs.filter((r) => r.result.imported.length);

        if (!kept.length) {
          console.error('No model API calls found.');
          const reasons = new Map<string, number>();
          for (const r of runs) for (const s of r.result.skipped) reasons.set(s.reason, (reasons.get(s.reason) ?? 0) + 1);
          for (const [reason, n] of [...reasons].sort((a, b) => b[1] - a[1])) console.error(`  ${n} ${n === 1 ? 'entry' : 'entries'}: ${reason}`);
          console.error(`\n${HOSTS} A capture is written only while SHADOWLAP_CAPTURE_DIR is set on the proxy.`);
          process.exitCode = 1;
          return;
        }

        const calls = kept.reduce((n, r) => n + r.result.imported.length, 0);
        console.log(`Imported ${kept.length} ${kept.length === 1 ? 'run' : 'runs'}, ${calls} model ${calls === 1 ? 'call' : 'calls'}:`);
        for (const { key, result } of kept) {
          const n = result.imported.length;
          console.log(`  ${p.bold(shortId(result.run.runId))}  ${n} ${n === 1 ? 'call' : 'calls'}  ${key ? p.dim(key) : p.yellow('no correlation id')}`);
        }
        // Without an id there is nothing to tell one agent run from another, so they arrive as one.
        if (kept.some((r) => r.key === null)) {
          console.log(p.dim('\nCalls with no correlation id were imported together. Have the agent send x-shadowlap-run so its runs stay apart.'));
        }
        console.log(p.dim('Streamed responses replay as one event: LiteLLM hands a callback an assembled response.'));
        console.log(`\nA capture says what was sent, not what sent it. Give your own command:\n  ${p.bold(`shadowlap replay ${shortId(kept[0]!.result.run.runId)} -- <your agent command>`)}`);
      } finally {
        store.close();
      }
    });

  for (const f of formats) {
    importCmd
      .command(f.name)
      .description(f.description)
      .argument('<file>', f.argument)
      .option('--json', 'machine-readable output: the run made, with its full id, source and call counts, and every entry skipped')
      .action((file: string, flags: { json?: boolean }) => {
        const parsed = readJson(file);
        const store = openStore(program.opts<GlobalOpts>());
        try {
          let captured: Captured;
          try {
            captured = f.read(parsed);
          } catch (err) {
            throw new InvalidArgumentError((err as Error).message);
          }
          const who = author();
          const result = importCaptured(store, captured, { source: resolve(file), author: who });
          const json = settleImport(store, { format: f.name, entries: captured.calls.length + captured.skipped.length, runs: [{ key: null, result }], author: who });
          if (flags.json === true) printJson(json);
          else report(result, f.note);
        } finally {
          store.close();
        }
      });
  }

  importCmd
    .command('otel')
    .description('Model and tool calls out of OpenTelemetry traces (OTLP JSON) with the GenAI semantic conventions, as partial recordings, one run per trace')
    .argument('<file>', 'OTLP JSON: an export request, or one per line as the collector\'s file exporter writes them')
    .option('--json', 'machine-readable output: every run made, with its full id, source and call counts, and what the traces kept')
    .action((file: string, flags: { json?: boolean }) => {
      const path = resolve(file);
      let read: ReturnType<typeof readOtel>;
      try {
        read = readOtel(parseOtlpFile(readFileSync(path, 'utf8')));
      } catch (err) {
        throw new InvalidArgumentError(`${file}: ${(err as Error).message}`);
      }
      const store = openStore(program.opts<GlobalOpts>());
      try {
        const { json, results } = importTraces(store, 'otel', read.traces, { source: path, spans: read.spans, author: author() });
        if (flags.json === true) printJson(json);
        else reportTraces(json, results, { source: sourceName(path), unit: 'span' });
      } finally {
        store.close();
      }
    });

  importCmd
    .command('langfuse')
    .description('A Langfuse trace as a partial recording: generations become model calls, tool spans that kept their input and output become tool calls. Reads LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY')
    .argument('<trace-id>', "the id on the trace's page in Langfuse", traceIdArg)
    .option('--host <url>', `the Langfuse API, for a self-hosted instance or another region (default: LANGFUSE_HOST, else ${LANGFUSE_HOST})`)
    .option('--json', 'machine-readable output: the run made, with its full id, source and call counts, and what the trace kept')
    .action(async (traceId: string, flags: { host?: string; json?: boolean }) => {
      const publicKey = process.env.LANGFUSE_PUBLIC_KEY?.trim();
      const secretKey = process.env.LANGFUSE_SECRET_KEY?.trim();
      if (!publicKey || !secretKey) throw new InvalidArgumentError("import langfuse reads the project's keys from LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY; set both (they are on the project's settings page in Langfuse)");
      const host = hostFor(flags.host, ['LANGFUSE_HOST', 'LANGFUSE_BASE_URL'], LANGFUSE_HOST, 'Langfuse');
      const trace = readLangfuse(await fetchLangfuseTrace(traceId, { host, publicKey, secretKey }));
      const source = `langfuse:${traceId.slice(0, 8)}`;
      const store = openStore(program.opts<GlobalOpts>());
      try {
        const { json, results } = importTraces(store, 'langfuse', [{ ...trace, id: traceId }], { source, spans: trace.spans, author: author() });
        if (flags.json === true) printJson(json);
        else reportTraces(json, results, { source, unit: 'observation', host: new URL(host).host });
      } finally {
        store.close();
      }
    });

  importCmd
    .command('langsmith')
    .description('A LangSmith trace as a partial recording: llm runs become model calls, tool runs that kept their inputs and outputs become tool calls. Reads LANGSMITH_API_KEY')
    .argument('<trace-id>', "the trace's id (its root run's id) in LangSmith", traceIdArg)
    .option('--host <url>', `the LangSmith API, for a self-hosted instance or another region (default: LANGSMITH_ENDPOINT, else ${LANGSMITH_HOST})`)
    .option('--json', 'machine-readable output: the run made, with its full id, source and call counts, and what the trace kept')
    .action(async (traceId: string, flags: { host?: string; json?: boolean }) => {
      const apiKey = (process.env.LANGSMITH_API_KEY ?? process.env.LANGCHAIN_API_KEY)?.trim();
      if (!apiKey) throw new InvalidArgumentError('import langsmith reads the API key from LANGSMITH_API_KEY; set it (Settings → API Keys in LangSmith)');
      const host = hostFor(flags.host, ['LANGSMITH_ENDPOINT', 'LANGCHAIN_ENDPOINT'], LANGSMITH_HOST, 'LangSmith');
      const runs = await fetchLangsmithRuns(traceId, { host, apiKey });
      const trace = readLangsmith(runs, traceId);
      const source = `langsmith:${traceId.slice(0, 8)}`;
      const store = openStore(program.opts<GlobalOpts>());
      try {
        const { json, results } = importTraces(store, 'langsmith', [trace], { source, spans: trace.spans, author: author() });
        if (flags.json === true) printJson(json);
        else reportTraces(json, results, { source, unit: 'run', host: new URL(host).host });
      } finally {
        store.close();
      }
    });
}
