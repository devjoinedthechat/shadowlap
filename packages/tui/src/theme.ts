import { createContext, useContext } from 'react';
import type { Origin } from '@shadowlap/engine';
import type { Tone } from './verdict.js';

/**
 * Colours, each with the one meaning the dashboard gives it (packages/dashboard/ui/css/tokens.css):
 * lime for what passed and the primary action, nothing else; amber for what needs a look or is
 * inconclusive; the one red for what failed; grey for what is the same or doesn't apply. Where a
 * call's answer came from has colours of its own. Where you are (the selected row, the open tab, the
 * pane in focus) is drawn in ink, the selected row and the tab on the selection ground, and so is a
 * fork. Only the wordmark keeps the brand's lime behind it.
 *
 * A terminal's background is the user's, so there are three palettes. `dark` is the dashboard's;
 * `light` keeps each meaning, darkened to read at 4.5:1 on white and on its selection ground; `ansi`
 * names the terminal's own sixteen colours, the nearest for each meaning and never one for two, for
 * a terminal whose background could not be learned or that has no more colours. Ink, the text that
 * is neither secondary nor a signal, is left in the terminal's own foreground colour, never set to
 * white or black, which vanish on one background or the other.
 */
export type ThemeName = 'dark' | 'light' | 'ansi';

/** Where a call's answer came from, as the dashboard colours it; live may be the terminal's own foreground. */
export type OriginColours = Record<Exclude<Origin, 'live'> | 'injected', string> & { live: string | undefined };

export interface Theme {
  name: ThemeName;
  /** The wordmark's ground, the brand's lime, and its text on it: the one lime that is the brand's, not a meaning. */
  brand: string;
  onBrand: string;
  /**
   * Where you are: the ground of the selected row and the open tab, both drawn in ink on it. The
   * terminal's background with a little ink mixed in, as the dashboard's --sel is its page's
   * (`themeFor`). Undefined where the `>` and bold alone mark it.
   */
  selection: string | undefined;
  /** Secondary text: details, arguments, hints. */
  dim: string;
  /** Tertiary text, what is the same or doesn't apply (the dashboard's muted), and the borders of panes without focus. */
  faint: string;
  /** Lime: what passed, and the primary action, the key that runs what a pane shows. Nothing else. */
  ok: string;
  /** Amber: what needs a look or is inconclusive; never a fork, a stub or blame. */
  warn: string;
  /** The one red: what failed or changed for real, a failed call, a diff's removed text. */
  err: string;
  origin: OriginColours;
}

export const THEMES: Record<ThemeName, Theme> = {
  dark: {
    name: 'dark',
    brand: '#c4f233',
    onBrand: '#15140f',
    selection: '#1d1e1b',
    dim: '#a8a699',
    faint: '#8e8c79',
    ok: '#c4f233',
    warn: '#f2c94c',
    err: '#ff6b5e',
    // Injected is overridden mixed 80% into the dashboard's page: the 55% its swatch takes is 3.3:1 there, too faint for a word.
    origin: { live: '#e4e3da', replayed: '#86ad12', blocked: '#a8a699', stubbed: '#6fa3c7', overridden: '#b99cff', injected: '#967fce' },
  },
  light: {
    name: 'light',
    brand: '#c4f233',
    onBrand: '#15140f',
    selection: '#ececec',
    dim: '#5c5b4f',
    faint: '#6b6a5a',
    ok: '#235200',
    warn: '#8a5000',
    err: '#c2321f',
    origin: { live: undefined, replayed: '#5f7000', blocked: '#5c5b4f', stubbed: '#2c6591', overridden: '#5a3db5', injected: '#7458c0' },
  },
  ansi: {
    name: 'ansi',
    brand: 'greenBright',
    onBrand: 'black',
    selection: undefined,
    dim: 'gray',
    faint: 'gray',
    ok: 'greenBright',
    warn: 'yellow',
    err: 'red',
    origin: { live: undefined, replayed: 'green', blocked: 'gray', stubbed: 'blueBright', overridden: 'magentaBright', injected: 'magenta' },
  },
};

/** The ink each palette's selection ground mixes in: the dashboard's on a dark background, the logo's dark on a light one. */
const INK: Record<Exclude<ThemeName, 'ansi'>, string> = { dark: '#eeede6', light: '#15140f' };
/** How much ink the selection ground takes, as the dashboard's --sel takes 8% into its page. */
const SELECTION_INK = 0.08;

const channels = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/** `share` of colour `a` mixed into `b`, both `#rrggbb`, in sRGB as CSS's color-mix() mixes them. */
export function mixColours(a: string, b: string, share: number): string {
  const [x, y] = [channels(a), channels(b)];
  return `#${x.map((c, i) => Math.round(c * share + y[i]! * (1 - share)).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * The palette on the background the terminal reported (`#rrggbb`), its selection ground that
 * background with ink mixed in, so it shows on any background as the dashboard's shows on its page.
 * Without one, the palette's own ground; the sixteen colours have none.
 */
export function themeFor(name: ThemeName, background?: string | null): Theme {
  const theme = THEMES[name];
  if (name === 'ansi' || !background || !/^#[0-9a-f]{6}$/i.test(background)) return theme;
  return { ...theme, selection: mixColours(INK[name], background, SELECTION_INK) };
}

/** A verdict's colour by its tone: passed lime, a look amber, failed red, muted grey; anything else in ink. */
export function toneColour(theme: Theme, tone: Tone): string | undefined {
  return tone === 'ok' ? theme.ok : tone === 'warn' ? theme.warn : tone === 'err' ? theme.err : tone === 'muted' ? theme.faint : undefined;
}

/** Where you are, as a Text's style: in ink, bold, on the selection ground. */
export function hereStyle(theme: Theme): { bold: true; backgroundColor?: string } {
  return theme.selection ? { bold: true, backgroundColor: theme.selection } : { bold: true };
}

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
