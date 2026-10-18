import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';

/**
 * Commands share a store and wait for each other's writes (the busy timeout) rather than fail. A
 * transaction that reads before it writes, as unpack and a pull do, waits too.
 */

describe('Store.transaction', () => {
  it('waits for another process holding the write lock when it reads before it writes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sl-locks-'));
    try {
      const path = join(dir, 'shadowlap.db');
      const marker = join(dir, 'holding');
      Store.open(path).close();
      const store = Store.open(path);
      const engine = fileURLToPath(new URL('../dist/index.js', import.meta.url));
      // Another command writes for half a second: a recording's call, a second test's unpack.
      const holder = `
        const { Store } = await import(${JSON.stringify('file://' + engine)});
        const { writeFileSync } = await import('node:fs');
        const s = Store.open(${JSON.stringify(path)});
        s.transaction(() => { s.putJson({ holder: true }); writeFileSync(${JSON.stringify(marker)}, '1'); const t = Date.now(); while (Date.now() - t < 500) {} }, 'immediate');
        s.close();`;
      const child = spawn(process.execPath, ['--input-type=module', '-e', holder], { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      child.stderr.on('data', (d: Buffer) => (err += d.toString()));
      const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
      let gone = false;
      void exited.then(() => (gone = true));
      while (!existsSync(marker) && !gone) await new Promise((r) => setTimeout(r, 5));
      expect(err).toBe('');
      const wrote = store.transaction(() => {
        store.hasBlob('0'.repeat(64)); // a read first, as unpack's and a pull's do
        return store.putJson({ mine: true });
      });
      expect(store.getJson(wrote)).toEqual({ mine: true });
      expect(await exited).toBe(0);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
