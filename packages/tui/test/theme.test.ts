import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import { createElement } from 'react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { normalizeConversation, Store, unpackRun, type CallRecord, type Effect, type Origin, type StoredCheck } from '@shadowlap/engine';
import { App } from '../src/app.js';
import { FixJobView } from '../src/components/FixJobView.js';
import { conversationAt, freshSince, modelAction } from '../src/data.js';
import { conversationLines, fitColumns, RESULT_LINES, sharedPrefix } from '../src/render.js';
import { backgroundFromOsc11, detectTerminal, detectTheme, queryTerminal, queryTimeout, themeFromColorFgBg, themeFromEnv, themeFromOsc11 } from '../src/terminal-theme.js';
import { mixColours, themeFor, THEMES, type Theme } from '../src/theme.js';
import { contrast, painted, token } from './colours.js';
import { renderAt } from './terminal.js';

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
      for (const c of textColours(theme)) expect(c, theme.name).not.toMatch(/^(white|black|#fff(fff)?|#000(000)?)$/i);
    }
    // A live call in the dashboard's live colour on a dark background; else the terminal's own foreground.
    expect(THEMES.light.origin.live).toBeUndefined();
    expect(THEMES.ansi.origin.live).toBeUndefined();
  });

  it('keeps the background the terminal reports, which the selection ground is mixed from', async () => {
    expect(backgroundFromOsc11('\x1b]11;rgb:1e1e/1e1e/1e1e\x07')).toBe('#1e1e1e');
    expect(backgroundFromOsc11('\x1b]11;rgb:fd/f6/e3\x07')).toBe('#fdf6e3');
    expect(backgroundFromOsc11('\x1b]11;#282c34\x07')).toBe('#282c34');
    expect(backgroundFromOsc11('nothing')).toBeNull();
    const t = terminal('\x1b]11;rgb:2828/2c2c/3434\x1b\\\x1b[?62;22c');
    expect(await detectTerminal({ env: {}, stdin: t.stdin, stdout: t.stdout })).toEqual({ theme: 'dark', background: '#282c34' });
    // Told which palette, or read from COLORFGBG: no background to mix from.
    const quiet = terminal('\x1b[?62;22c');
    expect(await detectTerminal({ env: { COLORFGBG: '0;15' }, stdin: quiet.stdin, stdout: quiet.stdout })).toEqual({ theme: 'light', background: null });
  });
});

/** Every colour a palette sets text in: secondary and quiet text, the consequence colours, a write's and the origins. */
function textColours(t: Theme): string[] {
  return [t.dim, t.faint, t.ok, t.warn, t.err, t.write, ...Object.values(t.origin)].filter((c): c is string => c !== undefined);
}

describe('each colour means what the dashboard means by it', () => {
  it('draws the dark palette in the dashboard’s own colours, read from its tokens', () => {
    const d = THEMES.dark;
    // The wordmark on the brand's lime; where you are on the dashboard's selection ground; quieter text.
    expect([d.brand, d.onBrand, d.selection, d.dim, d.faint]).toEqual(['--lime', '--tar', '--sel', '--dim', '--faint'].map(token));
    // The consequence colours, for verdicts: passed lime, a look or inconclusive amber, failed red, the same or not applicable muted.
    expect([d.ok, d.warn, d.err, d.faint]).toEqual(['--cq-lime', '--cq-amber', '--cq-red', '--cq-muted'].map(token));
    // Where a call's answer came from, a failed call in the one red. Injected is overridden, quieter: mixed
    // into the page as the dashboard's swatch is, at 80%, since the swatch's 55% is too faint for a word.
    expect(d.origin).toEqual({ live: token('--o-live'), replayed: token('--o-rep'), blocked: token('--o-block'), stubbed: token('--o-stub'), overridden: token('--o-over'), injected: mixColours(token('--o-over'), token('--bg'), 0.8) });
    expect(d.err).toBe(token('--o-fail'));
    expect(contrast(d.origin.injected, token('--bg'))).toBeLessThan(contrast(d.origin.overridden, token('--bg')));
    // A write in the colour the dashboard says what a call was in, never the failure red.
    expect(d.write).toBe(token('--k-write'));
  });

  it('reads every colour at 4.5:1: the dark palette on the dashboard’s page and selection ground, the light one on white and its own', () => {
    const on: Array<[Theme, string[]]> = [
      [THEMES.dark, [token('--bg'), THEMES.dark.selection!]],
      [THEMES.light, ['#ffffff', THEMES.light.selection!]],
    ];
    for (const [theme, grounds] of on) for (const c of textColours(theme)) for (const g of grounds) expect(contrast(c, g), `${theme.name}: ${c} on ${g}`).toBeGreaterThanOrEqual(4.5);
  });

  it('never gives two meanings one colour, replayed and passed above all, and the sixteen colours by their names', () => {
    for (const t of Object.values(THEMES)) {
      const signals = { passed: t.ok, amber: t.warn, red: t.err, write: t.write, replayed: t.origin.replayed, stubbed: t.origin.stubbed, overridden: t.origin.overridden, injected: t.origin.injected };
      expect(new Set(Object.values(signals)).size, `${t.name}: ${JSON.stringify(signals)}`).toBe(Object.keys(signals).length);
      // Nor is any the grey of quieter text, which a blocked write is drawn in, as the dashboard's --o-block is its --dim.
      for (const [meaning, c] of Object.entries(signals)) expect([t.dim, t.faint], `${t.name}: ${meaning}`).not.toContain(c);
      expect(t.origin.blocked, t.name).toBe(t.dim);
    }
    expect(THEMES.ansi).toMatchObject({ ok: 'greenBright', origin: { replayed: 'green' } });
  });

  it('keeps lime, in every palette, for what passed and the wordmark: where you are, a fork and an origin take none', () => {
    for (const t of Object.values(THEMES)) {
      const lime = new Set([t.ok, t.brand]);
      const rest = { selection: t.selection, dim: t.dim, faint: t.faint, warn: t.warn, err: t.err, write: t.write, ...t.origin };
      expect(Object.entries(rest).filter(([, c]) => c !== undefined && lime.has(c)), t.name).toEqual([]);
    }
  });

  it('mixes the selection ground from the background the terminal reports, as the dashboard’s --sel is its page with ink in it', () => {
    // On the dashboard's own page, the dashboard's own ground.
    expect(themeFor('dark', token('--bg')).selection).toBe(token('--sel'));
    // On a background the fixed ground would vanish into, a step lighter than it.
    const vscode = themeFor('dark', '#1e1e1e').selection!;
    expect(contrast(vscode, '#1e1e1e')).toBeGreaterThan(1.15);
    expect(contrast(themeFor('light', '#fdf6e3').selection!, '#fdf6e3')).toBeGreaterThan(1.15);
    expect(themeFor('light', '#ffffff').selection).toBe(THEMES.light.selection);
    // Unknown, or the sixteen colours: the palette as it is.
    expect(themeFor('dark', null)).toBe(THEMES.dark);
    expect(themeFor('ansi', '#000000')).toBe(THEMES.ansi);
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

describe('what the review of the rework found, without a terminal', () => {
  it('marks new only the turns after a conversation this one carries on, not after a side call', () => {
    const t = (role: 'user' | 'assistant', text: string) => ({ role, blocks: [{ type: 'text' as const, text }] });
    const main = [t('user', 'refund order 7'), t('assistant', 'looking')];
    const side = [t('user', 'title this chat'), t('assistant', 'Refund')];
    const turns = [...main, t('user', 'tool result'), t('assistant', 'done')];
    // The title call came last, but the agent's conversation goes on from the main one.
    expect(freshSince([side, main], turns)).toBe(2);
    expect(freshSince([side], turns)).toBeUndefined();
    expect(freshSince([main.slice(0, 1), main], turns)).toBe(2); // the longest that fits
  });

  it('stays in raw mode when the terminal never answers, waits longer over SSH, and lets Ctrl-C through', async () => {
    const silent = terminal(null);
    expect(await queryTerminal(silent.stdin, silent.stdout, 30)).toBeNull();
    // An answer that comes later is never echoed: the UI takes raw mode over from here.
    expect(silent.stdin.isRaw).toBe(true);
    expect(queryTimeout({})).toBe(1000);
    expect(queryTimeout({ SSH_CONNECTION: '10.0.0.2 51000 10.0.0.1 22' })).toBe(3000);
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      const stopped = terminal('\x03');
      await queryTerminal(stopped.stdin, stopped.stdout, 2000);
      expect(kill).toHaveBeenCalledWith(process.pid, 'SIGINT');
    } finally {
      kill.mockRestore();
    }
  });
});

/** A recording whose check passed, a clean replay of it, and a fork made at #3 on purpose. */
function colourStore() {
  const s = Store.open(':memory:');
  const recording = unpackRun(s, GOLDEN).imported[0];
  s.updateRunMeta(recording, { checks: [{ status: 'passed', ok: true, label: 'answers', detail: null }] });
  const parent = s.getCalls(recording);
  const copy = (runId: string, liveFrom?: number) => {
    for (const c of parent) {
      const { end, attempts, ...start } = c;
      void attempts;
      s.appendCallStart({ ...start, runId, origin: liveFrom && c.callNo >= liveFrom ? 'live' : 'replayed' });
      if (end) s.appendCallEnd(c, { ...end, runId });
    }
  };
  const clean = s.createRun({ mode: 'replay', parentRunId: recording, command: { argv: ['node', 'agent.js'], cwd: '.' } });
  copy(clean.runId);
  s.endRun(clean.runId, 'completed');
  const fork = s.createRun({ mode: 'replay', parentRunId: recording, command: { argv: ['node', 'agent.js'], cwd: '.' } });
  copy(fork.runId, 3);
  s.setDivergence(fork.runId, { type: 'forced', callNo: 3, kind: 'api', name: 'POST /v1/messages', replayedBefore: 2, reason: 'forced live by --diverge-at 3' });
  s.endRun(fork.runId, 'completed');
  return { store: s, recording, fork: fork.runId };
}

/** A copy of the recording's calls into a run of its own, each served as `origin` says, and how each ended as `end` says. */
function copyCalls(s: Store, parent: readonly CallRecord[], runId: string, origin: (c: CallRecord) => Origin = () => 'replayed', end: (c: CallRecord) => Partial<NonNullable<CallRecord['end']>> = () => ({})) {
  for (const c of parent) {
    const { end: ended, attempts, ...start } = c;
    void attempts;
    s.appendCallStart({ ...start, runId, origin: origin(c) });
    if (ended) s.appendCallEnd(c, { ...ended, ...end(c), runId });
  }
}

/**
 * Replays of the recording, as the runs list says how each stands: one stopped short (`crashed`),
 * one its recorder left running (interrupted), one recording now, one whose second check did not
 * apply and one none of whose checks did.
 */
function statusStore() {
  const s = Store.open(':memory:');
  const recording = unpackRun(s, GOLDEN).imported[0];
  const parent = s.getCalls(recording);
  const replay = (checks?: StoredCheck[]) => {
    const run = s.createRun({ mode: 'replay', parentRunId: recording, command: { argv: ['node', 'agent.js'], cwd: '.' }, ...(checks ? { meta: { checks } } : {}) });
    copyCalls(s, parent, run.runId);
    return run.runId;
  };
  const crashed = replay();
  s.endRun(crashed, 'crashed');
  const notApplicable = { status: 'not-applicable', ok: true, label: 'refunds under the limit', detail: null } as const;
  const partly = replay([{ status: 'passed', ok: true, label: 'answers', detail: null }, notApplicable]);
  s.endRun(partly, 'completed');
  s.endRun(replay([notApplicable]), 'completed');
  // A process that has ended holds it: its recorder went away.
  const left = replay();
  const db = (s as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): unknown } } }).db;
  db.prepare('UPDATE run_owners SET pid = ? WHERE run_id = ?').run(spawnSync(process.execPath, ['-e', '0']).pid, left);
  replay();
  return { store: s, crashed, partly };
}

const BLOCKED = { name: 'ShadowlapWriteBlocked', message: 'write tool send_email blocked after divergence (use --writes stub|allow to change this)' };

/** A tool call that `runId` makes at `callNo`, served as `origin` says, and how it ended. */
function toolCall(s: Store, runId: string, callNo: number, name: string, effect: Effect, origin: Origin, outcome: 'ok' | 'error') {
  const start = { runId, callNo, kind: 'tool' as const, name, fingerprint: `${name}:${callNo}`, occurrence: 0, origin, effect, requestRef: s.putJson({ args: { order: callNo } }), meta: {}, at: Date.now() };
  s.appendCallStart(start);
  s.appendCallEnd(start, { runId, callNo, attempt: 0, responseRef: null, outcome, meta: outcome === 'error' ? { error: { name: 'Error', message: `${name} failed` } } : {}, at: Date.now() });
}

/**
 * Forks of the recording made at #28, the model call before its one write (send_email at #29), which
 * replay blocks after a fork, recording the fence as an error: one that did nothing else, and one
 * that went on to write more, each write with a fate of its own (stubbed, failed, run live,
 * overridden), and to hand over to a person.
 */
function fenceStore() {
  const s = Store.open(':memory:');
  const recording = unpackRun(s, GOLDEN).imported[0];
  const parent = s.getCalls(recording);
  const fork = () => {
    const run = s.createRun({ mode: 'replay', parentRunId: recording, command: { argv: ['node', 'agent.js'], cwd: '.' } });
    const fenced = (c: CallRecord) => c.name === 'send_email';
    copyCalls(
      s,
      parent,
      run.runId,
      (c) => (fenced(c) ? 'blocked' : c.callNo >= 28 ? 'live' : 'replayed'),
      (c) => (fenced(c) ? { outcome: 'error', responseRef: null, meta: { error: BLOCKED } } : {}),
    );
    s.setDivergence(run.runId, { type: 'forced', callNo: 28, kind: 'api', name: 'POST /v1/messages', replayedBefore: 27, reason: 'forced live by --diverge-at 28' });
    return run.runId;
  };
  const fenced = fork();
  s.endRun(fenced, 'completed');
  const writes = fork();
  toolCall(s, writes, 31, 'issue_refund', 'write', 'stubbed', 'ok');
  toolCall(s, writes, 32, 'update_ticket', 'write', 'live', 'error');
  toolCall(s, writes, 33, 'post_note', 'write', 'live', 'ok');
  toolCall(s, writes, 34, 'transfer_to_human', 'read', 'live', 'ok');
  toolCall(s, writes, 35, 'set_flag', 'write', 'overridden', 'ok');
  s.endRun(writes, 'completed');
  return { store: s, fenced, writes };
}

const plainText = (frame: string | undefined) => (frame ?? '').replace(/\x1b\[[0-9;]*m/g, '');

/** The frame, colours and all, once its text shows `text`. */
async function drawn(lastFrame: () => string | undefined, text: string): Promise<string> {
  const deadline = Date.now() + 5000;
  while (!plainText(lastFrame()).includes(text) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  expect(plainText(lastFrame())).toContain(text);
  return lastFrame()!;
}

describe('on the screen', () => {
  // Ink colours through chalk, which draws nothing where the tests' output is no terminal.
  const level = chalk.level;
  beforeAll(() => {
    chalk.level = 3;
  });
  afterAll(() => {
    chalk.level = level;
  });

  it('draws lime only for what passed, the primary action and the wordmark, and where you are in ink on the selection ground', async () => {
    const { store, recording, fork } = colourStore();
    const d = THEMES.dark;
    const lime = (frame: string) => painted(frame, d.ok);

    // The runs: the wordmark, and the check that passed. A clean replay in the replayed colour; the selected row on the ground.
    const runs = renderAt(createElement(App, { store, columns: 120, rows: 24 }), 120, 24);
    const list = await drawn(runs.lastFrame, '3 runs');
    expect(lime(list)).toEqual(['shadowlap', '✓ 1/1']);
    expect(painted(list, d.brand, 'ground')).toEqual(['shadowlap']);
    expect(painted(list, d.origin.replayed, 'text')).toEqual(['clean replay']);
    const selected = painted(list, d.selection!, 'ground');
    expect(selected).toHaveLength(1);
    expect(selected[0]).toMatch(/^> .*fork @3/);
    runs.unmount();

    // A run that passed: its about line and verdict tab say so in lime; the selected call and the open tab are on the ground.
    const passed = renderAt(createElement(App, { store, runId: recording, columns: 120, rows: 30 }), 120, 30);
    let frame = await drawn(passed.lastFrame, 'calls');
    expect(lime(frame)).toEqual(['✓ 1 check passed']);
    expect(painted(frame, d.selection!, 'ground')).toEqual([expect.stringMatching(/^> #1 /), 'conversation']);
    passed.stdin.write('v');
    frame = await drawn(passed.lastFrame, 'How this run stands');
    expect(lime(frame)).toEqual(['✓ 1 check passed', '1 check passed', '✓ answers']);
    passed.unmount();

    // A fork: its line, its report and its menu in ink, with nothing in lime but how its parent passed.
    const forked = renderAt(createElement(App, { store, runId: fork, columns: 120, rows: 30 }), 120, 30);
    frame = await drawn(forked.lastFrame, 'Diverged at call 3');
    expect(plainText(frame)).toContain('── forked at #3');
    expect(lime(frame)).toEqual(['parent  1 check passed']);
    expect(painted(frame, d.warn)).toEqual([]);
    forked.stdin.write(':');
    frame = await drawn(forked.lastFrame, 'Fork menu');
    expect(lime(frame)).toEqual([]);
    expect(painted(frame, d.selection!, 'ground')).toEqual([expect.stringMatching(/^> i {2}/)]);
    forked.stdin.write('\u001b');
    await new Promise((r) => setTimeout(r, 50));
    forked.stdin.write('?');
    frame = await drawn(forked.lastFrame, 'Keys');
    expect(lime(frame)).toEqual([]);
    forked.unmount();

    // A pane that runs a command: its one primary action, the key that runs it.
    const job = { kind: 'verify', key: 'V', label: 'Verify a change for the fix', flag: 'verify', hint: 'Checks the change in your working tree.', fix: { id: 'fx-refund', title: 'Ask before refunding' }, args: ['verify', 'fx-refund'], who: null, aside: null, blocked: null, ask: null } as const;
    const pane = renderAt(createElement(FixJobView, { job: { ...job, args: [...job.args] }, width: 100, height: 10, onYes: () => {}, onDecline: () => {}, onCancel: () => {} }), 100, 10);
    expect(lime(await drawn(pane.lastFrame, 'runs it'))).toEqual(['Enter']);
    pane.unmount();

    // The sixteen colours: lime still the wordmark's and passed's alone, replayed a green of its own.
    const ansi = renderAt(createElement(App, { store, theme: 'ansi', columns: 120, rows: 24 }), 120, 24);
    frame = await drawn(ansi.lastFrame, '3 runs');
    expect(painted(frame, THEMES.ansi.ok)).toEqual(['shadowlap', '✓ 1/1']);
    expect(painted(frame, THEMES.ansi.origin.replayed, 'text')).toEqual(['clean replay']);
    ansi.unmount();
    store.close();
  });

  it('says a run stopped short or left running in grey and one recording in the live colour, as the dashboard lists them, and a check that did not apply in grey', async () => {
    const { store, crashed, partly } = statusStore();
    const d = THEMES.dark;
    const runs = renderAt(createElement(App, { store, columns: 140, rows: 24 }), 140, 24);
    let list = await drawn(runs.lastFrame, '6 runs');
    // Nothing failed, so nothing is red: `crashed` is a run cut short, the dashboard's interrupted.
    expect(painted(list, d.err)).toEqual([]);
    const quiet = painted(list, d.faint, 'text');
    for (const word of ['crashed', 'interrupted', '– 0/0']) expect(quiet).toContain(word);
    expect(painted(list, d.origin.live!, 'text')).toEqual(['recording']);
    expect(painted(list, d.ok)).toEqual(['shadowlap', '✓ 1/1']);
    // A mark's message says what it did in ink: lime stays the wordmark's and what passed.
    runs.stdin.write('+');
    list = await drawn(runs.lastFrame, 'is good');
    expect(painted(list, d.ok)).toEqual(['shadowlap', '✓ 1/1']);
    runs.unmount();

    // The run's page says it was interrupted, in grey as every list says it.
    const page = renderAt(createElement(App, { store, runId: crashed, columns: 120, rows: 30 }), 120, 30);
    const frame = await drawn(page.lastFrame, 'the run was interrupted');
    expect(painted(frame, d.faint, 'text')).toContain('· the run was interrupted');
    expect(painted(frame, d.err)).toEqual([]);
    page.unmount();

    // A check that did not apply, in grey beside the one that passed.
    const checks = renderAt(createElement(App, { store, runId: partly, columns: 120, rows: 30 }), 120, 30);
    await drawn(checks.lastFrame, 'calls');
    checks.stdin.write('v');
    const verdict = await drawn(checks.lastFrame, 'How this run stands');
    expect(painted(verdict, d.ok)).toContain('✓ answers');
    expect(painted(verdict, d.faint, 'text')).toContain('– refunds under the limit · not applicable');
    checks.unmount();
    store.close();
  });

  it('draws a write Shadowlap blocked as its fence, never as a failure, and what a fork wrote and changed by what each was', async () => {
    const { store, fenced, writes } = fenceStore();
    const d = THEMES.dark;
    // The call list's row for a call, by its number.
    const row = (frame: string, no: number) => frame.split('\n').find((l) => new RegExp(`^│[> ] #${no} `).test(plainText(l))) ?? '';

    // The blocked write's ERR is the fence's, in the blocked colour, as its origin is: nothing on the screen is red.
    const fence = renderAt(createElement(App, { store, runId: fenced, callNo: 29, columns: 120, rows: 30 }), 120, 30);
    let frame = await drawn(fence.lastFrame, 'send_email');
    expect(plainText(row(frame, 29))).toMatch(/#29 .*send_email +blocked +ERR/);
    expect(painted(row(frame, 29), d.origin.blocked, 'text')).toContain('ERR');
    expect(painted(frame, d.err)).toEqual([]);
    fence.unmount();

    // A fork that wrote more: the write that failed is the one red among its calls.
    const forked = renderAt(createElement(App, { store, runId: writes, callNo: 29, columns: 120, rows: 44 }), 120, 44);
    frame = await drawn(forked.lastFrame, 'update_ticket');
    expect(painted(row(frame, 32), d.err)).toEqual(['ERR']);
    expect(painted(row(frame, 29), d.err)).toEqual([]);

    // Its diff tab: each write it added in the write colour, never amber; the hand-over amber, a look; each write by its fate.
    forked.stdin.write('5');
    await drawn(forked.lastFrame, 'What the fork did differently');
    forked.stdin.write('z');
    frame = await drawn(forked.lastFrame, 'z unzoom');
    expect(painted(frame, d.write, 'text')).toEqual(['issue_refund is called', 'update_ticket is called', 'post_note is called', 'set_flag is called']);
    expect(painted(frame, d.warn, 'text')).toEqual(['it hands over with transfer_to_human']);
    expect(painted(frame, d.origin.stubbed, 'text')).toEqual(['#31 issue_refund {"order":31} · stubbed']);
    expect(painted(frame, d.origin.overridden, 'text')).toEqual(['#35 set_flag {"order":35} · overridden']);
    expect(painted(frame, d.err, 'text')).toEqual(['#32 update_ticket {"order":32} · failed']);
    expect(painted(frame, d.origin.blocked, 'text')).toContainEqual(expect.stringMatching(/^#29 send_email .* · blocked$/));
    // What ran live is in ink, as the dashboard's words for a write's fate; nothing passed, so nothing is lime.
    const live = '#33 post_note {"order":33} · live';
    expect(plainText(frame)).toContain(live);
    for (const c of [d.ok, d.warn, d.err, d.write, d.dim, d.faint, ...Object.values(d.origin)]) expect(painted(frame, c!, 'text')).not.toContain(live);
    expect(painted(frame, d.ok)).toEqual([]);
    forked.unmount();
    store.close();
  });
});
