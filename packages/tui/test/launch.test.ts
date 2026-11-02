import { EventEmitter } from 'node:events';
import chalk from 'chalk';
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

/** A terminal of a real size that keeps everything written to it; with `answers`, one that answers the colours query as a dark terminal does. */
function terminal(columns = 100, rows = 30, o: { answers?: boolean } = {}) {
  let written = '';
  const stdin = new Keyboard();
  const stdout = Object.assign(new EventEmitter(), {
    columns,
    rows,
    isTTY: true,
    write(data: string | Uint8Array) {
      written += String(data);
      if (o.answers && String(data).includes('\x1b]11;?')) setImmediate(() => stdin.write('\x1b]11;rgb:0000/0000/0000\x1b\\\x1b[?62;c'));
      return true;
    },
  });
  const stderr = Object.assign(new EventEmitter(), { write: () => true });
  const io = { stdin, stdout, stderr } as unknown as TuiTerminal;
  return { io, stdin, written: () => written };
}

/**
 * Calls what the UI listens to `name` with, as the signal would: the listeners it added since `before`,
 * before it draws (once it has, Ink's exit hook is among them, which would signal this process).
 */
function signal(name: NodeJS.Signals, before: readonly NodeJS.SignalsListener[]): void {
  for (const listener of process.listeners(name)) if (!before.includes(listener)) listener(name);
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

describe('a stop signal as it starts', () => {
  // The colours are asked of the terminal only when nothing names the palette.
  const themeWas = process.env.SHADOWLAP_UI_THEME;
  beforeEach(() => {
    delete process.env.SHADOWLAP_UI_THEME;
  });
  afterEach(() => {
    if (themeWas === undefined) delete process.env.SHADOWLAP_UI_THEME;
    else process.env.SHADOWLAP_UI_THEME = themeWas;
  });

  it('ends on the SIGINT a Ctrl-C makes once the terminal answered, before the UI takes the keyboard, drawing nothing', async () => {
    const t = terminal(100, 30, { answers: true });
    const before = process.listeners('SIGINT');
    // The answer hands the keyboard back out of raw mode, where the terminal makes a Ctrl-C a SIGINT.
    const setRaw = t.stdin.setRawMode.bind(t.stdin);
    let typed = false;
    t.stdin.setRawMode = (raw: boolean) => {
      setRaw(raw);
      if (raw || typed) return;
      typed = true;
      signal('SIGINT', before);
    };
    await launchTui(store, {}, t.io);
    expect(t.written()).toContain('\x1b]11;?');
    expect(t.written()).not.toContain(ENTER);
    expect(t.stdin.isRaw).toBe(false);
    expect(process.listeners('SIGINT')).toEqual(before);
  });

  it('ends on SIGTERM while a terminal that never answers is asked, the keyboard out of the raw mode the question leaves it in', { timeout: 10_000 }, async () => {
    const t = terminal();
    const before = process.listeners('SIGTERM');
    const quit = launchTui(store, {}, t.io);
    await until(() => t.written().includes('\x1b]11;?'));
    signal('SIGTERM', before);
    // Once the question's wait for an answer is over.
    await quit;
    expect(t.written()).not.toContain(ENTER);
    expect(t.stdin.isRaw).toBe(false);
    expect(process.listeners('SIGTERM')).toEqual(before);
  });
});

describe('where you are, on the terminal it opens in', () => {
  const themeWas = process.env.SHADOWLAP_UI_THEME;
  // Ink colours through chalk, which draws nothing where the tests' output is no terminal.
  const level = chalk.level;
  beforeEach(() => {
    delete process.env.SHADOWLAP_UI_THEME;
    chalk.level = 3;
  });
  afterEach(() => {
    chalk.level = level;
    if (themeWas === undefined) delete process.env.SHADOWLAP_UI_THEME;
    else process.env.SHADOWLAP_UI_THEME = themeWas;
  });

  it('draws the selected row on the background the terminal answered with, ink mixed in as the dashboard mixes its own', async () => {
    const run = store.createRun({ mode: 'record', command: { argv: ['node', 'agent.js'], cwd: '.' } });
    store.endRun(run.runId, 'completed');
    const t = terminal(100, 30, { answers: true });
    const quit = launchTui(store, {}, t.io);
    const plain = () => t.written().replace(/\x1b\[[0-9;]*m/g, '');
    await until(() => plain().includes('q quit'));
    t.stdin.write('q');
    await quit;
    // Black, the background it answered with, with the dashboard's 8% of ink: not the ground of the dashboard's own page.
    expect(t.written()).toContain('\x1b[48;2;19;19;18m');
    expect(t.written()).not.toContain('48;2;29;30;27');
  });
});
