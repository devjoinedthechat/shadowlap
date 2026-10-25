import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startHost } from '../src/host.js';

/** startHost when the CLI it starts ends before it says where it listens. */
describe('startHost', () => {
  const dirs: string[] = [];
  const cli = process.env.SHADOWLAP_CLI;
  afterEach(() => {
    if (cli === undefined) delete process.env.SHADOWLAP_CLI;
    else process.env.SHADOWLAP_CLI = cli;
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const fakeCli = (source: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'sl-host-'));
    dirs.push(dir);
    const file = join(dir, 'cli.mjs');
    writeFileSync(file, source);
    process.env.SHADOWLAP_CLI = file;
    return dir;
  };

  it('says the exit code of a CLI that exits before it is ready', async () => {
    const dir = fakeCli('process.exit(3);\n');
    await expect(startHost(dir)).rejects.toThrow('shadowlap serve --recordings exited before it was ready (exit code 3)');
  });

  it.skipIf(process.platform === 'win32')('names the signal that ended one, which has no exit code', async () => {
    const dir = fakeCli("process.kill(process.pid, 'SIGKILL');\n");
    await expect(startHost(dir)).rejects.toThrow('shadowlap serve --recordings exited before it was ready (signal SIGKILL)');
  });
});
