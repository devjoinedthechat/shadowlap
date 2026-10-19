// docs/recording-format.md specifies packs for producers that write them without Shadowlap. Nothing
// generates the page from the engine, so these checks hold it to the engine: the version and the
// limits it states, the values it lists for each field (each accepted, and nothing else), the
// fingerprint headers per provider, and its worked example, which has to be exactly the pack a
// producer following the page writes, fingerprints included, and has to pass `shadowlap test`.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { FINGERPRINT_VERSION, PACK_FORMAT, PACK_LIMITS, PACK_VERSION, PackError, canonicalize, fingerprintApi, fingerprintTool, validateCall, validateRun } from '@shadowlap/engine';
import { providers } from '../../../packages/sidecar/src/providers.js';
import { ARGS, REQUEST, examplePack, exampleAgent } from './recording-format-example.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CLI = join(ROOT, 'packages', 'cli', 'bin', 'shadowlap.js');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const spec = read('docs/recording-format.md');
const example = examplePack();
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

/** The code-span values in the last cell of the table row that starts with `start`. */
function listed(start: string): string[] {
  const line = spec.split('\n').find((l) => l.startsWith(start));
  if (!line) throw new Error(`no row starting ${start}`);
  const cells = line.split(' | ');
  return [...new Set([...cells.at(-1)!.matchAll(/`([^`]+)`/g)].map((m) => m[1]!))];
}

/** Every fenced block's text. */
const blocks = [...spec.matchAll(/^```[^\n]*\n([\s\S]*?)^```/gm)].map((m) => m[1]!.replace(/\n$/, ''));

const [run] = (JSON.parse(example.files.get('run.json')!) as { runs: Array<Record<string, unknown>> }).runs;
const [apiCall, toolCall] = example.files.get('calls.jsonl')!.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
const accepts = (check: () => unknown) => {
  try {
    check();
    return true;
  } catch (err) {
    if (err instanceof PackError) return false;
    throw err;
  }
};

describe('the recording format', () => {
  it('is the version, and has the limits, the engine reads', () => {
    expect(spec).toMatch(new RegExp(`^Version ${PACK_VERSION}\\. `, 'm'));
    expect(spec).toContain(`| \`format\` | \`"${PACK_FORMAT}"\` |`);
    expect(spec).toContain(`| \`version\` | \`${PACK_VERSION}\`, this page.`);
    expect(spec).toContain(`(\`FINGERPRINT_VERSION\`, now ${FINGERPRINT_VERSION})`);
    const MiB = 1024 * 1024;
    const size = (n: number) => (n >= 1024 * MiB ? `${n / (1024 * MiB)} GiB` : `${n / MiB} MiB`);
    for (const [label, value] of [
      ['A blob', size(PACK_LIMITS.blobBytes)],
      ['All blobs', size(PACK_LIMITS.totalBytes)],
      ['`run.json`', size(PACK_LIMITS.manifestBytes)],
      ['`calls.jsonl`', size(PACK_LIMITS.callsBytes)],
      ['Runs', PACK_LIMITS.runs.toLocaleString('en-US')],
      ['Calls', PACK_LIMITS.calls.toLocaleString('en-US')],
      ["A command's arguments", String(PACK_LIMITS.argv)],
    ]) expect(spec, label).toContain(`| ${label} | ${value} |`);
  });

  it('lists every value a field may take, and only those', () => {
    const fields: Array<[string, string[], (v: string) => unknown]> = [
      ['| `kind` | yes |', ['api', 'tool', 'clock', 'random'], (v) => validateCall({ ...apiCall, kind: v }, 'call')],
      ['| `origin` | yes |', ['live', 'replayed', 'blocked', 'stubbed', 'overridden'], (v) => validateCall({ ...apiCall, origin: v }, 'call')],
      ['| `effect` | no |', ['pure', 'read', 'write', 'null'], (v) => validateCall({ ...toolCall, effect: v === 'null' ? null : v }, 'call')],
      ['| `mode` | yes |', ['record', 'replay'], (v) => validateRun({ ...run, mode: v }, 'run')],
      ['| `status` | yes |', ['running', 'completed', 'failed', 'crashed'], (v) => validateRun({ ...run, status: v }, 'run')],
      ['| `outcome` |', ['ok', 'error'], (v) => validateCall({ ...apiCall, end: { ...(apiCall!.end as object), outcome: v } }, 'call')],
    ];
    for (const [row, values, check] of fields) {
      expect(listed(row), row).toEqual(values);
      for (const v of values) expect(accepts(() => check(v)), `${row} ${v}`).toBe(true);
      expect(accepts(() => check('anything-else')), `${row} takes a value the page doesn't list`).toBe(false);
    }
    const types = /`type` \(([^)]+)\)/.exec(spec.split('\n').find((l) => l.startsWith('| `divergence` |'))!)![1]!;
    const divergences = [...types.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
    expect(divergences).toEqual(['request_changed', 'new_call', 'forced', 'beyond_recording', 'ended_early']);
    const divergence = (type: string) => validateRun({ ...run, divergence: { type, callNo: 1, kind: 'api', name: 'POST /v1/messages', replayedBefore: 0 } }, 'run');
    for (const type of divergences) expect(accepts(() => divergence(type)), type).toBe(true);
    expect(accepts(() => divergence('changed'))).toBe(false);
  });

  it('names every provider, with the headers that take part in its fingerprints', () => {
    expect(listed('| `provider` |').sort()).toEqual(providers.map((p) => p.id).sort());
    const table = new Map<string, string[]>();
    for (const line of spec.slice(spec.indexOf('| Provider | Fingerprint headers |')).split('\n').slice(2)) {
      if (!line.startsWith('|')) break;
      const [ids, headers] = line.split(' | ').map((c) => [...c.matchAll(/`([^`]+)`/g)].map((m) => m[1]!));
      for (const id of ids!) table.set(id, headers!);
    }
    for (const p of providers) expect(table.get(p.id), p.id).toEqual([...p.fingerprintHeaders]);
  });
});

describe('its worked example', () => {
  it('shows the pack a producer following the page writes, file for file', () => {
    expect(blocks).toContain(example.files.get('run.json')!.replace(/\n$/, ''));
    for (const call of [apiCall, toolCall]) expect(blocks).toContain(JSON.stringify(call, null, 2));
    for (const [name, text] of example.files) if (name.startsWith('blobs/')) expect(blocks, name).toContain(`${name}\n${text}`);
  });

  it('computes its fingerprints as the engine does', () => {
    const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
    const api = fingerprintApi({ method: 'POST', path: '/v1/messages', headers: { 'anthropic-version': '2023-06-01' }, body: REQUEST }, [], ['anthropic-version', 'anthropic-beta']);
    expect(api.fingerprint).toBe(example.fingerprints.api);
    // The object the page shows for it, spread over lines, is that canonical form.
    const shown = blocks.map((b) => {
      try {
        return JSON.parse(b) as Record<string, unknown>;
      } catch {
        return null;
      }
    });
    expect(shown.some((o) => o?.kind === 'api' && canonicalize(o) === api.canonical)).toBe(true);
    expect(sha(api.canonical)).toBe(example.fingerprints.api);
    const tool = fingerprintTool('lookup_order', ARGS, []);
    expect(tool.fingerprint).toBe(example.fingerprints.tool);
    expect(spec).toContain(`the SHA-256 of \`${tool.canonical}\``);
  });

  it('passes shadowlap test, with what the page says it prints', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sl-recording-format-'));
    dirs.push(dir);
    const pack = join(dir, 'refund-flow');
    mkdirSync(join(pack, 'blobs'), { recursive: true });
    for (const [name, text] of example.files) writeFileSync(join(pack, name), text);
    writeFileSync(join(dir, 'agent.mjs'), exampleAgent(pathToFileURL(join(ROOT, 'packages', 'sdk', 'dist', 'index.js')).href));
    const out = await new Promise<{ code: number | null; text: string }>((resolve) => {
      // Offline, as shadowlap test always is; the upstream is set only so nothing could reach a real API.
      const child = spawn(process.execPath, [CLI, 'test', 'refund-flow'], { cwd: dir, env: { ...process.env, SHADOWLAP_UPSTREAM_ANTHROPIC: 'http://127.0.0.1:9', SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', CI: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let text = '';
      child.stdout.on('data', (d: Buffer) => (text += d.toString()));
      child.stderr.on('data', (d: Buffer) => (text += d.toString()));
      child.on('close', (code) => resolve({ code, text }));
    });
    expect(out.code, out.text).toBe(0);
    const sample = blocks.find((b) => b.startsWith('✓ refund-flow:'))!;
    expect(sample).toBeTruthy();
    for (const line of sample.split('\n').filter(Boolean)) expect(out.text).toContain(line);
  });
});

describe('the page', () => {
  it('is linked where a reader of recordings looks', () => {
    for (const page of ['docs/index.md', 'docs/engine.md', 'docs/recordings-protocol.md', 'docs/protocol.md', 'docs/ci.md']) expect(read(page), page).toContain('(./recording-format.md');
  });
});
