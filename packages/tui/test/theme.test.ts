import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { normalizeConversation, Store, unpackRun } from '@shadowlap/engine';
import { conversationAt, modelAction } from '../src/data.js';
import { conversationLines, fitColumns, RESULT_LINES, sharedPrefix } from '../src/render.js';
import { detectTheme, themeFromColorFgBg, themeFromEnv, themeFromOsc11 } from '../src/terminal-theme.js';
import { THEMES } from '../src/theme.js';

const GOLDEN = fileURLToPath(new URL('../../../testing/golden/reference-agent/', import.meta.url));

/** A terminal that answers the background query with `reply`, or never answers. */
function terminal(reply: string | null, depth = 24) {
  const written: string[] = [];
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    isRaw: false,
    setRawMode(on: boolean) {
      this.isRaw = on;
      return this;
    },
    resume() {},
    pause() {},
  });
  const stdout = {
    isTTY: true,
    getColorDepth: () => depth,
    write(s: string) {
      written.push(s);
      if (reply !== null) setImmediate(() => stdin.emit('data', Buffer.from(reply)));
      return true;
    },
  };
  return { stdin: stdin as unknown as NodeJS.ReadStream & { isRaw: boolean }, stdout: stdout as unknown as NodeJS.WriteStream, written, raw: stdin };
}

describe('which palette suits the terminal', () => {
  it('reads a background colour, in any channel width, as dark or light by its luminance', () => {
    expect(themeFromOsc11('\x1b]11;rgb:ffff/ffff/ffff\x1b\\')).toBe('light');
    expect(themeFromOsc11('\x1b]11;rgb:1e1e/1e1e/1e1e\x07')).toBe('dark');
    expect(themeFromOsc11('\x1b]11;rgb:fd/f6/e3\x07')).toBe('light'); // Solarized Light
    expect(themeFromOsc11('\x1b]11;rgb:0/2/3\x07')).toBe('dark');
    expect(themeFromOsc11('\x1b]11;#282c34\x07')).toBe('dark');
    // Mid grey either side of where black and white text stand out equally.
    expect(themeFromOsc11('\x1b]11;rgb:8080/8080/8080\x07')).toBe('light');
    expect(themeFromOsc11('\x1b]11;rgb:6060/6060/6060\x07')).toBe('dark');
    expect(themeFromOsc11('nothing')).toBeNull();
  });

  it('reads COLORFGBG and SHADOWLAP_UI_THEME', () => {
    expect(themeFromColorFgBg('15;0')).toBe('dark');
    expect(themeFromColorFgBg('0;15')).toBe('light');
    expect(themeFromColorFgBg('0;7')).toBe('light');
    expect(themeFromColorFgBg('15;default;0')).toBe('dark');
    expect(themeFromColorFgBg('default;default')).toBeNull();
    expect(themeFromColorFgBg(undefined)).toBeNull();
    expect(themeFromEnv({ SHADOWLAP_UI_THEME: 'Light' })).toBe('light');
    expect(themeFromEnv({ SHADOWLAP_UI_THEME: 'solarized' })).toBeNull();
  });

  it('asks the terminal, and stops listening the moment its device attributes answer', async () => {
    const t = terminal('\x1b]11;rgb:ffff/ffff/ffff\x1b\\\x1b[?62;22c');
    expect(await detectTheme({ env: {}, stdin: t.stdin, stdout: t.stdout, timeoutMs: 2000 })).toBe('light');
    // The background, then the attributes every terminal answers, so no answer is left to arrive as keys.
    expect(t.written).toEqual(['\x1b]11;?\x1b\\\x1b[c']);
    expect(t.raw.listenerCount('data')).toBe(0);
    expect(t.stdin.isRaw).toBe(false);

    const dark = terminal('\x1b]11;rgb:1e1e/1e1e/1e1e\x07\x1b[?1;2c');
    expect(await detectTheme({ env: {}, stdin: dark.stdin, stdout: dark.stdout })).toBe('dark');
  });

  it('falls back to COLORFGBG, then to the terminal’s own colours', async () => {
    // Answers the attributes only: it doesn't report its background.
    const quiet = terminal('\x1b[?62;22c');
    expect(await detectTheme({ env: { COLORFGBG: '0;15' }, stdin: quiet.stdin, stdout: quiet.stdout })).toBe('light');
    const silent = terminal(null);
    const started = Date.now();
    expect(await detectTheme({ env: {}, stdin: silent.stdin, stdout: silent.stdout, timeoutMs: 50 })).toBe('ansi');
    expect(Date.now() - started).toBeLessThan(1000);
    expect(silent.raw.listenerCount('data')).toBe(0);
  });

  it('asks nothing when told which, or when the terminal has too few colours for the brand palette', async () => {
    const told = terminal(null);
    expect(await detectTheme({ env: { SHADOWLAP_UI_THEME: 'dark' }, stdin: told.stdin, stdout: told.stdout })).toBe('dark');
    const sixteen = terminal(null, 4);
    expect(await detectTheme({ env: {}, stdin: sixteen.stdin, stdout: sixteen.stdout })).toBe('ansi');
    expect([...told.written, ...sixteen.written]).toEqual([]);
  });

  it('never draws text in white or black, which vanish on one background or the other', () => {
    for (const theme of Object.values(THEMES)) {
      const text = [theme.accent, theme.dim, theme.faint, theme.ok, theme.warn, theme.err, ...Object.values(theme.origin)];
      for (const c of text) expect(c ?? '', theme.name).not.toMatch(/^(white|black|#fff(fff)?|#000(000)?)$/i);
      expect(theme.origin.live, theme.name).toBeUndefined(); // the terminal's own foreground
    }
  });
});

describe('column widths', () => {
  it('drops the least telling columns first, never the ones without a drop, and widens in order', () => {
    const cols = [
      { key: 'mark', min: 2 },
      { key: 'id', min: 12 },
      { key: 'cost', min: 9, drop: 3 },
      { key: 'calls', min: 10, drop: 2 },
      { key: 'labels', min: 8, max: 20, drop: 1 },
      { key: 'command', min: 0, max: Number.POSITIVE_INFINITY },
    ] as const;
    expect(fitColumns(cols, 80)).toEqual({ mark: 2, id: 12, cost: 9, calls: 10, labels: 20, command: 27 });
    expect(fitColumns(cols, 40)).toEqual({ mark: 2, id: 12, cost: 0, calls: 10, labels: 16, command: 0 });
    expect(fitColumns(cols, 20)).toEqual({ mark: 2, id: 12, cost: 0, calls: 0, labels: 0, command: 6 });
    // Even when what can't go doesn't fit, nothing is negative.
    expect(Object.values(fitColumns(cols, 5)).every((w) => w >= 0)).toBe(true);
  });

  it('finds the part of the ids every run shares', () => {
    expect(sharedPrefix(['01M61KP1KC', '01M61KP1KD', '01M61KP1KE'])).toBe(9);
    expect(sharedPrefix(['01M4Y6TKYX', '01M61KP1KC'])).toBe(3);
    expect(sharedPrefix(['01M4Y6TKYX'])).toBe(0);
  });
});

describe('what a call shows', () => {
  it('names a model call by the tools it called, what it said, or how it failed', () => {
    const store = Store.open(':memory:');
    const runId = unpackRun(store, GOLDEN).imported[0];
    const calls = store.getCalls(runId);
    const models = calls.filter((c) => c.kind === 'api');
    expect(modelAction(store, models[0]).text).toBe('-> search_web, read_file');
    const last = models.at(-1)!;
    expect(modelAction(store, last).text).toMatch(/^(".+"|-> \w+)/);
    const failed = { ...last, end: { ...last.end!, outcome: 'error' as const, meta: { ...last.end!.meta, status: 529 } } };
    expect(modelAction(store, failed)).toEqual({ text: 'HTTP 529', tone: 'err' });
    expect(modelAction(store, { ...last, end: null }).text).toBe('…');
    store.close();
  });

  it('marks the turns a request added since the model call before it', () => {
    const store = Store.open(':memory:');
    const runId = unpackRun(store, GOLDEN).imported[0];
    const calls = store.getCalls(runId);
    const first = conversationAt(store, calls, calls.findIndex((c) => c.kind === 'api'))!;
    expect(first.freshFrom).toBeUndefined(); // the first model call: all of it is what it has
    const at9 = conversationAt(store, calls, calls.findIndex((c) => c.callNo === 9))!;
    expect(at9.freshFrom).toBeGreaterThan(0);
    expect(at9.freshFrom).toBeLessThan(at9.turns.length);
    const lines = conversationLines(at9.turns, 60, at9.freshFrom);
    expect(lines.filter((l) => l.head && l.fresh).map((l) => l.text)).toEqual(at9.turns.slice(at9.freshFrom).map((t, i) => `${t.role}  #${at9.freshFrom! + i}`));
    store.close();
  });

  it('lays out a tool result that is JSON as JSON, and stops a long one', () => {
    const text = (content: string) =>
      conversationLines(normalizeConversation({ model: 'm', messages: [{ role: 'user', content: 'go' }, { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'search', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content }] }] })!.turns, 60).map((l) => l.text);
    const short = text('{"results":[{"title":"shadowlap replay #1","url":"https://example.com/1"}]}');
    expect(short).toContain('↳ result:');
    expect(short).toContain('      "title": "shadowlap replay #1",');
    const long = text(JSON.stringify({ rows: Array.from({ length: 40 }, (_, i) => i) }));
    // The head, then 44 lines of JSON: the first RESULT_LINES shown, the rest counted.
    expect(long).toContain(`… ${45 - RESULT_LINES} more lines in the request tab`);
  });
});
