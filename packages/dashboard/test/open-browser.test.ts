import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { openInBrowser, redirectPage, startDashboard } from '../src/index.js';

/**
 * `shadowlap dashboard` opens its link, which carries the session token, in the browser. A process's
 * arguments are there for any user of the machine to read while it runs (`ps`), so the opener is
 * handed a file that only its owner can read, which goes on to the link, and the file goes soon
 * after. The server listens on the port asked for, or on one the system picks for port 0, and says
 * which.
 */

const TOKEN = 'k3pT0kenThatMustNotLeakIntoArgv_0123456789';
const LINK = `http://127.0.0.1:4777/#token=${TOKEN}&open=/run/01K4ZQ8D2M6V7N9P3R5T7W9X1Y/call/3`;

describe('the page that goes on to the link', () => {
  it('goes there at once, in a script and in a link, with the address kept whole', () => {
    const page = redirectPage(LINK);
    expect(page).toContain(`location.replace(${JSON.stringify(LINK)})`);
    expect(page).toContain(`href="${LINK.replace(/&/g, '&amp;')}"`);
    expect(page).toContain('<meta name="referrer" content="no-referrer">');
    // An address can't end the script early.
    expect(redirectPage('http://127.0.0.1/#</script><b>')).not.toMatch(/<\/script><b>/);
  });
});

// The stand-in for the system's opener is a shell script, which Windows won't run by name.
describe.skipIf(process.platform === 'win32')('opening the dashboard', () => {
  let bin: string;
  let path: string | undefined;
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';

  beforeAll(() => {
    // An opener that notes what it was given, and the file it was handed as it was then. Each note
    // is written whole and then moved into place, so the test never reads one half written.
    bin = mkdtempSync(join(tmpdir(), 'sl-opener-'));
    const at = (name: string) => `"${join(bin, name)}"`;
    writeFileSync(
      join(bin, opener),
      [
        '#!/bin/sh',
        `printf '%s\\n' "$@" > ${at('argv.part')} && mv ${at('argv.part')} ${at('argv')}`,
        '[ -e "$1" ] || exit 0',
        `cp "$1" ${at('seen.html')}`,
        'mode=$(stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1")',
        `printf '%s\\n' "$mode" > ${at('mode.part')} && mv ${at('mode.part')} ${at('mode')}`,
        '',
      ].join('\n'),
    );
    chmodSync(join(bin, opener), 0o755);
    path = process.env.PATH;
    process.env.PATH = `${bin}${delimiter}${process.env.PATH}`;
  });

  afterAll(() => {
    process.env.PATH = path;
    rmSync(bin, { recursive: true, force: true });
  });

  /** Until `done` holds, or `ms` have passed (a machine busy with other work starts the opener late). */
  const until = async (done: () => boolean, ms = 20_000) => {
    for (const end = Date.now() + ms; !done() && Date.now() < end; ) await new Promise((r) => setTimeout(r, 20));
  };

  it('hands the opener a file its owner alone can read, never the link with its token', async () => {
    rmSync(join(bin, 'mode'), { force: true });
    expect(await openInBrowser(LINK, { keepMs: 60_000 })).toBe(true);
    await until(() => existsSync(join(bin, 'mode')));
    const argv = readFileSync(join(bin, 'argv'), 'utf8').trim().split('\n');
    expect(argv).toHaveLength(1);
    expect(argv[0]).toMatch(/dashboard\.html$/);
    expect(argv.join(' ')).not.toContain(TOKEN);
    expect(readFileSync(join(bin, 'mode'), 'utf8').trim()).toBe('600');
    // The file sends the browser on to the link, token and all.
    expect(readFileSync(join(bin, 'seen.html'), 'utf8')).toContain(JSON.stringify(LINK));
  });

  it('removes the file once the browser has had time to read it', async () => {
    rmSync(join(bin, 'argv'), { force: true });
    expect(await openInBrowser(LINK, { keepMs: 300 })).toBe(true);
    await until(() => existsSync(join(bin, 'argv')));
    const file = readFileSync(join(bin, 'argv'), 'utf8').trim();
    await until(() => !existsSync(file), 10_000);
    expect(existsSync(file)).toBe(false);
  });
});

describe('the port it listens on', () => {
  it('takes one the system picks for port 0, and says which', async () => {
    const store = Store.open(':memory:');
    const dash = await startDashboard({ store, port: 0 });
    try {
      expect(dash.port).toBeGreaterThan(0);
      expect(dash.url).toBe(`http://127.0.0.1:${dash.port}`);
      expect(dash.openUrl.startsWith(`http://127.0.0.1:${dash.port}/#token=`)).toBe(true);
      const res = await fetch(`${dash.url}/api/meta`, { headers: { 'x-shadowlap-token': dash.token } });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { address: string }).address).toBe(`127.0.0.1:${dash.port}`);
    } finally {
      await dash.close();
      store.close();
    }
  });
});
