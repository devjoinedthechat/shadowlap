import { render } from 'ink';
import { createElement } from 'react';
import { parseUnrecordedConfig, readConfigFile, type Store } from '@shadowlap/engine';
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

/** `tools.unrecorded` from the project's shadowlap.config.json, as `shadowlap show` reads it; none when the file has none or can't be read. */
function declaredTools(cwd: string): Record<string, 'read' | 'write'> | null {
  try {
    return parseUnrecordedConfig(readConfigFile(cwd).data.tools);
  } catch {
    return null;
  }
}

/** Opens the TUI on a store and resolves when the user quits. */
export async function launchTui(store: Store, options: Omit<AppProps, 'store'> = {}): Promise<void> {
  if (!process.stdin.isTTY) throw new Error('shadowlap ui needs an interactive terminal (stdin is not a TTY)');
  if ((process.stdout.columns ?? 80) < 60 || (process.stdout.rows ?? 24) < 12) {
    throw new Error(`shadowlap ui needs a terminal of at least 60×12 (this one is ${process.stdout.columns}×${process.stdout.rows})`);
  }
  // The palette for the terminal's background, asked before Ink reads the keyboard.
  const theme = options.theme ?? (await detectTheme());
  const unrecorded = options.unrecorded ?? declaredTools(process.cwd());
  const instance = render(createElement(App, { store, ...options, theme, ...(unrecorded ? { unrecorded } : {}) }), { exitOnCtrlC: true });
  try {
    await instance.waitUntilExit();
  } finally {
    instance.unmount();
  }
}
