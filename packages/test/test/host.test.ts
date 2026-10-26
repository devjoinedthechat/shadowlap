import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { cliPath, startHost } from '../src/host.js';

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

  it("runs the command the CLI package's manifest names, the one way into it its exports leave", () => {
    delete process.env.SHADOWLAP_CLI;
    expect(cliPath()).toBe(fileURLToPath(new URL('../../cli/bin/shadowlap.js', import.meta.url)));
    expect(() => createRequire(import.meta.url).resolve('shadowlap/bin/shadowlap.js')).toThrow(/not defined by "exports"/);
  });

  it('says the exit code of a CLI that exits before it is ready', async () => {
    const dir = fakeCli('process.exit(3);\n');
    await expect(startHost(dir)).rejects.toThrow('shadowlap serve --recordings exited before it was ready (exit code 3)');
  });

  it.skipIf(process.platform === 'win32')('names the signal that ended one, which has no exit code', async () => {
    const dir = fakeCli("process.kill(process.pid, 'SIGKILL');\n");
    await expect(startHost(dir)).rejects.toThrow('shadowlap serve --recordings exited before it was ready (signal SIGKILL)');
  });
});
