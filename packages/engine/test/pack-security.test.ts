import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { commandIsImported, hasRecordedCommand, NO_COMMAND, unpackRun } from '../src/pack.js';
import { PackError } from '../src/pack-schema.js';
import { Store } from '../src/store.js';
import { safeLine, safeText } from '../src/text.js';

/** A pack is untrusted input. Each case starts from the committed golden and breaks one thing. */
const GOLDEN = fileURLToPath(new URL('../../../testing/golden/reference-agent', import.meta.url));
const ESC = String.fromCharCode(27);
let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function copyGolden(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fp-pack-sec-'));
  dirs.push(dir);
  cpSync(GOLDEN, dir, { recursive: true });
  return dir;
}
const manifest = (dir: string) => JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')) as { runs: Array<Record<string, unknown>> };
const writeManifest = (dir: string, m: unknown) => writeFileSync(join(dir, 'run.json'), JSON.stringify(m));
const callLines = (dir: string) => readFileSync(join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
const writeCalls = (dir: string, calls: unknown[]) => writeFileSync(join(dir, 'calls.jsonl'), calls.map((c) => JSON.stringify(c)).join('\n') + '\n');

function rejects(dir: string, message: RegExp): void {
  const store = Store.open(':memory:');
  try {
    expect(() => unpackRun(store, dir)).toThrow(PackError);
    expect(() => unpackRun(store, dir)).toThrow(message);
    expect(store.allRuns()).toHaveLength(0); // nothing half-imported
  } finally {
    store.close();
  }
}

describe('unpack: a pack is untrusted input', () => {
  it('imports the golden, marks it imported and reports the command it would run', () => {
    const store = Store.open(':memory:');
    const dir = copyGolden();
    const m = manifest(dir);
    (m.runs[0]!.meta as Record<string, unknown> | undefined) ?? (m.runs[0]!.meta = {});
    (m.runs[0]!.meta as Record<string, unknown>).imported = undefined; // a pack cannot pretend to be local
    writeManifest(dir, m);
    const r = unpackRun(store, dir);
    expect(r.imported).toHaveLength(1);
    expect(r.commands[0]!.argv.length).toBeGreaterThan(0);
    const run = store.getRun(r.imported[0]!)!;
    expect(run.meta?.imported?.from).toBe(dir.split(/[\\/]/).pop());
    expect(commandIsImported(run)).toBe(true);
    store.close();
  });

  it('reads only its own pack format', () => {
    const other = copyGolden();
    writeManifest(other, { ...manifest(other), format: 'some-other-pack' });
    rejects(other, /unexpected format some-other-pack/);
  });

  it('keeps a capture without a command: it packs and unpacks, but is not runnable', () => {
    const dir = copyGolden();
    const m = manifest(dir);
    (m.runs[0]!.command as { argv: string[] }).argv = [NO_COMMAND];
    writeManifest(dir, m);
    const store = Store.open(':memory:');
    const run = store.getRun(unpackRun(store, dir).imported[0]!)!;
    expect(hasRecordedCommand(run)).toBe(false);
    expect(hasRecordedCommand({ ...run, command: { ...run.command, argv: ['node', NO_COMMAND] } })).toBe(true);
    expect(hasRecordedCommand({ ...run, command: { ...run.command, argv: [] } })).toBe(false);
    store.close();
  });

  it('rejects run ids that are not ids (they end up in paths)', () => {
    const dir = copyGolden();
    const m = manifest(dir);
    m.runs[0]!.runId = '../../../tmp/owned';
    writeManifest(dir, m);
    rejects(dir, /runId: must be a run id/);
  });

  it('rejects control characters in commands and names (terminal escape injection)', () => {
    const dir = copyGolden();
    const m = manifest(dir);
    (m.runs[0]!.command as { argv: string[] }).argv = ['node', `agent.js${ESC}]0;owned${String.fromCharCode(7)}`];
    writeManifest(dir, m);
    rejects(dir, /argv\[1\]: contains control characters/);

    const dir2 = copyGolden();
    const calls = callLines(dir2);
    calls[3]!.name = `search_web${ESC}[2J`;
    writeCalls(dir2, calls);
    rejects(dir2, /line 4\.name: contains control characters/);
  });

  it('rejects malformed records with the line that is wrong', () => {
    const cases: Array<[(c: Array<Record<string, unknown>>) => void, RegExp]> = [
      [(c) => (c[0]!.kind = 'shell'), /line 1\.kind: must be one of/],
      [(c) => (c[1]!.callNo = -1), /line 2\.callNo: must be an integer/],
      [(c) => (c[2]!.requestRef = '../../etc/passwd'), /line 3\.requestRef: must be a SHA-256 blob hash/],
      [(c) => ((c[2]!.end as Record<string, unknown>).runId = '01ARZ3NDEKTSV4RRFFQ69G5FAV'), /line 3\.end\.runId: must match the call/],
      [(c) => (c[4]!.origin = 'teleported'), /line 5\.origin: must be one of/],
      [(c) => c.push({ ...c[0]! }), /appears twice/],
      [(c) => c.push({ ...c[0]!, runId: '01ARZ3NDEKTSV4RRFFQ69G5FAV', callNo: 99, end: { ...(c[0]!.end as object), runId: '01ARZ3NDEKTSV4RRFFQ69G5FAV', callNo: 99 } }), /is not in run\.json/],
    ];
    for (const [mutate, message] of cases) {
      const dir = copyGolden();
      const calls = callLines(dir);
      mutate(calls);
      writeCalls(dir, calls);
      rejects(dir, message);
    }
    const dir = copyGolden();
    writeFileSync(join(dir, 'calls.jsonl'), '{"runId": oops\n');
    rejects(dir, /line 1: not valid JSON/);
  });

  it('rejects a blame record without the fields every reader of it relies on', () => {
    const blame = { at: 1, outcome: 'blamed', callNo: 2, confidence: 'high', rescuedRunId: null, fields: {}, oracle: ['the agent exits 0'], probes: [{ callNo: 2, passes: 3, attempts: 3, rescued: true }], spent: 0.04 };
    const withBlame = (b: unknown) => {
      const dir = copyGolden();
      const m = manifest(dir);
      m.runs[0]!.meta = { ...((m.runs[0]!.meta as object | undefined) ?? {}), blame: b };
      writeManifest(dir, m);
      return dir;
    };
    const { oracle: _oracle, ...noOracle } = blame;
    const cases: Array<[unknown, RegExp]> = [
      [noOracle, /meta\.blame\.oracle: must be an array/],
      [{ ...blame, oracle: [7] }, /meta\.blame\.oracle\[0\]: must be a string/],
      [{ ...blame, fields: 'temperature' }, /meta\.blame\.fields: must be an object/],
      [{ ...blame, outcome: 'maybe' }, /meta\.blame\.outcome: must be one of/],
      [{ ...blame, probes: [{ callNo: 2 }] }, /meta\.blame\.probes\[0\]\.passes: must be an integer/],
      [{ ...blame, rescuedRunId: '../x' }, /meta\.blame\.rescuedRunId: must be a run id or null/],
      ['blamed', /meta\.blame: must be an object/],
    ];
    for (const [b, message] of cases) rejects(withBlame(b), message);
    // The record blame writes imports.
    const store = Store.open(':memory:');
    const run = store.getRun(unpackRun(store, withBlame({ ...blame, scope: 'triage' })).imported[0]!)!;
    expect(run.meta?.blame).toEqual({ ...blame, scope: 'triage' });
    store.close();
  });

  it('rejects a pack whose calls need blobs it does not contain', () => {
    const dir = copyGolden();
    const calls = callLines(dir);
    const needed = (calls.find((c) => c.kind === 'tool')!.end as { responseRef: string }).responseRef;
    rmSync(join(dir, 'blobs', needed));
    rejects(dir, /needs blob/);
  });

  it('rejects symbolic links, tampered blobs and stray files', () => {
    if (process.platform !== 'win32') {
      const dir = copyGolden();
      const outside = join(mkdtempSync(join(tmpdir(), 'fp-outside-')), 'secret');
      dirs.push(join(outside, '..'));
      writeFileSync(outside, 'not for you');
      const [victim] = callLines(dir).map((c) => c.requestRef as string).filter(Boolean);
      rmSync(join(dir, 'blobs', victim!));
      symlinkSync(outside, join(dir, 'blobs', victim!));
      rejects(dir, /symbolic link/);
    }
    const dir2 = copyGolden();
    const any = callLines(dir2).map((c) => c.requestRef as string).filter(Boolean)[0]!;
    writeFileSync(join(dir2, 'blobs', any), 'tampered');
    rejects(dir2, /does not match its hash/);

    const dir3 = copyGolden();
    mkdirSync(join(dir3, 'blobs', 'nested'));
    rejects(dir3, /unexpected file blobs\/nested/);
  });

  it('skips runs that already exist instead of overwriting them', () => {
    const store = Store.open(':memory:');
    const dir = copyGolden();
    expect(unpackRun(store, dir).imported).toHaveLength(1);
    expect(unpackRun(store, dir)).toMatchObject({ imported: [], skipped: [expect.any(String)] });
    store.close();
  });

  it('brings in a run marked running as interrupted: nothing here records it', () => {
    const dir = copyGolden();
    const m = manifest(dir);
    const run = m.runs[0]!;
    run.status = 'running';
    delete run.endedAt; // left out, not null: imports all the same
    writeManifest(dir, m);
    const lastAt = Math.max(...callLines(dir).flatMap((c) => [c.at as number, ((c.end as { at?: number } | null)?.at ?? 0)]));
    const store = Store.open(':memory:');
    const id = unpackRun(store, dir).imported[0]!;
    expect(store.getRun(id)).toMatchObject({ status: 'crashed', endedAt: lastAt });
    // So rm and gc don't take it for a recording.
    expect(store.recordingRuns().live).toEqual([]);
    expect(store.deletionHold(id)).toBeNull();
    store.close();
  });

  it('rejects times further ahead than another machine\'s clock could be', () => {
    const dir = copyGolden();
    const m = manifest(dir);
    m.runs[0]!.status = 'running';
    m.runs[0]!.endedAt = null;
    m.runs[0]!.startedAt = Date.now() + 10 * 365 * 24 * 3600_000;
    writeManifest(dir, m);
    rejects(dir, /runs\[0\]\.startedAt: is more than a day in the future/);

    const dir2 = copyGolden();
    const calls = callLines(dir2);
    calls[0]!.at = Date.now() + 2 * 24 * 3600_000;
    writeCalls(dir2, calls);
    rejects(dir2, /line 1\.at: is more than a day in the future/);
  });
});

describe('terminal-safe text', () => {
  it('shows control characters as escapes and keeps layout where allowed', () => {
    expect(safeText(`a${ESC}[31mb\tc\nd`)).toBe('a\\x1b[31mb\tc\nd');
    // A carriage return can overwrite what is already on the line, so it is escaped even in safeText.
    expect(safeLine('a\nb\tc\rd')).toBe('a\\nb\\tc\\x0dd');
    expect(safeText(`x${String.fromCharCode(0x9b)}y`)).toBe('x\\x9by');
    expect(safeText('plain · text')).toBe('plain · text');
  });
});
