import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store, storeView } from '@shadowlap/engine';
import { launchTui, type TuiTerminal } from '../src/index.js';
import { Keyboard } from './terminal.js';

/**
 * What `shadowlap ui` leaves on the terminal when it ends: the screen it started from, with the
 * cursor shown and the keyboard out of raw mode, however it ends: `q`, Ctrl-C, or an error.
 */

/** Switches to the alternate screen. */
const ENTER = '\x1b[?1049h';
/** Leaves it (`?1049l`), the screen before it back, then shows the cursor (`?25h`): the last thing written. */
const LEFT = /\x1b\[\?1049l(?:\x1b\[\?25h)+$/;

/** A terminal of a real size that keeps everything written to it. */
function terminal(columns = 100, rows = 30) {
  let written = '';
  const stdout = Object.assign(new EventEmitter(), {
    columns,
    rows,
    isTTY: true,
    write(data: string | Uint8Array) {
      written += String(data);
      return true;
    },
  });
  const stderr = Object.assign(new EventEmitter(), { write: () => true });
  const stdin = new Keyboard();
  const io = { stdin, stdout, stderr } as unknown as TuiTerminal;
  return { io, stdin, written: () => written };
}

async function until(ok: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** The end of what was written, its escapes readable, for a failure's message. */
const tail = (written: string) => JSON.stringify(written.slice(-160));

/** Whether what was written begins on the alternate screen and ends by leaving it, with nothing after but the cursor shown. */
const leftClean = (written: string) => written.startsWith(ENTER) && LEFT.test(written);

let store: Store;
beforeEach(() => {
  store = Store.open(':memory:');
});
afterEach(() => {
  store.close();
});

describe('the screen shadowlap ui leaves', () => {
  it('draws on the alternate screen, and puts back the one it started from when q quits it', async () => {
    const t = terminal();
    const quit = launchTui(store, { theme: 'dark' }, t.io);
    await until(() => t.written().includes('q quit'));
    t.stdin.write('q');
    await quit;
    expect(leftClean(t.written()), tail(t.written())).toBe(true);
    expect(t.stdin.isRaw).toBe(false);
  });

  it('puts the screen back on Ctrl-C', async () => {
    const t = terminal();
    const quit = launchTui(store, { theme: 'dark' }, t.io);
    await until(() => t.written().includes('q quit'));
    t.stdin.write('\x03');
    await quit;
    expect(leftClean(t.written()), tail(t.written())).toBe(true);
    expect(t.stdin.isRaw).toBe(false);
  });

  it('puts the screen back before an error nothing caught is printed, as the process ends on it', async () => {
    const t = terminal();
    const quit = launchTui(store, { theme: 'dark' }, t.io);
    await until(() => t.written().includes('q quit'));
    // What Node tells before the handler that prints the error runs; the error itself would end this test's worker.
    for (const tell of process.listeners('uncaughtExceptionMonitor')) tell(new Error('a key handler failed'), 'uncaughtException');
    expect(leftClean(t.written()), tail(t.written())).toBe(true);
    await quit;
    expect(t.stdin.isRaw).toBe(false);
    expect(process.listenerCount('uncaughtExceptionMonitor')).toBe(0);
  });

  it('puts the screen back when it ends on an error, which it then throws for the CLI to print', async () => {
    const t = terminal();
    // A store that can't be read: the runs view fails as it draws.
    const broken = storeView(store, {
      listRuns: () => {
        throw new Error('the store could not be read');
      },
    });
    await expect(launchTui(broken, { theme: 'dark' }, t.io)).rejects.toThrow('the store could not be read');
    expect(leftClean(t.written()), tail(t.written())).toBe(true);
    expect(t.stdin.isRaw).toBe(false);
  });
});
