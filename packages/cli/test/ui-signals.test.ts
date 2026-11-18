import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';

/**
 * `shadowlap ui` in a pseudo-terminal, as in a terminal window, stopped by a signal: SIGINT, SIGTERM
 * and SIGHUP each end it with the CLI's status for that signal (128 + n), the screen it opened on
 * put back and the terminal out of raw mode; so do a Ctrl-C typed while it asks the terminal its
 * colours, a stop with the dashboard open, which stops the dashboard first, and a closed window.
 */

const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const POSIX = process.platform !== 'win32';
const ENTER = '\x1b[?1049h';
/** The alternate screen left (`?1049l`), then the cursor shown: the last thing written. */
const LEFT = /\x1b\[\?1049l(?:\x1b\[\?25h)+$/;

function findPython(): string | null {
  if (!POSIX) return null;
  for (const cmd of ['python3', 'python']) {
    try {
      execFileSync(cmd, ['-c', 'import pty, select, termios'], { stdio: 'ignore' });
      return cmd;
    } catch {
      // next
    }
  }
  return null;
}
const python = findPython();

/**
 * Runs a command in a pseudo-terminal of `cols`×`rows`, and goes through `steps`: each waits for its
 * marker in what the terminal shows after the last step's, then types keys (`key:`), sends the
 * command a signal (`signal:`) or closes the terminal (`close`). The marker `cooked-after-raw` is the
 * moment the terminal leaves raw mode after it was in it: the colours asked and answered (or, when
 * this was too slow to see that moment, which lasts milliseconds, the UI drawn). With `answer`, it
 * answers the colours query as a dark terminal does. Prints what the terminal showed, how the
 * command ended, and the terminal's mode then.
 */
const HARNESS = `
import fcntl, json, os, pty, re, select, struct, sys, termios, time
spec = json.loads(sys.argv[1])
pid, fd = pty.fork()
if pid == 0:
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack('HHHH', spec['rows'], spec['cols'], 0, 0))
    os.execve(spec['argv'][0], spec['argv'], spec['env'])

# What the terminal shows, its colours left out: a marker is text on the screen, and a UI that colours
# its keys (as it does wherever colours are on, GitHub Actions among them) draws ESC[1mq ESC[22m quit.
SGR = re.compile(rb'\\x1b\\[[0-9;:]*m')
def shown(data):
    return SGR.sub(b'', data)

def mode():
    try:
        return 'cooked' if termios.tcgetattr(fd)[3] & termios.ICANON else 'raw'
    except termios.error:
        return None

out, pos, steps, was_raw, closed, status = b'', 0, list(spec['steps']), False, False, None
deadline = time.time() + spec['deadline']
while time.time() < deadline:
    if not closed and select.select([fd], [], [], 0.002)[0]:
        try:
            data = os.read(fd, 65536)
        except OSError:
            data = b''
        out += data
        if spec['answer'] and b'\\x1b]11;?' in data:
            os.write(fd, b'\\x1b]11;rgb:0000/0000/0000\\x1b\\\\\\x1b[?62;c')
    if not closed and mode() == 'raw':
        was_raw = True
    if steps:
        marker, action = steps[0]
        due = (was_raw and (mode() == 'cooked' or b'q quit' in shown(out))) if marker == 'cooked-after-raw' else marker.encode() in shown(out[pos:])
        if due:
            steps.pop(0)
            pos = len(out)
            if action == 'close':
                os.close(fd)
                closed = True
            elif action.startswith('signal:'):
                os.kill(pid, getattr(__import__('signal'), action[7:]))
            else:
                os.write(fd, action[4:].encode())
    done, st = os.waitpid(pid, os.WNOHANG)
    if done:
        status = st
        while not closed and select.select([fd], [], [], 0.2)[0]:
            try:
                data = os.read(fd, 65536)
            except OSError:
                break
            if not data:
                break
            out += data
        break
timed_out = status is None
if timed_out:
    os.kill(pid, 9)
    _, status = os.waitpid(pid, 0)
print(json.dumps({
    'code': os.WEXITSTATUS(status) if os.WIFEXITED(status) else None,
    'signal': os.WTERMSIG(status) if os.WIFSIGNALED(status) else None,
    'mode': None if closed else mode(),
    'timedOut': timed_out,
    'out': out.decode('utf-8', 'replace'),
}))
`;

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'sl-ui-signals-'));
  writeFileSync(join(dir, 'pty-ui.py'), HARNESS);
  // Copying a link, or opening a browser, does nothing here: the machine's clipboard and browser stay out of it.
  mkdirSync(join(dir, 'bin'));
  for (const name of ['pbcopy', 'xclip', 'xsel', 'wl-copy', 'open', 'xdg-open']) {
    writeFileSync(join(dir, 'bin', name), '#!/bin/sh\ncat > /dev/null\nexit 0\n');
    chmodSync(join(dir, 'bin', name), 0o755);
  }
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

interface Ended {
  /** The status a shell reports: the exit code, or 128 + n for signal n. */
  status: number;
  mode: 'cooked' | 'raw' | null;
  timedOut: boolean;
  out: string;
}

function ui(db: string, steps: Array<[string, string]>, o: { answer?: boolean; env?: NodeJS.ProcessEnv } = {}): Ended {
  const env: NodeJS.ProcessEnv = { ...process.env, SHADOWLAP_TELEMETRY: '0', SHADOWLAP_HOME: join(dir, 'home'), SHADOWLAP_UI_THEME: 'dark', CI: '1', PATH: `${join(dir, 'bin')}${delimiter}${process.env.PATH ?? ''}`, ...o.env };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
  const spec = { argv: [process.execPath, CLI, '--db', db, 'ui'], cols: 100, rows: 30, env, steps, answer: !!o.answer, deadline: 25 };
  const r = JSON.parse(execFileSync(python!, [join(dir, 'pty-ui.py'), JSON.stringify(spec)], { cwd: dir, timeout: 45_000, maxBuffer: 64 * 1024 * 1024 }).toString()) as { code: number | null; signal: number | null; mode: Ended['mode']; timedOut: boolean; out: string };
  return { status: r.code ?? 128 + r.signal!, mode: r.mode, timedOut: r.timedOut, out: r.out };
}

/** A store with one run, which the runs view lists and `o` opens. */
function storeWithRun(name: string): string {
  const db = join(dir, `${name}.db`);
  const store = Store.open(db);
  try {
    const run = store.createRun({ mode: 'record', command: { argv: ['node', 'agent.mjs'], cwd: dir } });
    store.endRun(run.runId, 'completed');
  } finally {
    store.close();
  }
  return db;
}

describe.skipIf(!python)('shadowlap ui and stop signals', { timeout: 60_000 }, () => {
  for (const [signal, status] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]] as const) {
    it(`ends on ${signal} with ${status}, the screen it opened on back and the terminal out of raw mode`, () => {
      const r = ui(join(dir, `${signal}.db`), [['q quit', `signal:${signal}`]]);
      expect(r.timedOut, r.out.slice(-300)).toBe(false);
      expect(r.status).toBe(status);
      expect(r.out.startsWith(ENTER) || r.out.includes(ENTER)).toBe(true);
      expect(r.out, JSON.stringify(r.out.slice(-160))).toMatch(LEFT);
      expect(r.mode).toBe('cooked');
    });
  }

  it('ends on a Ctrl-C typed as it takes the keyboard, after asking the terminal its colours', () => {
    // The terminal answered and is out of raw mode, the UI not in it yet: the terminal makes a Ctrl-C a SIGINT.
    // The colours are asked of a terminal of 256 colours or more, which Node takes no terminal under CI to be.
    const asks = { SHADOWLAP_UI_THEME: undefined, CI: undefined, TERM: 'xterm-256color', NO_COLOR: undefined, NODE_DISABLE_COLORS: undefined, FORCE_COLOR: undefined };
    const r = ui(join(dir, 'between.db'), [['cooked-after-raw', 'signal:SIGINT']], { answer: true, env: asks });
    expect(r.timedOut, r.out.slice(-300)).toBe(false);
    expect(r.status).toBe(130);
    if (r.out.includes(ENTER)) expect(r.out, JSON.stringify(r.out.slice(-160))).toMatch(LEFT);
    expect(r.mode).toBe('cooked');
  });

  it('ends on SIGTERM with the dashboard it opened running: the dashboard stops, and its signal ends the process', () => {
    const r = ui(storeWithRun('dashboard'), [
      ['q quit', 'key:o'],
      ['http://127.0.0.1', 'signal:SIGTERM'],
    ]);
    expect(r.timedOut, r.out.slice(-300)).toBe(false);
    expect(r.status).toBe(143);
    expect(r.out, JSON.stringify(r.out.slice(-160))).toMatch(LEFT);
    expect(r.mode).toBe('cooked');
  });

  it('ends when its terminal window closes, as the SIGHUP that brings it ends it', () => {
    const r = ui(join(dir, 'closed.db'), [['q quit', 'close']]);
    expect(r.timedOut).toBe(false);
    expect(r.status).toBe(129);
  });
});
