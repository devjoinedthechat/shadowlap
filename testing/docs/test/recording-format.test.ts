// docs/recording-format.md specifies packs for producers that write them without Shadowlap, and the
// recordings protocol a test runner records through. Nothing generates the page from the code, so
// these checks hold it to the code: the version and the limits it states, the values it lists for
// each field (each accepted, and nothing else), the fingerprint headers per provider, its worked
// example, which has to be exactly the pack a producer following the page writes, fingerprints
// included, and has to pass `shadowlap test`, and the protocol, spoken to a real
// `shadowlap serve --recordings` with the page's own examples.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { FINGERPRINT_VERSION, PACK_FORMAT, PACK_LIMITS, PACK_VERSION, PackError, canonicalize, fingerprintApi, fingerprintTool, validateCall, validateRun } from '@shadowlap/engine';
import { hostedProviders, providers } from '../../../packages/sidecar/src/providers.js';
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
  return [...new Set([...cells.at(-1)!.matchAll(/`([^`]+)`/g)].map((m) => m[1]))];
}

/** Every fenced block's text. */
const blocks = [...spec.matchAll(/^```[^\n]*\n([\s\S]*?)^```/gm)].map((m) => m[1].replace(/\n$/, ''));

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
      ['| `outcome` |', ['ok', 'error'], (v) => validateCall({ ...apiCall, end: { ...(apiCall.end as object), outcome: v } }, 'call')],
    ];
    for (const [row, values, check] of fields) {
      expect(listed(row), row).toEqual(values);
      for (const v of values) expect(accepts(() => check(v)), `${row} ${v}`).toBe(true);
      expect(accepts(() => check('anything-else')), `${row} takes a value the page doesn't list`).toBe(false);
    }
    const types = /`type` \(([^)]+)\)/.exec(spec.split('\n').find((l) => l.startsWith('| `divergence` |'))!)![1];
    const divergences = [...types.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    expect(divergences).toEqual(['request_changed', 'new_call', 'forced', 'beyond_recording', 'ended_early']);
    const divergence = (type: string) => validateRun({ ...run, divergence: { type, callNo: 1, kind: 'api', name: 'POST /v1/messages', replayedBefore: 0 } }, 'run');
    for (const type of divergences) expect(accepts(() => divergence(type)), type).toBe(true);
    expect(accepts(() => divergence('changed'))).toBe(false);
  });

  it('names every provider, with the headers that take part in its fingerprints', () => {
    expect(listed('| `provider` |').sort()).toEqual(providers.map((p) => p.id).sort());
    // A call through a host of another's format is recorded under the format's provider, and names the host as `via`.
    for (const p of hostedProviders) expect(listed('| `via` |'), p.id).toContain(p.id);
    const table = new Map<string, string[]>();
    for (const line of spec.slice(spec.indexOf('| Provider | Fingerprint headers |')).split('\n').slice(2)) {
      if (!line.startsWith('|')) break;
      const [ids, headers] = line.split(' | ').map((c) => [...c.matchAll(/`([^`]+)`/g)].map((m) => m[1]));
      for (const id of ids) table.set(id, headers);
    }
    for (const p of [...providers, ...hostedProviders]) expect(table.get(p.id), p.id).toEqual([...p.fingerprintHeaders]);
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
      // With the yes the page gives it: the pack is the producer's, which no repository tracks yet.
      const child = spawn(process.execPath, [CLI, 'test', 'refund-flow', '--yes'], { cwd: dir, env: { ...process.env, SHADOWLAP_UPSTREAM_ANTHROPIC: 'http://127.0.0.1:9', SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', CI: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
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

/** The JSON block the page shows inside a list item after `words`, its indent taken off. */
function listBlock(words: string): unknown {
  const m = /^( *)```json\n([\s\S]*?)^ *```/m.exec(spec.slice(spec.indexOf(words)));
  if (!m) throw new Error(`no JSON block after ${words}`);
  return JSON.parse(m[2].split('\n').map((l) => l.slice(m[1].length)).join('\n'));
}
/** The page's top-level JSON block that starts with `start`, parsed. */
const shown = (start: string): Record<string, unknown> => JSON.parse(blocks.find((b) => b.startsWith(start))!) as Record<string, unknown>;
const keysOf = (o: unknown) => Object.keys(o as object).sort();

describe('its recordings protocol', () => {
  it('is what shadowlap serve --recordings speaks: the handshake, the routes, and what each answers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sl-recordings-protocol-'));
    dirs.push(dir);
    const host = spawn(process.execPath, [CLI, 'serve', '--recordings'], { cwd: dir, env: { ...process.env, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
    const exited = new Promise((r) => host.once('exit', r));
    try {
      const line = await new Promise<string>((resolve, reject) => {
        let out = '';
        const timer = setTimeout(() => reject(new Error(`no handshake: ${out}`)), 20_000);
        host.stdout.on('data', (d: Buffer) => {
          out += d.toString();
          if (out.includes('\n')) {
            clearTimeout(timer);
            resolve(out.slice(0, out.indexOf('\n')));
          }
        });
      });
      const handshake = JSON.parse(line) as { shadowlap: string; url: string; env: Record<string, string>; capture: object };
      const example = listBlock('Read **one line** of JSON') as { env: object; capture: object };
      expect(keysOf(handshake)).toEqual(keysOf(example));
      expect(keysOf(handshake.capture)).toEqual(keysOf(example.capture));
      expect(handshake.shadowlap).toBe((JSON.parse(read('packages/cli/package.json')) as { version: string }).version);
      expect(handshake.env.ANTHROPIC_BASE_URL).toMatch(/\/s\/__SLOT__\/anthropic$/);
      expect(handshake.env).toHaveProperty('SHADOWLAP_CAPTURE');

      expect([...spec.matchAll(/^#### `POST (\/v1\/recordings\/\w+)`$/gm)].map((m) => m[1])).toEqual(['/v1/recordings/start', '/v1/recordings/calls', '/v1/recordings/end']);
      const post = (path: string, body: unknown) => fetch(`${handshake.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      // A recording outside the root, and one to replay that isn't there: the statuses the page gives, the error as it shows it.
      const outside = await post('/v1/recordings/start', { recording: '../elsewhere', slot: 'gw0' });
      expect(outside.status).toBe(400);
      expect(await outside.json()).toEqual({ type: 'error', error: { type: 'shadowlap_error', message: expect.any(String) } });
      expect((await post('/v1/recordings/start', { recording: 'tests/recordings/refund-flow', slot: 'gw0', mode: 'none' })).status).toBe(404);

      // The page's own start request: 201, and the response it shows.
      const res = await post('/v1/recordings/start', shown('{ "recording":'));
      expect(res.status).toBe(201);
      const started = (await res.json()) as { runId: string };
      expect(keysOf(started)).toEqual(keysOf(shown('{ "runId": "01K5CQ4N7G…", "mode"')));
      expect(started).toMatchObject({ mode: 'record', recording: 'tests/recordings/refund-flow' });
      const calls = await (await post('/v1/recordings/calls', { runId: started.runId })).json();
      expect(keysOf(calls)).toEqual(keysOf(shown('{\n  "answer"')));
      expect(calls).toEqual({ answer: null, calls: [] });
      // A test that passed without a call reaching the host: nothing saved, and the fields the page names.
      const ended = (await (await post('/v1/recordings/end', { runId: started.runId, passed: true })).json()) as Record<string, unknown>;
      expect(keysOf(ended)).toEqual([...keysOf(shown('{\n  "ok": false')), 'saved'].sort());
      expect(ended).toMatchObject({ ok: true, mode: 'record', saved: false, report: null });
      expect(existsSync(join(dir, 'tests', 'recordings', 'refund-flow'))).toBe(false);
      expect((await post('/v1/recordings/calls', { runId: started.runId })).status).toBe(404);
    } finally {
      // Closing stdin is how the host is told to stop.
      host.stdin.end();
      await exited;
    }
  }, 60_000);
});

describe('the page', () => {
  it('is linked where a reader of recordings looks, and is the one page for the protocol too', () => {
    for (const page of ['docs/index.md', 'docs/engine.md', 'docs/protocol.md', 'docs/ci.md', 'docs/testing.md']) expect(read(page), page).toContain('(./recording-format.md');
    expect(read('docs/testing.md')).toContain('(./recording-format.md#the-recordings-protocol)');
    expect(existsSync(join(ROOT, 'docs', 'recordings-protocol.md'))).toBe(false);
    for (const page of [...readdirSync(join(ROOT, 'docs')).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`), 'README.md']) expect(read(page), page).not.toContain('recordings-protocol.md');
  });

  it('opens with what a recording is, so that is what a page about it is described by', () => {
    const lede = spec.split('\n\n')[1];
    expect(lede).toMatch(/^A recording is everything an agent run said to the world and heard back/);
  });
});
