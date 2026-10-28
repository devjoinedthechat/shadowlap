import { EventEmitter } from 'node:events';
import { render as inkRender } from 'ink';
import type { ReactElement } from 'react';

/** A TTY's stdin that keys are written to, as ink-testing-library's. */
class Keyboard extends EventEmitter {
  isTTY = true;
  private data: string | null = null;
  setEncoding() {}
  setRawMode() {}
  resume() {}
  pause() {}
  ref() {}
  unref() {}
  read(): string | null {
    const d = this.data;
    this.data = null;
    return d;
  }
  write(data: string) {
    this.data = data;
    this.emit('readable');
    this.emit('data', data);
  }
}

/**
 * Renders into a terminal of a real size. ink-testing-library's stdout is 100 columns whatever the
 * app is told, and Ink lays its root out at stdout's width, so a test at 80 or 140 columns ran at
 * 100: it never saw a row overflow at 80. Same shape as ink-testing-library's render.
 */
export function renderAt(tree: ReactElement, columns = 100, rows = 30) {
  let last: string | undefined;
  const stdout = Object.assign(new EventEmitter(), {
    columns,
    rows,
    isTTY: true,
    write(frame: string) {
      last = frame;
      return true;
    },
  });
  const stderr = Object.assign(new EventEmitter(), { write: () => true });
  const stdin = new Keyboard();
  const instance = inkRender(tree, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  return { lastFrame: () => last, stdin, unmount: () => instance.unmount(), rerender: instance.rerender };
}
