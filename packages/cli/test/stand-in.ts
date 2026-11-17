import { chmodSync, writeFileSync } from 'node:fs';

/**
 * Writes a stand-in, a Node script, for a program the user installs (Claude Code, say), started by
 * the name `path`: on Linux and macOS a file its #! line runs, on Windows a batch file beside the
 * script, as npm installs one there (`claude.cmd`), handing its arguments to node with %*.
 */
export function writeStandIn(path: string, script: string): void {
  if (process.platform === 'win32') {
    writeFileSync(`${path}.js`, script);
    writeFileSync(`${path}.cmd`, `@"${process.execPath}" "%~dp0${path.split(/[\\/]/).pop()!}.js" %*\r\n`);
    return;
  }
  writeFileSync(path, `#!/usr/bin/env node\n${script}`);
  chmodSync(path, 0o755);
}
