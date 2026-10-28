import { createContext, useContext } from 'react';
import type { Origin } from '@shadowlap/engine';

/**
 * Colours, as the dashboard draws them (`packages/dashboard/ui/app.css`): ink text, lime for what
 * Shadowlap adds (a replayed call, the fork point, focus, the selected row) and three signal colours.
 *
 * A terminal's background is the user's, so there are three palettes. `dark` is the dashboard's;
 * `light` keeps lime where it sits behind ink (the selected row, the active tab) and darkens it
 * where it is text; `ansi` names the terminal's own sixteen colours, which every theme tunes for its
 * background, for a terminal whose background could not be learned or that has no more colours.
 * Text that is neither secondary nor a signal is left in the terminal's own foreground colour,
 * never set to white or black, which vanish on one background or the other.
 */
export type ThemeName = 'dark' | 'light' | 'ansi';

export interface Theme {
  name: ThemeName;
  /** Lime as text or a border: focus, the fork point, a replayed call, key letters. */
  accent: string;
  /** Lime behind text: the selected row in the focused pane, the active tab, the wordmark. */
  band: string;
  /** Text on `band`. */
  onBand: string;
  /** Secondary text: details, arguments, hints. */
  dim: string;
  /** Tertiary text and the borders of unfocused panes. */
  faint: string;
  /** The selected row in a pane without focus; undefined where only the `>` marks it. */
  selection: string | undefined;
  ok: string;
  warn: string;
  err: string;
  /** By where a call's answer came from; undefined is the terminal's own foreground (live). */
  origin: Record<Origin | 'injected', string | undefined>;
}

export const THEMES: Record<ThemeName, Theme> = {
  dark: {
    name: 'dark',
    accent: '#c4f233',
    band: '#c4f233',
    onBand: '#15140f',
    dim: '#a8a699',
    faint: '#7c7a69',
    selection: '#30331f',
    ok: '#c4f233',
    warn: '#f2c94c',
    err: '#ff6b5e',
    origin: { live: undefined, replayed: '#c4f233', blocked: '#ff6b5e', stubbed: '#f2c94c', overridden: '#b99cff', injected: '#b99cff' },
  },
  light: {
    name: 'light',
    accent: '#4a7010',
    band: '#c4f233',
    onBand: '#15140f',
    dim: '#5c5b4f',
    faint: '#8a8873',
    selection: '#e6eacf',
    ok: '#3f6a0a',
    warn: '#8f6200',
    err: '#c2321f',
    origin: { live: undefined, replayed: '#4a7010', blocked: '#c2321f', stubbed: '#8f6200', overridden: '#6a4fc4', injected: '#6a4fc4' },
  },
  ansi: {
    name: 'ansi',
    accent: 'green',
    band: 'greenBright',
    onBand: 'black',
    dim: 'gray',
    faint: 'gray',
    selection: undefined,
    ok: 'green',
    warn: 'yellow',
    err: 'red',
    origin: { live: undefined, replayed: 'green', blocked: 'red', stubbed: 'yellow', overridden: 'magenta', injected: 'magenta' },
  },
};

export const ThemeContext = createContext<Theme>(THEMES.dark);

export function useTheme(): Theme {
  return useContext(ThemeContext);
}

/**
 * Where a call's answer came from, as it should be shown. The store keeps an injected failure as live
 * — it did not come from the recording — but it did not come from the provider either.
 */
export function displayOrigin(c: { origin: Origin; end: { meta: { injected?: boolean } } | null }): Origin | 'injected' {
  return c.end?.meta.injected ? 'injected' : c.origin;
}

/**
 * Column labels stay ASCII on purpose: glyphs with East-Asian-ambiguous width (◆ ▶ · →) are
 * measured differently by the layout engine and by terminals, which skews aligned rows. A model
 * call is a model call, as the dashboard and the fork menu call it.
 */
export const kindLabel: Record<string, string> = {
  api: 'model',
  tool: 'tool',
  clock: 'clock',
  random: 'rand',
};
