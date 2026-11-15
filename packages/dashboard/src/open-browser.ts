import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Opens the dashboard in the default browser without putting its link on a command line: the link
 * carries the session token, and a process's arguments are there for any user of the machine to
 * read (`ps`) while it runs. The browser is handed a file instead, in a folder of its own that only
 * its owner can read, which sends it on to the link; the folder goes a couple of minutes later, or
 * when the process exits, whichever comes first.
 */

export interface OpenOptions {
  /** How long the file is kept for the browser to read it, in milliseconds: two minutes unless given. */
  keepMs?: number;
}

const KEEP_MS = 120_000;

const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A page that goes on to `url` at once, leaving no step in the tab's history, and links to it should it not. */
export function redirectPage(url: string): string {
  // JSON keeps the address a string; `<` escaped keeps it inside its script element.
  const js = JSON.stringify(url).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="referrer" content="no-referrer">
<title>shadowlap</title>
<script>location.replace(${js});</script>
</head>
<body>
<a href="${attr(url)}">Open the shadowlap dashboard</a>
</body>
</html>
`;
}

/** Opens `url` in the default browser, through a file that only its owner can read. Resolves false when no opener is available. */
export async function openInBrowser(url: string, o: OpenOptions = {}): Promise<boolean> {
  let dir: string;
  let file: string;
  try {
    // A folder of its own (0700), and the file in it its owner's alone (0600).
    dir = mkdtempSync(join(tmpdir(), 'shadowlap-open-'));
    file = join(dir, 'dashboard.html');
    writeFileSync(file, redirectPage(url), { mode: 0o600, flag: 'wx' });
  } catch {
    return false;
  }
  let removed = false;
  const remove = () => {
    if (removed) return;
    removed = true;
    clearTimeout(timer);
    process.off('exit', remove);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // gone already
    }
  };
  // Long enough for a browser that is still starting to read it.
  const timer = setTimeout(remove, o.keepMs ?? KEEP_MS);
  timer.unref();
  process.once('exit', remove);
  const [cmd, args] = process.platform === 'darwin' ? ['open', [file]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', file]] : ['xdg-open', [file]];
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
      child.on('error', () => {
        remove();
        resolve(false);
      });
      child.on('spawn', () => {
        child.unref();
        resolve(true);
      });
    } catch {
      remove();
      resolve(false);
    }
  });
}
