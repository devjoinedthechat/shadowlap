import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { swapPack } from '../src/golden-update.js';

/** How `test --update` puts a new pack in place of a golden's: only the pack's own entries move. */
const root = mkdtempSync(join(tmpdir(), 'sl-swap-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const BLOB_A = 'a'.repeat(64);
const BLOB_B = 'b'.repeat(64);

function pack(dir: string, files: Record<string, string>): string {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

/** Every file under a folder, with its content. */
function contents(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) out[join(entry.parentPath, entry.name).slice(dir.length + 1)] = readFileSync(join(entry.parentPath, entry.name), 'utf8');
  }
  return out;
}

describe('replacing a golden\'s pack', () => {
  it('replaces run.json, calls.jsonl and blobs/, and keeps every other file in the folder', () => {
    const golden = pack(join(root, 'one', 'golden'), { 'run.json': 'old run', 'calls.jsonl': 'old calls', [`blobs/${BLOB_A}`]: 'old blob', 'NOTES.md': 'notes', 'expect.json': '{}' });
    const fresh = pack(join(root, 'one', 'new'), { 'run.json': 'new run', 'calls.jsonl': 'new calls', [`blobs/${BLOB_B}`]: 'new blob' });
    const aside = join(root, 'one', 'old');
    mkdirSync(aside);
    swapPack(golden, fresh, aside);
    expect(contents(golden)).toEqual({ 'run.json': 'new run', 'calls.jsonl': 'new calls', [join('blobs', BLOB_B)]: 'new blob', 'NOTES.md': 'notes', 'expect.json': '{}' });
    expect(contents(aside)).toEqual({ 'run.json': 'old run', 'calls.jsonl': 'old calls', [join('blobs', BLOB_A)]: 'old blob' });
  });

  it('puts the old pack back when the swap fails part way, so the golden is never a mix', () => {
    const before = { 'run.json': 'old run', 'calls.jsonl': 'old calls', [join('blobs', BLOB_A)]: 'old blob', 'NOTES.md': 'notes' };
    const golden = pack(join(root, 'two', 'golden'), before);
    // The new pack lacks calls.jsonl: its blobs have moved in by the time that fails.
    const fresh = pack(join(root, 'two', 'new'), { 'run.json': 'new run', [`blobs/${BLOB_B}`]: 'new blob' });
    const aside = join(root, 'two', 'old');
    mkdirSync(aside);
    expect(() => swapPack(golden, fresh, aside)).toThrow(/ENOENT/);
    expect(contents(golden)).toEqual(before);
    expect(readdirSync(aside)).toEqual([]);
  });

  it('adds what an old pack never had, and takes it out again on a failure', () => {
    // An older pack without calls.jsonl (a recording with no calls).
    const golden = pack(join(root, 'three', 'golden'), { 'run.json': 'old run', 'README.md': 'readme' });
    mkdirSync(join(golden, 'blobs'));
    const fresh = pack(join(root, 'three', 'new'), { 'calls.jsonl': 'new calls', [`blobs/${BLOB_B}`]: 'new blob' });
    const aside = join(root, 'three', 'old');
    mkdirSync(aside);
    // No run.json in the new pack: the last entry fails, and everything before it is undone.
    expect(() => swapPack(golden, fresh, aside)).toThrow(/ENOENT/);
    expect(contents(golden)).toEqual({ 'run.json': 'old run', 'README.md': 'readme' });
    expect(readdirSync(golden).sort()).toEqual(['README.md', 'blobs', 'run.json']);
  });
});
