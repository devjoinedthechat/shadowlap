import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command, InvalidArgumentError } from 'commander';
import { resolveAuthor } from '@shadowlap/engine';
import { importCaptured, type Captured, type ImportResult } from '../import-capture.js';
import { readHar } from '../import-har.js';
import { readNock } from '../import-nock.js';
import { readVcr } from '../import-vcr.js';
import { readLitellmGroups, type LitellmGroup } from '../import-litellm.js';
import { settleImport, type ImportJson } from '../import-report.js';
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
}
