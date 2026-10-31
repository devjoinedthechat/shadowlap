import { render, type Instance } from 'ink';
import { createElement } from 'react';
import type { Store } from '@shadowlap/engine';
import { App, type AppProps } from './app.js';
import { detectTheme } from './terminal-theme.js';

export { App } from './app.js';
export type { AppProps } from './app.js';
export type { OpenDashboard, SpawnCli } from './components/TimelineView.js';
export { actionContext, buildActions, forkMenuTitle } from './components/ActionsView.js';
export type { Action } from './components/ActionsView.js';
export { parseSse, streamView } from './sse.js';
export { conversationLines, blockLines, wrap } from './render.js';
export type { ConversationAt } from './data.js';
export { diffLines, divergenceSummary } from './diff.js';
export { THEMES, type Theme, type ThemeName } from './theme.js';
export { detectTheme, themeFromColorFgBg, themeFromEnv, themeFromOsc11 } from './terminal-theme.js';

/** The terminal the TUI runs in: the process's own, but in tests. */
export interface TuiTerminal {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
}

/** Signals that ask a process to stop: Ctrl-C, a supervisor's or a dashboard's stop, a closed terminal. */
const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

/**
 * Opens the TUI on a store and resolves when the user quits, or a stop signal ends it.
 *
 * It draws on the terminal's alternate screen, as full-screen programs (vim, less, htop) do, rather
 * than end its last frame with a newline: every view fills the terminal, so a frame is as tall as the
 * screen, and Ink writes such a frame with no newline after it. Left on the screen the shell gets
 * back, the last frame would keep the prompt glued to its help bar, and a newline would only scroll
 * the frame up a line. Leaving the alternate screen puts back the screen it started from, the prompt
 * on a line of its own, however it ends: `q`, Ctrl-C, a stop signal, an error it throws for the CLI
 * to print, an error nothing caught (left before its message is printed), or the process ending.
 *
 * A stop signal (SIGINT, SIGTERM, SIGHUP) ends it as `q` does, from the moment it starts: a Ctrl-C
 * the terminal turns into SIGINT while its colours are asked, before the UI takes the keyboard, ends
 * it before it draws. It listens itself because no one else would act: Ink's exit hook acts on a
 * signal only when nothing else listens to it, and the CLI's watcher likewise, so with both there,
 * neither did. The CLI then ends with the signal's status.
 */
export async function launchTui(store: Store, options: Omit<AppProps, 'store'> = {}, terminal: TuiTerminal = process): Promise<void> {
  const { stdin, stdout, stderr } = terminal;
  if (!stdin.isTTY) throw new Error('shadowlap ui needs an interactive terminal (stdin is not a TTY)');
  if ((stdout.columns ?? 80) < 60 || (stdout.rows ?? 24) < 12) {
    throw new Error(`shadowlap ui needs a terminal of at least 60×12 (this one is ${stdout.columns}×${stdout.rows})`);
  }
  let instance: Instance | null = null;
  let stopped = false;
  const stop = () => {
    stopped = true;
    instance?.unmount();
  };
  // The handler of an error nothing caught prints it, then ends the process: the screen goes back first, so the message stays.
  const leave = () => instance?.unmount();
  for (const signal of STOP_SIGNALS) process.on(signal, stop);
  process.on('uncaughtExceptionMonitor', leave);
  try {
    // The palette for the terminal's background, asked before Ink reads the keyboard.
    const theme = options.theme ?? (await detectTheme({ stdin, stdout }));
    // Stopped while it was asked: nothing is drawn, and the keyboard leaves the raw mode a question with no answer leaves it in.
    if (stopped) return keyboardBack(stdin);
    instance = render(createElement(App, { store, ...options, theme }), {
      stdin,
      stdout,
      stderr,
      exitOnCtrlC: true,
      alternateScreen: true,
      // Drawn on any terminal: Ink's own guess draws nothing, and no alternate screen, wherever a CI variable is set.
      interactive: stdout.isTTY === true,
      // What the console prints goes through Ink, above its frame, only where it would land in the frame: on the process's own terminal.
      patchConsole: stdout === process.stdout,
    });
    await instance.waitUntilExit();
  } finally {
    for (const signal of STOP_SIGNALS) process.off(signal, stop);
    process.off('uncaughtExceptionMonitor', leave);
    instance?.unmount();
  }
}

/** The keyboard out of raw mode, as the terminal had it before it was asked anything. */
function keyboardBack(stdin: NodeJS.ReadStream): void {
  try {
    if (stdin.isRaw) stdin.setRawMode(false);
  } catch {
    // A terminal that went away: there is nothing to put back.
  }
}
